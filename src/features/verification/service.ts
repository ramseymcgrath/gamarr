import type { DownloadAttempt } from "@/features/downloads/models";
import type { SabnzbdPort, TorrentClientPort } from "@/features/downloads/port";
import { readDiscIdentity, type DiscIdentity } from "@/features/verification/disc";
import {
  REDUMP_SYSTEMS,
  type DownloadVerification,
  type VerificationResult
} from "@/features/verification/models";
import { mapClientPath, type PathMapping } from "@/features/verification/path-map";
import type {
  DiscFileEntry,
  DiscFilesPort,
  DownloadLocation,
  DownloadLocatorPort,
  RedumpSourcePort,
  VerificationRepository
} from "@/features/verification/ports";
import { normalizeSerial, type RedumpIndex, type RedumpRom } from "@/features/verification/redump";
import { AppError } from "@/lib/errors";

const IMAGE_EXTENSIONS = new Set([".iso", ".bin", ".img"]);
const ARCHIVE_EXTENSIONS = new Set([
  ".7z", ".zip", ".rar", ".chd", ".cso", ".zso", ".gz", ".xz", ".ecm"
]);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
}

interface ImageCheck {
  file: DiscFileEntry;
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
          if (!next) return;
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
          this.dependencies.repository.complete(next.attemptId, result, this.now());
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

    const files = await this.dependencies.files.list(localPath);
    const images = files.filter((file) => IMAGE_EXTENSIONS.has(extensionOf(file.name)));
    if (images.length === 0) {
      const archive = files.find((file) => ARCHIVE_EXTENSIONS.has(extensionOf(file.name)));
      return archive
        ? outcome(
          "Unsupported",
          `Compressed (${extensionOf(archive.name)}); extract it to verify`,
          { fileName: archive.name }
        )
        : outcome("Unknown", "No disc image (.iso/.bin) found in the download");
    }

    const index = await this.dependencies.redump.load(system.datName);
    const checks: ImageCheck[] = [];
    for (const file of images) {
      checks.push(await this.checkImage(file, index));
    }
    return judge(checks, index, system);
  }

  private async checkImage(file: DiscFileEntry, index: RedumpIndex): Promise<ImageCheck> {
    // Size first: no Redump rom has this exact size, so no hash can match and
    // gigabytes of hashing are skipped.
    const sha1 = index.sizes.has(file.size)
      ? await this.dependencies.files.sha1(file.path)
      : null;
    const matches = sha1 === null ? [] : index.bySha1.get(sha1) ?? [];
    let identity: DiscIdentity | null = null;
    try {
      identity = await readDiscIdentity(this.dependencies.files.reader(file.path));
    } catch {
      identity = null;
    }
    return { file, sha1, matches, identity };
  }
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
