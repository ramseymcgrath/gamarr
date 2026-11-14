import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { DownloadAttempt } from "@/features/downloads/models";
import type { SabnzbdPort, TorrentClientPort } from "@/features/downloads/port";
import type {
  DownloadVerification,
  ExportResult,
  VerificationResult
} from "@/features/verification/models";
import { parsePathMap } from "@/features/verification/path-map";
import type {
  ArchivePort,
  DiscFileEntry,
  DiscFilesPort,
  Ps2LibraryPort,
  DownloadLocatorPort,
  VerificationRepository,
  VerificationTarget
} from "@/features/verification/ports";
import { parseRedumpDat, type RedumpIndex } from "@/features/verification/redump";
import {
  ClientDownloadLocator,
  VerificationService
} from "@/features/verification/service";
import { AppError } from "@/lib/errors";

const GH2_SHA1 = "0123456789abcdef0123456789abcdef01234567";
const GH2_SIZE = 4_480_335_872;

const dat = parseRedumpDat(`clrmamepro ( name "Sony - PlayStation 2" )
game (
\tname "Guitar Hero II (USA)"
\tregion "USA"
\tserial "SLUS-21447"
\trom ( name "Guitar Hero II (USA).iso" size ${GH2_SIZE} crc 00000000 md5 00000000000000000000000000000000 sha1 ${GH2_SHA1.toUpperCase()} )
)
game (
\tname "Guitar Hero III - Legends of Rock (USA)"
\tregion "USA"
\tserial "SLUS-21672"
\trom ( name "Guitar Hero III - Legends of Rock (USA).iso" size 4000000000 crc 00000000 md5 00000000000000000000000000000000 sha1 ffffffffffffffffffffffffffffffffffffffff )
)
`);

function attempt(overrides: Partial<DownloadAttempt> = {}): DownloadAttempt {
  return {
    id: "attempt-1",
    libraryEntryId: "library-1",
    submissionKey: "key",
    requestFingerprint: "fp",
    status: "Completed",
    source: "prowlarr-torrent",
    releaseTitle: "Guitar Hero II",
    indexerId: "7",
    indexerNameSnapshot: "Indexer",
    indexerUrlSnapshot: null,
    newznabGuid: null,
    iaFileName: null,
    torrentHash: "hash-1",
    selectedFiles: [],
    filesAppliedAt: null,
    size: GH2_SIZE,
    category: "games",
    sabnzbdConfigRevision: 1,
    marker: "gamarr-attempt-1",
    sabJobId: null,
    progress: 100,
    failureDetail: null,
    sabRequestStartedAt: null,
    createdAt: 1,
    updatedAt: 1,
    completedAt: 2,
    ...overrides
  };
}

class MemoryVerifications implements VerificationRepository {
  readonly rows = new Map<string, DownloadVerification>();
  constructor(private readonly targets: Map<string, VerificationTarget>) {}

  get(id: string) {
    return this.rows.get(id) ?? null;
  }
  list() {
    return [...this.rows.values()];
  }
  requestPending(id: string, timestamp: number) {
    const row: DownloadVerification = {
      attemptId: id,
      status: "Pending",
      fileName: null,
      sha1: null,
      serial: null,
      redumpName: null,
      detail: null,
      requestedAt: timestamp,
      checkedAt: null,
      updatedAt: timestamp,
      exportStatus: this.rows.get(id)?.exportStatus ?? null,
      exportPath: this.rows.get(id)?.exportPath ?? null,
      exportDetail: this.rows.get(id)?.exportDetail ?? null,
      exportedAt: this.rows.get(id)?.exportedAt ?? null
    };
    this.rows.set(id, row);
    return row;
  }
  requestExport(id: string, timestamp: number) {
    const row: DownloadVerification = {
      ...this.rows.get(id)!,
      exportStatus: "Pending",
      exportPath: null,
      exportDetail: null,
      exportedAt: null,
      updatedAt: timestamp
    };
    this.rows.set(id, row);
    return row;
  }
  claimNextExport(timestamp: number) {
    const next = [...this.rows.values()]
      .find((row) => row.exportStatus === "Pending" && row.status === "Verified");
    if (!next) return null;
    const running = { ...next, exportStatus: "Running" as const, updatedAt: timestamp };
    this.rows.set(next.attemptId, running);
    return running;
  }
  completeExport(id: string, result: ExportResult, timestamp: number) {
    const row: DownloadVerification = {
      ...this.rows.get(id)!,
      exportStatus: result.status,
      exportPath: result.path,
      exportDetail: result.detail,
      exportedAt: timestamp,
      updatedAt: timestamp
    };
    this.rows.set(id, row);
    return row;
  }
  claimNextPending(timestamp: number) {
    const next = [...this.rows.values()]
      .filter((row) => row.status === "Pending")
      .sort((a, b) => a.requestedAt - b.requestedAt)[0];
    if (!next) return null;
    const running = { ...next, status: "Running" as const, updatedAt: timestamp };
    this.rows.set(next.attemptId, running);
    return running;
  }
  complete(id: string, result: VerificationResult, timestamp: number) {
    const row = { ...this.rows.get(id)!, ...result, checkedAt: timestamp, updatedAt: timestamp };
    this.rows.set(id, row);
    return row;
  }
  resetRunning(timestamp: number) {
    let changed = 0;
    for (const row of this.rows.values()) {
      if (row.status === "Running") {
        this.rows.set(row.attemptId, { ...row, status: "Pending", updatedAt: timestamp });
        changed += 1;
      }
    }
    return changed;
  }
  target(id: string) {
    return this.targets.get(id) ?? null;
  }
}

interface FakeFile extends DiscFileEntry {
  sha1?: string;
  systemCnf?: string | null;
  /** What `stream` yields (defaults to the minimal ISO). */
  bytes?: Uint8Array;
}

/** Files whose `reader` serves a minimal ISO with the given SYSTEM.CNF. */
function filesPort(files: FakeFile[]): DiscFilesPort & { hashed: string[] } {
  const hashed: string[] = [];
  return {
    hashed,
    list: async () => files,
    sha1: async (path) => {
      hashed.push(path);
      return files.find((file) => file.path === path)?.sha1 ?? "0".repeat(40);
    },
    reader: (path) => {
      const file = files.find((entry) => entry.path === path);
      const image = isoWith(file?.systemCnf ?? null);
      return async (offset, length) => image.slice(offset, offset + length);
    },
    async *stream(path) {
      const file = files.find((entry) => entry.path === path);
      yield file?.bytes ?? isoWith(file?.systemCnf ?? null);
    }
  };
}

function isoWith(systemCnf: string | null): Uint8Array {
  const image = new Uint8Array(24 * 2048);
  if (systemCnf === null) return image;
  const write32 = (offset: number, value: number) => {
    image[offset] = value & 0xff;
    image[offset + 1] = (value >>> 8) & 0xff;
    image[offset + 2] = (value >>> 16) & 0xff;
    image[offset + 3] = (value >>> 24) & 0xff;
  };
  const pvd = 16 * 2048;
  image[pvd] = 1;
  image.set(new TextEncoder().encode("CD001"), pvd + 1);
  write32(pvd + 156 + 2, 20);
  write32(pvd + 156 + 10, 2048);
  const name = new TextEncoder().encode("SYSTEM.CNF;1");
  const record = 20 * 2048;
  image[record] = 33 + name.length + 1;
  write32(record + 2, 22);
  const contents = new TextEncoder().encode(systemCnf);
  write32(record + 10, contents.length);
  image[record + 32] = name.length;
  image.set(name, record + 33);
  image.set(contents, 22 * 2048);
  return image;
}

const ps2Cnf = (serial: string) => `BOOT2 = cdrom0:\\${serial};1\r\n`;

function serviceWith(input: {
  files: DiscFilesPort;
  target?: Partial<VerificationTarget>;
  locator?: DownloadLocatorPort;
  mappings?: string;
  index?: RedumpIndex;
  archives?: ArchivePort;
  ps2Library?: Ps2LibraryPort;
  autoExport?: boolean;
}) {
  const target: VerificationTarget = {
    attempt: attempt(),
    platformId: 8,
    ...input.target
  };
  const repository = new MemoryVerifications(new Map([[target.attempt.id, target]]));
  const load = vi.fn(async () => input.index ?? dat);
  const service = new VerificationService({
    repository,
    locator: input.locator ?? {
      locate: async () => ({ kind: "found", clientPath: "/downloads/Guitar Hero II" })
    },
    files: input.files,
    redump: { load },
    pathMappings: parsePathMap(input.mappings ?? "/downloads=/library"),
    archives: input.archives ?? null,
    ps2Library: input.ps2Library ?? null,
    autoExport: input.autoExport ?? false,
    now: () => 1_000
  });
  return { service, repository, load };
}

const ghFile = (overrides: Partial<FakeFile> = {}): FakeFile => ({
  path: "/library/Guitar Hero II/Guitar Hero II (USA).iso",
  name: "Guitar Hero II (USA).iso",
  size: GH2_SIZE,
  sha1: GH2_SHA1,
  systemCnf: ps2Cnf("SLUS_214.47"),
  ...overrides
});

describe("VerificationService.verify", () => {
  it("verifies an image whose hash is in Redump", async () => {
    const files = filesPort([ghFile()]);
    const { service } = serviceWith({ files });
    await expect(service.verify("attempt-1")).resolves.toEqual({
      status: "Verified",
      fileName: "Guitar Hero II (USA).iso",
      sha1: GH2_SHA1,
      serial: "SLUS-21447",
      redumpName: "Guitar Hero II (USA)",
      detail: "Matches Redump"
    });
  });

  it("flags a known serial whose hash differs as a modified or bad dump", async () => {
    const files = filesPort([ghFile({ sha1: "a".repeat(40) })]);
    const { service } = serviceWith({ files });
    await expect(service.verify("attempt-1")).resolves.toMatchObject({
      status: "Mismatch",
      serial: "SLUS-21447",
      redumpName: "Guitar Hero II (USA)",
      detail: expect.stringContaining("modified, patched or bad dump")
    });
  });

  it("skips hashing when no Redump entry has the file's exact size", async () => {
    const files = filesPort([ghFile({ size: 123, systemCnf: ps2Cnf("SLUS_216.72") })]);
    const { service } = serviceWith({ files });
    const result = await service.verify("attempt-1");
    expect(files.hashed).toEqual([]);
    expect(result).toMatchObject({
      status: "Mismatch",
      redumpName: "Guitar Hero III - Legends of Rock (USA)"
    });
  });

  it("reports a disc for another system as a mismatch", async () => {
    const files = filesPort([ghFile({
      sha1: "b".repeat(40),
      systemCnf: "BOOT = cdrom:\\SCUS_942.27;1\r\n"
    })]);
    const { service } = serviceWith({ files });
    await expect(service.verify("attempt-1")).resolves.toMatchObject({
      status: "Mismatch",
      detail: "This is a PS1 disc, not PS2"
    });
  });

  it("is Unknown, not Mismatch, for a serial Redump doesn't list", async () => {
    const files = filesPort([ghFile({ sha1: "c".repeat(40), systemCnf: ps2Cnf("SLUS_999.99") })]);
    const { service } = serviceWith({ files });
    await expect(service.verify("attempt-1")).resolves.toMatchObject({
      status: "Unknown",
      detail: "SLUS-99999 isn't in the Redump list"
    });
  });

  it("is Unknown for an image that isn't a PlayStation disc", async () => {
    const files = filesPort([ghFile({ sha1: "d".repeat(40), systemCnf: null })]);
    const { service } = serviceWith({ files });
    await expect(service.verify("attempt-1")).resolves.toMatchObject({
      status: "Unknown",
      detail: "Not a recognised PS2 disc image and not in the Redump list"
    });
  });

  it("requires every image of a multi-file download to match", async () => {
    const files = filesPort([
      ghFile(),
      ghFile({ path: "/library/x/extra.bin", name: "extra.bin", sha1: "e".repeat(40), systemCnf: null })
    ]);
    const { service } = serviceWith({ files });
    await expect(service.verify("attempt-1")).resolves.toMatchObject({
      status: "Unknown",
      fileName: "extra.bin"
    });
  });

  it("explains that compressed downloads must be extracted", async () => {
    const files = filesPort([{ path: "/library/x/game.7z", name: "game.7z", size: 10 }]);
    const { service, load } = serviceWith({ files });
    await expect(service.verify("attempt-1")).resolves.toMatchObject({
      status: "Unsupported",
      fileName: "game.7z",
      detail: "Compressed (.7z); extract it to verify"
    });
    expect(load).not.toHaveBeenCalled();
  });

  it("is Unknown when the download holds no disc image", async () => {
    const files = filesPort([{ path: "/library/x/readme.txt", name: "readme.txt", size: 10 }]);
    const { service } = serviceWith({ files });
    await expect(service.verify("attempt-1")).resolves.toMatchObject({
      status: "Unknown",
      detail: "No disc image (.iso/.bin) found in the download"
    });
  });

  it("refuses platforms without a checksum list before touching files", async () => {
    const files = filesPort([ghFile()]);
    const list = vi.spyOn(files, "list");
    const { service } = serviceWith({ files, target: { platformId: 130 } });
    await expect(service.verify("attempt-1")).resolves.toMatchObject({
      status: "Unsupported",
      detail: "No Redump checksum list for this platform yet"
    });
    expect(list).not.toHaveBeenCalled();
  });

  it("refuses a client path outside the configured mapping", async () => {
    const files = filesPort([ghFile()]);
    const { service } = serviceWith({ files, mappings: "" });
    await expect(service.verify("attempt-1")).resolves.toMatchObject({
      status: "Unsupported",
      detail: expect.stringContaining("GAMARR_DOWNLOAD_PATH_MAP")
    });
  });

  it("fails with the locator's reason when the download can't be found", async () => {
    const { service } = serviceWith({
      files: filesPort([]),
      locator: { locate: async () => ({ kind: "missing", detail: "qBittorrent no longer has this torrent" }) }
    });
    await expect(service.verify("attempt-1")).resolves.toMatchObject({
      status: "Failed",
      detail: "qBittorrent no longer has this torrent"
    });
  });
});

describe("VerificationService queue", () => {
  it("drains queued checks one at a time and records results", async () => {
    const files = filesPort([ghFile()]);
    const { service, repository } = serviceWith({ files });
    service.requestForCompleted(["attempt-1"]);
    await service.drain();
    expect(repository.get("attempt-1")).toMatchObject({
      status: "Verified",
      checkedAt: 1_000
    });
  });

  it("shares one drain loop between concurrent callers", async () => {
    const files = filesPort([ghFile()]);
    const { service } = serviceWith({ files });
    service.requestForCompleted(["attempt-1"]);
    expect(service.drain()).toBe(service.drain());
    await service.drain();
  });

  it("records an AppError message as a Failed check", async () => {
    const files = filesPort([ghFile()]);
    files.list = async () => {
      throw new AppError("NOT_FOUND", 404, "The downloaded files are no longer there");
    };
    const { service, repository } = serviceWith({ files });
    service.requestForCompleted(["attempt-1"]);
    await service.drain();
    expect(repository.get("attempt-1")).toMatchObject({
      status: "Failed",
      detail: "The downloaded files are no longer there"
    });
  });

  it("hides unexpected error messages", async () => {
    const files = filesPort([ghFile()]);
    files.list = async () => {
      throw new Error("EACCES /secret/path");
    };
    const { service, repository } = serviceWith({ files });
    service.requestForCompleted(["attempt-1"]);
    await service.drain();
    expect(repository.get("attempt-1")?.detail)
      .toBe("Verification could not read the download");
  });

  it("does not requeue an attempt that already has a result on reconcile", async () => {
    const files = filesPort([ghFile()]);
    const { service, repository } = serviceWith({ files });
    service.requestForCompleted(["attempt-1"]);
    await service.drain();
    service.requestForCompleted(["attempt-1"]);
    await service.drain();
    expect(files.hashed).toHaveLength(1);
    expect(repository.get("attempt-1")?.status).toBe("Verified");
  });

  it("re-runs a finished check on explicit request", async () => {
    const files = filesPort([ghFile()]);
    const { service } = serviceWith({ files });
    service.requestForCompleted(["attempt-1"]);
    await service.drain();
    expect(service.request("attempt-1").status).toBe("Pending");
    await service.drain();
    expect(files.hashed).toHaveLength(2);
  });

  it("only verifies completed downloads", () => {
    const { service } = serviceWith({
      files: filesPort([]),
      target: { attempt: attempt({ status: "Downloading" }) }
    });
    expect(() => service.request("attempt-1"))
      .toThrow("Only completed downloads can be verified");
    expect(() => service.request("missing")).toThrow("Download not found");
  });

  it("requeues checks interrupted by a restart", async () => {
    const files = filesPort([ghFile()]);
    const { service, repository } = serviceWith({ files });
    repository.requestPending("attempt-1", 1);
    repository.claimNextPending(2);
    service.resume();
    await service.drain();
    expect(repository.get("attempt-1")?.status).toBe("Verified");
  });
});

describe("ClientDownloadLocator", () => {
  const torrent = (jobs: Awaited<ReturnType<TorrentClientPort["list"]>>) =>
    ({ list: async () => jobs }) as unknown as TorrentClientPort;
  const sab = (jobs: Awaited<ReturnType<SabnzbdPort["getHistory"]>>) =>
    ({ getHistory: async () => jobs }) as unknown as SabnzbdPort;

  it("finds a torrent's content path by hash", async () => {
    const locator = new ClientDownloadLocator({
      torrent: () => torrent([{
        hash: "hash-1", tags: [], state: "stalledUP", progress: 100,
        contentPath: "/downloads/Guitar Hero II"
      }]),
      sabnzbd: () => null
    });
    await expect(locator.locate(attempt())).resolves.toEqual({
      kind: "found",
      clientPath: "/downloads/Guitar Hero II"
    });
  });

  it("finds a usenet job's completed folder in SABnzbd history", async () => {
    const locator = new ClientDownloadLocator({
      torrent: () => null,
      sabnzbd: () => sab([{
        jobId: "SABnzbd_nzo_1", marker: "gamarr-attempt-1", status: "Completed",
        progress: 100, storage: "/downloads/games/Guitar Hero II"
      }])
    });
    await expect(locator.locate(attempt({
      source: "prowlarr-usenet", torrentHash: null, sabJobId: "SABnzbd_nzo_1"
    }))).resolves.toEqual({
      kind: "found",
      clientPath: "/downloads/games/Guitar Hero II"
    });
  });

  it("explains when the client no longer has the download", async () => {
    const locator = new ClientDownloadLocator({
      torrent: () => torrent([]),
      sabnzbd: () => null
    });
    await expect(locator.locate(attempt())).resolves.toEqual({
      kind: "missing",
      detail: "qBittorrent no longer has this torrent"
    });
  });
});

const sha1Of = (bytes: Uint8Array) => createHash("sha1").update(bytes).digest("hex");

/** A one-game Redump list whose single rom is exactly `bytes`. */
function indexFor(bytes: Uint8Array, romName = "Guitar Hero II (USA).iso"): RedumpIndex {
  return parseRedumpDat(`clrmamepro ( name "Sony - PlayStation 2" )
game (
\tname "Guitar Hero II (USA)"
\tregion "USA"
\tserial "SLUS-21447"
\trom ( name "${romName}" size ${bytes.length} crc 00000000 md5 00000000000000000000000000000000 sha1 ${sha1Of(bytes).toUpperCase()} )
)
`);
}

function archivePort(entries: Record<string, Uint8Array>) {
  const reads: string[] = [];
  const port: ArchivePort = {
    list: async () => Object.entries(entries)
      .map(([path, bytes]) => ({ path, size: bytes.length })),
    async *open(_archive, entry) {
      reads.push(entry);
      const bytes = entries[entry]!;
      // Several chunks, so head capture and early stop are exercised.
      for (let offset = 0; offset < bytes.length; offset += 4096) {
        yield bytes.subarray(offset, offset + 4096);
      }
    }
  };
  return { port, reads };
}

function memoryLibrary(existing: string[] = []) {
  const files = new Map<string, Uint8Array>(existing.map((path) => [path, new Uint8Array()]));
  let discarded = 0;
  const library: Ps2LibraryPort = {
    freeBytes: async () => 100 * 1024 ** 3,
    begin: async () => {
      const chunks: Uint8Array[] = [];
      return {
        write: async (chunk) => { chunks.push(chunk.slice()); },
        commit: async (path) => {
          if (files.has(path)) return "exists";
          files.set(path, Buffer.concat(chunks));
          return "created";
        },
        discard: async () => { discarded += 1; }
      };
    }
  };
  return { library, files, discarded: () => discarded };
}

const rarDownload: FakeFile = {
  path: "/library/Guitar Hero II/gh2.rar",
  name: "gh2.rar",
  size: 1
};

describe("VerificationService archives", () => {
  it("verifies an image inside an archive without extracting it", async () => {
    const image = isoWith(ps2Cnf("SLUS_214.47"));
    const { port, reads } = archivePort({ "Guitar Hero II (USA).iso": image });
    const { service } = serviceWith({
      files: filesPort([rarDownload]),
      archives: port,
      index: indexFor(image)
    });
    await expect(service.verify("attempt-1")).resolves.toMatchObject({
      status: "Verified",
      fileName: "gh2.rar › Guitar Hero II (USA).iso",
      sha1: sha1Of(image),
      serial: "SLUS-21447",
      redumpName: "Guitar Hero II (USA)"
    });
    expect(reads).toEqual(["Guitar Hero II (USA).iso"]);
  });

  it("reads only the head when the size rules out a match, and still names the game", async () => {
    const image = isoWith(ps2Cnf("SLUS_214.47"));
    const rebuilt = new Uint8Array(image.length + 2048);
    rebuilt.set(image);
    const { port } = archivePort({ "gh2-rebuilt.iso": rebuilt });
    const { service } = serviceWith({
      files: filesPort([rarDownload]),
      archives: port,
      index: indexFor(image)
    });
    await expect(service.verify("attempt-1")).resolves.toMatchObject({
      status: "Mismatch",
      sha1: null,
      serial: "SLUS-21447",
      redumpName: "Guitar Hero II (USA)"
    });
  });

  it("says when an archive holds no disc image", async () => {
    const { port } = archivePort({ "readme.nfo": new Uint8Array(10) });
    const { service } = serviceWith({ files: filesPort([rarDownload]), archives: port });
    await expect(service.verify("attempt-1")).resolves.toMatchObject({
      status: "Unknown",
      detail: "No disc image (.iso/.bin) inside the archive"
    });
  });

  it("only opens the first volume of a multi-part RAR", async () => {
    const image = isoWith(ps2Cnf("SLUS_214.47"));
    const { port } = archivePort({ "Guitar Hero II (USA).iso": image });
    const list = vi.spyOn(port, "list");
    const { service } = serviceWith({
      files: filesPort([
        { path: "/library/g/g.part1.rar", name: "g.part1.rar", size: 1 },
        { path: "/library/g/g.part2.rar", name: "g.part2.rar", size: 1 }
      ]),
      archives: port,
      index: indexFor(image)
    });
    await service.verify("attempt-1");
    expect(list.mock.calls).toEqual([["/library/g/g.part1.rar"]]);
  });

  it("leaves archives Unsupported when 7-Zip isn't available", async () => {
    const { service } = serviceWith({ files: filesPort([rarDownload]) });
    await expect(service.verify("attempt-1")).resolves.toMatchObject({
      status: "Unsupported",
      detail: "Compressed (.rar); extract it to verify"
    });
  });
});

describe("VerificationService PS2 library export", () => {
  it("re-hashes while copying and files a DVD image by its Redump name", async () => {
    const image = isoWith(ps2Cnf("SLUS_214.47"));
    const { port } = archivePort({ "gh2.iso": image });
    const { library, files } = memoryLibrary();
    const { service } = serviceWith({
      files: filesPort([rarDownload]),
      archives: port,
      index: indexFor(image),
      ps2Library: library
    });
    await expect(service.exportToPs2("attempt-1")).resolves.toEqual({
      status: "Done",
      path: "DVD/Guitar Hero II (USA).iso",
      detail: "Added to the PS2 library"
    });
    expect(files.get("DVD/Guitar Hero II (USA).iso")).toEqual(Buffer.from(image));
  });

  it("converts a verified raw CD .bin to a 2048-byte .iso in CD/", async () => {
    const iso = isoWith(ps2Cnf("SLUS_214.47"));
    const sectors = iso.length / 2048;
    const raw = new Uint8Array(sectors * 2352);
    for (let sector = 0; sector < sectors; sector += 1) {
      const base = sector * 2352;
      raw.set([0x00, ...Array<number>(10).fill(0xff), 0x00], base);
      raw[base + 15] = 2;
      raw.set(iso.subarray(sector * 2048, sector * 2048 + 2048), base + 24);
    }
    const { library, files } = memoryLibrary();
    const { service } = serviceWith({
      files: filesPort([{
        path: "/library/gh/Guitar Hero II (USA) (Track 1).bin",
        name: "Guitar Hero II (USA) (Track 1).bin",
        size: raw.length,
        bytes: raw
      }, {
        path: "/library/gh/Guitar Hero II (USA) (Track 2).bin",
        name: "Guitar Hero II (USA) (Track 2).bin",
        size: 4,
        bytes: new Uint8Array(4)
      }]),
      index: indexFor(raw, "Guitar Hero II (USA) (Track 1).bin"),
      ps2Library: library
    });
    await expect(service.exportToPs2("attempt-1")).resolves.toMatchObject({
      status: "Done",
      path: "CD/Guitar Hero II (USA).iso"
    });
    expect(files.get("CD/Guitar Hero II (USA).iso")).toEqual(Buffer.from(iso));
    expect(files.size).toBe(1);
  });

  it("discards the copy when the bytes no longer match Redump", async () => {
    const image = isoWith(ps2Cnf("SLUS_214.47"));
    const changed = image.slice();
    changed[100] = 1;
    const { port } = archivePort({ "gh2.iso": changed });
    const { library, files, discarded } = memoryLibrary();
    const { service } = serviceWith({
      files: filesPort([rarDownload]),
      archives: port,
      index: indexFor(image),
      ps2Library: library
    });
    await expect(service.exportToPs2("attempt-1")).resolves.toMatchObject({
      status: "Failed",
      detail: "gh2.rar › gh2.iso no longer matches Redump, so it wasn't copied"
    });
    expect(files.size).toBe(0);
    expect(discarded()).toBe(1);
  });

  it("never replaces a file already in the share", async () => {
    const image = isoWith(ps2Cnf("SLUS_214.47"));
    const { port } = archivePort({ "gh2.iso": image });
    const { library, files } = memoryLibrary(["DVD/Guitar Hero II (USA).iso"]);
    const { service } = serviceWith({
      files: filesPort([rarDownload]),
      archives: port,
      index: indexFor(image),
      ps2Library: library
    });
    await expect(service.exportToPs2("attempt-1")).resolves.toMatchObject({
      status: "Done",
      detail: "Already in the PS2 library"
    });
    expect(files.get("DVD/Guitar Hero II (USA).iso")).toEqual(new Uint8Array());
  });

  it("exports automatically after a PS2 download verifies", async () => {
    const image = isoWith(ps2Cnf("SLUS_214.47"));
    const { port } = archivePort({ "gh2.iso": image });
    const { library, files } = memoryLibrary();
    const { service, repository } = serviceWith({
      files: filesPort([rarDownload]),
      archives: port,
      index: indexFor(image),
      ps2Library: library,
      autoExport: true
    });
    service.request("attempt-1");
    await service.drain();
    expect(repository.get("attempt-1")).toMatchObject({
      status: "Verified",
      exportStatus: "Done",
      exportPath: "DVD/Guitar Hero II (USA).iso"
    });
    expect(files.size).toBe(1);
  });

  it("refuses to export anything that isn't a Verified PS2 download", () => {
    const { library } = memoryLibrary();
    const { service, repository } = serviceWith({
      files: filesPort([]),
      ps2Library: library,
      target: { platformId: 7 }
    });
    expect(() => service.requestExport("attempt-1")).toThrow("hasn't been verified");
    repository.requestPending("attempt-1", 1);
    repository.complete("attempt-1", {
      status: "Verified", fileName: null, sha1: null, serial: null, redumpName: null, detail: null
    }, 2);
    expect(() => service.requestExport("attempt-1")).toThrow("Only PS2 games");
    expect(service.canExport("attempt-1")).toBe(false);
  });
});
