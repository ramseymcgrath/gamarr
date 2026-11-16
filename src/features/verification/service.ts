import type { DownloadAttempt } from "@/features/downloads/models";
import type { SabnzbdPort, TorrentClientPort } from "@/features/downloads/port";
import { createHash } from "node:crypto";
import path from "node:path";

import { collectionFileMatches } from "@/features/downloads/service";

import { readDiscIdentity, type DiscIdentity, type DiscRead } from "@/features/verification/disc";
import {
  REDUMP_SYSTEMS,
  type DownloadVerification,
  type ExportResult,
  type VerificationResult
} from "@/features/verification/models";
import {
  isExtraTrack,
  oplPath,
  rawDataOffset,
  rawToIso
} from "@/features/verification/opl";
import { mapClientPath, type PathMapping } from "@/features/verification/path-map";
import type {
  ArchivePort,
  DiscFilesPort,
  DownloadLocation,
  DownloadLocatorPort,
  ImageSource,
  Ps2LibraryPort,
  RedumpSourcePort,
  VerificationRepository
} from "@/features/verification/ports";
import { normalizeSerial, type RedumpIndex, type RedumpRom } from "@/features/verification/redump";
import { AppError } from "@/lib/errors";

const IMAGE_EXTENSIONS = new Set([".iso", ".bin", ".img"]);
/** Formats 7-Zip can stream an image out of. */
const OPENABLE_ARCHIVES = new Set([".7z", ".zip", ".rar"]);
const ARCHIVE_EXTENSIONS = new Set([
  ...OPENABLE_ARCHIVES, ".chd", ".cso", ".zso", ".gz", ".xz", ".ecm"
]);
/**
 * Bytes kept from the start of a streamed image: enough for the volume
 * descriptor, root directory and `SYSTEM.CNF`, which mastering tools place in
 * the first few hundred sectors.
 */
const HEAD_BYTES = 16 * 1024 * 1024;
/** Headroom kept free on the share beyond the image itself. */
const FREE_SPACE_MARGIN = 1024 * 1024 * 1024;

/** `x.part1.rar`/`x.part01.rar` open a multi-volume set; later parts don't. */
function opensArchive(name: string): boolean {
  if (!OPENABLE_ARCHIVES.has(extensionOf(name))) return false;
  const part = /\.part(\d+)\.rar$/i.exec(name);
  return part === null || Number(part[1]) === 1;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
}

interface ImageCheck {
  file: ImageSource;
  sha1: string | null;
  matches: RedumpRom[];
  identity: DiscIdentity | null;
}

/** Asks the download client where a completed attempt's files live. */
export class ClientDownloadLocator implements DownloadLocatorPort {
  constructor(private readonly clients: {
    torrent: () => TorrentClientPort | null;
    sabnzbd: () => SabnzbdPort | null;
  }) {}

  async locate(attempt: DownloadAttempt): Promise<DownloadLocation> {
    if (
      attempt.source === "prowlarr-torrent"
      || attempt.source === "internet-archive-torrent"
    ) {
      const client = this.clients.torrent();
      if (!client) return { kind: "missing", detail: "qBittorrent is not configured" };
      const torrents = await client.list();
      const torrent = attempt.torrentHash
        ? torrents.find((job) => job.hash === attempt.torrentHash)
        : torrents.find((job) => job.tags.includes(attempt.marker));
      if (!torrent) return { kind: "missing", detail: "qBittorrent no longer has this torrent" };
      if (!torrent.contentPath) return { kind: "missing", detail: "qBittorrent did not report a content path" };
      return { kind: "found", clientPath: torrent.contentPath };
    }
    if (attempt.source === "collection-torrent") {
      const client = this.clients.torrent();
      if (!client) return { kind: "missing", detail: "qBittorrent is not configured" };
      const torrents = await client.list();
      const torrent = torrents.find((job) => job.hash === attempt.torrentHash);
      if (!torrent || !attempt.torrentHash) {
        return { kind: "missing", detail: "qBittorrent no longer has this torrent" };
      }
      if (!torrent.savePath) {
        return { kind: "missing", detail: "qBittorrent did not report a save path" };
      }
      const selected = attempt.selectedFiles?.[0];
      const files = selected
        ? await client.listFiles(attempt.torrentHash).catch(() => [])
        : [];
      const file = files.find((entry) => entry.index === selected?.index);
      if (!selected || !file || !collectionFileMatches(file.name, selected.name)) {
        return { kind: "missing", detail: "qBittorrent no longer has this file" };
      }
      // The listing carries the root folder exactly as qBittorrent stores it.
      return {
        kind: "found",
        clientPath: path.posix.join(torrent.savePath, file.name)
      };
    }
    if (attempt.source === "prowlarr-usenet" || attempt.source === "newznab") {
      const sab = this.clients.sabnzbd();
      if (!sab) return { kind: "missing", detail: "SABnzbd is not configured" };
      const history = await sab.getHistory();
      const job = history.find((entry) =>
        entry.jobId === attempt.sabJobId || entry.marker === attempt.marker);
      if (!job) return { kind: "missing", detail: "SABnzbd history no longer has this job" };
      if (!job.storage) return { kind: "missing", detail: "SABnzbd did not report a completed folder" };
      return { kind: "found", clientPath: job.storage };
    }
    return { kind: "missing", detail: "This download type can't be located" };
  }
}

export interface VerificationServiceDependencies {
  repository: VerificationRepository;
  locator: DownloadLocatorPort;
  files: DiscFilesPort;
  redump: RedumpSourcePort;
  pathMappings: PathMapping[];
  /** 7-Zip; without it, archived downloads stay Unsupported. */
  archives?: ArchivePort | null;
  /** The Open PS2 Loader share; without it, exports are refused. */
  ps2Library?: Ps2LibraryPort | null;
  /** Export every newly Verified PS2 download without waiting for a click. */
  autoExport?: boolean;
  now?: () => number;
  log?: (message: string, error: unknown) => void;
}

/**
 * Checks completed downloads against Redump. Work is queued in the database
 * and drained one attempt at a time in the background: hashing a DVD image is
 * gigabytes of I/O, so it never runs on a request path or in parallel.
 */
export class VerificationService {
  private draining: Promise<void> | null = null;
  private readonly now: () => number;

  constructor(private readonly dependencies: VerificationServiceDependencies) {
    this.now = dependencies.now ?? Date.now;
  }

  /** Queues a check; a running drain picks it up, otherwise one starts. */
  request(attemptId: string): DownloadVerification {
    const target = this.dependencies.repository.target(attemptId);
    if (!target) throw new AppError("NOT_FOUND", 404, "Download not found");
    if (target.attempt.status !== "Completed") {
      throw new AppError("VALIDATION", 400, "Only completed downloads can be verified");
    }
    const current = this.dependencies.repository.get(attemptId);
    if (current?.status === "Pending" || current?.status === "Running") {
      this.drain();
      return current;
    }
    const queued = this.dependencies.repository.requestPending(attemptId, this.now());
    this.drain();
    return queued;
  }

  /** For reconcile: queue newly completed attempts without throwing. */
  requestForCompleted(attemptIds: string[]): void {
    for (const id of attemptIds) {
      try {
        if (this.dependencies.repository.get(id) === null) {
          this.dependencies.repository.requestPending(id, this.now());
        }
      } catch (error) {
        this.dependencies.log?.("Could not queue download verification", error);
      }
    }
    if (attemptIds.length > 0) this.drain();
  }

  /** Startup: recover crashed rows and resume the queue. */
  resume(): void {
    this.dependencies.repository.resetRunning(this.now());
    this.drain();
  }

  /** Single-flight: concurrent callers share one drain loop. */
  drain(): Promise<void> {
    if (this.draining) return this.draining;
    this.draining = (async () => {
      try {
        for (;;) {
          const next = this.dependencies.repository.claimNextPending(this.now());
          if (!next) {
            if (await this.runNextExport()) continue;
            return;
          }
          let result: VerificationResult;
          try {
            result = await this.verify(next.attemptId);
          } catch (error) {
            this.dependencies.log?.("Download verification failed", error);
            result = {
              status: "Failed",
              fileName: null,
              sha1: null,
              serial: null,
              redumpName: null,
              detail: error instanceof AppError
                ? error.message
                : "Verification could not read the download"
            };
          }
          const saved = this.dependencies.repository.complete(next.attemptId, result, this.now());
          if (
            result.status === "Verified"
            && this.dependencies.autoExport
            && this.dependencies.ps2Library
            && saved.exportStatus !== "Done"
            && this.isPs2(next.attemptId)
          ) {
            this.dependencies.repository.requestExport(next.attemptId, this.now());
          }
        }
      } finally {
        this.draining = null;
      }
    })();
    return this.draining;
  }

  async verify(attemptId: string): Promise<VerificationResult> {
    const target = this.dependencies.repository.target(attemptId);
    if (!target) return outcome("Failed", "Download no longer exists");
    const system = REDUMP_SYSTEMS.get(target.platformId);
    if (!system) {
      return outcome("Unsupported", "No Redump checksum list for this platform yet");
    }

    const location = await this.dependencies.locator.locate(target.attempt);
    if (location.kind === "missing") return outcome("Failed", location.detail);
    const localPath = mapClientPath(location.clientPath, this.dependencies.pathMappings);
    if (!localPath) {
      return outcome(
        "Unsupported",
        "The download folder isn't visible to gamarr (check GAMARR_DOWNLOAD_PATH_MAP)"
      );
    }

    const found = await this.findImages(localPath);
    if ("result" in found) return found.result;

    const index = await this.dependencies.redump.load(system.datName);
    const checks: ImageCheck[] = [];
    for (const image of found.images) {
      checks.push(await this.checkImage(image, index));
    }
    return judge(checks, index, system);
  }

  /**
   * Disc images in a download: plain files first; failing that, images
   * inside `.7z`/`.zip`/`.rar` archives, which are read without extracting.
   */
  private async findImages(
    localPath: string
  ): Promise<{ images: ImageSource[] } | { result: VerificationResult }> {
    const files = await this.dependencies.files.list(localPath);
    const images: ImageSource[] = files
      .filter((file) => IMAGE_EXTENSIONS.has(extensionOf(file.name)))
      .map((file) => ({ kind: "file", ...file }));
    if (images.length > 0) return { images };

    const archives = files.filter((file) => opensArchive(file.name));
    const archivePort = this.dependencies.archives;
    if (archives.length > 0 && archivePort) {
      const inside: ImageSource[] = [];
      for (const archive of archives) {
        const entries = await archivePort.list(archive.path);
        for (const entry of entries) {
          if (!IMAGE_EXTENSIONS.has(extensionOf(entry.path))) continue;
          inside.push({
            kind: "archive",
            archivePath: archive.path,
            entry: entry.path,
            name: `${archive.name} › ${entry.path}`,
            size: entry.size
          });
        }
      }
      if (inside.length > 0) return { images: inside };
      return {
        result: outcome("Unknown", "No disc image (.iso/.bin) inside the archive", {
          fileName: archives.map((archive) => archive.name).join(", ")
        })
      };
    }

    const archive = files.find((file) => ARCHIVE_EXTENSIONS.has(extensionOf(file.name)));
    return {
      result: archive
        ? outcome(
          "Unsupported",
          `Compressed (${extensionOf(archive.name)}); extract it to verify`,
          { fileName: archive.name }
        )
        : outcome("Unknown", "No disc image (.iso/.bin) found in the download")
    };
  }

  private open(image: ImageSource): AsyncIterable<Uint8Array> {
    if (image.kind === "file") return this.dependencies.files.stream(image.path);
    const archives = this.dependencies.archives;
    if (!archives) throw new AppError("UNAVAILABLE", 502, "7-Zip isn't available");
    return archives.open(image.archivePath, image.entry);
  }

  private async checkImage(image: ImageSource, index: RedumpIndex): Promise<ImageCheck> {
    // Size first: no Redump rom has this exact size, so no hash can match and
    // gigabytes of hashing (or decompressing) are skipped.
    const hashable = index.sizes.has(image.size);
    if (image.kind === "file") {
      const sha1 = hashable ? await this.dependencies.files.sha1(image.path) : null;
      const matches = sha1 === null ? [] : index.bySha1.get(sha1) ?? [];
      return {
        file: image,
        sha1,
        matches,
        identity: await identityOf(this.dependencies.files.reader(image.path))
      };
    }
    // Inside an archive there is no random access: one streamed pass hashes
    // the image and keeps its first sectors for SYSTEM.CNF. When the size
    // already rules out a match, only the head is read.
    const scan = await scanStream(this.open(image), { hash: hashable });
    const matches = scan.sha1 === null ? [] : index.bySha1.get(scan.sha1) ?? [];
    return {
      file: image,
      sha1: scan.sha1,
      matches,
      identity: await identityOf(headReader(scan.head))
    };
  }

  /** Whether this download may be offered "Add to PS2 library". */
  canExport(attemptId: string): boolean {
    return Boolean(this.dependencies.ps2Library) && this.isPs2(attemptId);
  }

  private isPs2(attemptId: string): boolean {
    const target = this.dependencies.repository.target(attemptId);
    return target !== null && REDUMP_SYSTEMS.get(target.platformId)?.disc === "ps2";
  }

  /** Queues a copy of a Verified PS2 download into the OPL share. */
  requestExport(attemptId: string): DownloadVerification {
    if (!this.dependencies.ps2Library) {
      throw new AppError("VALIDATION", 400, "No PS2 library folder is configured (GAMARR_PS2_LIBRARY_DIR)");
    }
    const current = this.dependencies.repository.get(attemptId);
    if (!current) throw new AppError("NOT_FOUND", 404, "Download hasn't been verified");
    if (current.status !== "Verified") {
      throw new AppError("VALIDATION", 400, "Only downloads that match Redump can be added");
    }
    if (!this.isPs2(attemptId)) {
      throw new AppError("VALIDATION", 400, "Only PS2 games go in the PS2 library");
    }
    if (current.exportStatus === "Pending" || current.exportStatus === "Running") {
      this.drain();
      return current;
    }
    const queued = this.dependencies.repository.requestExport(attemptId, this.now());
    this.drain();
    return queued;
  }

  /** One queued export, if any. `false` when the export queue is empty. */
  private async runNextExport(): Promise<boolean> {
    const next = this.dependencies.repository.claimNextExport(this.now());
    if (!next) return false;
    let result: ExportResult;
    try {
      result = await this.exportToPs2(next.attemptId);
    } catch (error) {
      this.dependencies.log?.("PS2 library export failed", error);
      result = {
        status: "Failed",
        path: null,
        detail: error instanceof AppError
          ? error.message
          : "Couldn't copy the game into the PS2 library"
      };
    }
    this.dependencies.repository.completeExport(next.attemptId, result, this.now());
    return true;
  }

  /**
   * Streams each image into the share while hashing it again, and keeps the
   * file only if the bytes still match Redump: what lands in `DVD/` or `CD/`
   * is exactly what was verified, even if the download changed since.
   */
  async exportToPs2(attemptId: string): Promise<ExportResult> {
    const library = this.dependencies.ps2Library;
    if (!library) return failed("No PS2 library folder is configured");
    const target = this.dependencies.repository.target(attemptId);
    if (!target) return failed("Download no longer exists");
    const system = REDUMP_SYSTEMS.get(target.platformId);
    if (system?.disc !== "ps2") return failed("Only PS2 games go in the PS2 library");

    const location = await this.dependencies.locator.locate(target.attempt);
    if (location.kind === "missing") return failed(location.detail);
    const localPath = mapClientPath(location.clientPath, this.dependencies.pathMappings);
    if (!localPath) return failed("The download folder isn't visible to gamarr");
    const found = await this.findImages(localPath);
    if ("result" in found) return failed(found.result.detail ?? "No disc image found");

    const index = await this.dependencies.redump.load(system.datName);
    const written: string[] = [];
    let existing = 0;
    for (const image of found.images) {
      if (isExtraTrack(image.name)) continue;
      if (await library.freeBytes() < image.size + FREE_SPACE_MARGIN) {
        return failed("Not enough free space in the PS2 library", written);
      }
      const write = await library.begin();
      let sha1: string;
      try {
        sha1 = await copyAsIso(this.open(image), write);
      } catch (error) {
        await write.discard();
        throw error;
      }
      const rom = index.bySha1.get(sha1)?.[0];
      if (!rom) {
        await write.discard();
        return failed(`${image.name} no longer matches Redump, so it wasn't copied`, written);
      }
      const relative = oplPath(rom);
      const outcome = await write.commit(relative);
      if (outcome === "exists") existing += 1;
      written.push(relative);
    }
    if (written.length === 0) return failed("No exportable disc image in the download");
    return {
      status: "Done",
      path: written.join("\n"),
      detail: existing === written.length
        ? "Already in the PS2 library"
        : `Added to the PS2 library${existing > 0 ? " (some were already there)" : ""}`
    };
  }
}

function failed(detail: string, written: string[] = []): ExportResult {
  return {
    status: "Failed",
    path: written.length > 0 ? written.join("\n") : null,
    detail
  };
}

async function identityOf(read: DiscRead): Promise<DiscIdentity | null> {
  try {
    return await readDiscIdentity(read);
  } catch {
    return null;
  }
}

function headReader(head: Uint8Array): DiscRead {
  return async (offset, length) => head.subarray(offset, offset + length);
}

/**
 * One pass over a stream: SHA-1 of every byte (when `hash`) and a copy of the
 * first `HEAD_BYTES`. Without `hash` it stops once the head is full.
 */
export async function scanStream(
  chunks: AsyncIterable<Uint8Array>,
  options: { hash: boolean }
): Promise<{ sha1: string | null; head: Uint8Array }> {
  const hash = options.hash ? createHash("sha1") : null;
  const head = new Uint8Array(HEAD_BYTES);
  let filled = 0;
  for await (const chunk of chunks) {
    hash?.update(chunk);
    if (filled < HEAD_BYTES) {
      const take = Math.min(chunk.length, HEAD_BYTES - filled);
      head.set(chunk.subarray(0, take), filled);
      filled += take;
    }
    if (!hash && filled >= HEAD_BYTES) break;
  }
  return { sha1: hash ? hash.digest("hex") : null, head: head.subarray(0, filled) };
}

/**
 * Copies an image into `write` as a 2048-byte-sector `.iso` (raw `.bin` CD
 * sectors are unwrapped) and returns the SHA-1 of the source bytes, which is
 * what Redump lists.
 */
export async function copyAsIso(
  chunks: AsyncIterable<Uint8Array>,
  write: { write(chunk: Uint8Array): Promise<void> }
): Promise<string> {
  const hash = createHash("sha1");
  async function* hashed(): AsyncGenerator<Uint8Array> {
    for await (const chunk of chunks) {
      hash.update(chunk);
      yield chunk;
    }
  }
  const source = hashed();
  // The first chunk decides the sector layout.
  const first = await source.next();
  if (first.done) throw new AppError("UNAVAILABLE", 502, "The disc image is empty");
  const offset = rawDataOffset(first.value);
  async function* rest(): AsyncGenerator<Uint8Array> {
    yield first.value as Uint8Array;
    for await (const chunk of source) yield chunk;
  }
  const output = offset === null ? rest() : rawToIso(rest(), offset);
  for await (const chunk of output) await write.write(chunk);
  return hash.digest("hex");
}

function outcome(
  status: VerificationResult["status"],
  detail: string,
  extra: Partial<VerificationResult> = {}
): VerificationResult {
  return {
    status,
    fileName: null,
    sha1: null,
    serial: null,
    redumpName: null,
    detail,
    ...extra
  };
}

function unique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

/**
 * Verified only when every image matches; otherwise the first unmatched image
 * decides between Mismatch (positively wrong) and Unknown (not vouched for).
 */
export function judge(
  checks: ImageCheck[],
  index: RedumpIndex,
  system: { disc: "ps2" | "ps1"; label: string }
): VerificationResult {
  const fileName = checks.map((check) => check.file.name).join(", ");
  const unmatched = checks.find((check) => check.matches.length === 0);

  if (!unmatched) {
    const roms = checks.map((check) => check.matches[0]!);
    return {
      status: "Verified",
      fileName,
      sha1: checks.length === 1 ? checks[0]!.sha1 : null,
      serial: unique(roms.map((rom) => rom.serials[0]))[0] ?? null,
      redumpName: unique(roms.map((rom) => rom.gameName)).join(" / "),
      detail: checks.length === 1
        ? "Matches Redump"
        : `All ${checks.length} files match Redump`
    };
  }

  const identity = unmatched.identity;
  const base = {
    fileName: unmatched.file.name,
    sha1: unmatched.sha1,
    serial: identity?.serial ?? null
  };
  if (identity && identity.system !== system.disc) {
    return {
      ...base,
      status: "Mismatch",
      redumpName: null,
      detail: `This is a ${identity.system.toUpperCase()} disc, not ${system.label}`
    };
  }
  const known = identity?.serial
    ? index.bySerial.get(normalizeSerial(identity.serial))?.[0] ?? null
    : null;
  if (known) {
    return {
      ...base,
      status: "Mismatch",
      redumpName: known.gameName,
      detail: `Doesn't match Redump's dump of ${known.gameName}: modified, patched or bad dump`
    };
  }
  return {
    ...base,
    status: "Unknown",
    redumpName: null,
    detail: identity?.serial
      ? `${identity.serial} isn't in the Redump list`
      : identity
        ? "Not in the Redump list"
        : `Not a recognised ${system.label} disc image and not in the Redump list`
  };
}
