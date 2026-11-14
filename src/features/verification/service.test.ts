import { describe, expect, it, vi } from "vitest";

import type { DownloadAttempt } from "@/features/downloads/models";
import type { SabnzbdPort, TorrentClientPort } from "@/features/downloads/port";
import type {
  DownloadVerification,
  VerificationResult
} from "@/features/verification/models";
import { parsePathMap } from "@/features/verification/path-map";
import type {
  DiscFileEntry,
  DiscFilesPort,
  DownloadLocatorPort,
  VerificationRepository,
  VerificationTarget
} from "@/features/verification/ports";
import { parseRedumpDat } from "@/features/verification/redump";
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
}) {
  const target: VerificationTarget = {
    attempt: attempt(),
    platformId: 8,
    ...input.target
  };
  const repository = new MemoryVerifications(new Map([[target.attempt.id, target]]));
  const load = vi.fn(async () => dat);
  const service = new VerificationService({
    repository,
    locator: input.locator ?? {
      locate: async () => ({ kind: "found", clientPath: "/downloads/Guitar Hero II" })
    },
    files: input.files,
    redump: { load },
    pathMappings: parsePathMap(input.mappings ?? "/downloads=/library"),
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
