import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  isTerminalDownloadStatus,
  type DownloadAttempt,
  type NzbUpload,
  type SubmissionClaimInput,
  type SubmitDownloadInput
} from "@/features/downloads/models";
import {
  SabnzbdUploadError,
  TorrentAddError,
  type SabnzbdPort,
  type TorrentClientPort,
  type TorrentJob
} from "@/features/downloads/port";
import type { DownloadRepository } from "@/features/downloads/repository";
import { DownloadService, fingerprintParts } from "@/features/downloads/service";
import type {
  CandidateRepository,
  ReleaseCandidateRecord
} from "@/features/release-search/ports";
import type { SettingsRepository } from "@/features/settings/service";
import { AppError } from "@/lib/errors";

class MemoryDownloads implements DownloadRepository {
  readonly attempts = new Map<string, DownloadAttempt>();

  constructor(private readonly claimEvents?: string[]) {}

  findBySubmissionKey(key: string): DownloadAttempt | null {
    return [...this.attempts.values()].find((attempt) =>
      attempt.submissionKey === key) ?? null;
  }

  claimSubmission(input: SubmissionClaimInput) {
    this.claimEvents?.push("claim-start");
    const existing = this.findBySubmissionKey(input.attempt.submissionKey);
    if (existing) {
      this.claimEvents?.push("claim-end");
      return { attempt: existing, created: false };
    }
    this.attempts.set(input.attempt.id, input.attempt);
    this.claimEvents?.push("claim-end");
    return { attempt: input.attempt, created: true };
  }

  update(id: string, patch: Partial<DownloadAttempt>): DownloadAttempt {
    const current = this.attempts.get(id);
    if (!current) throw new Error("Download attempt does not exist");
    if (isTerminalDownloadStatus(current.status)) return current;
    const updated = { ...current, ...patch };
    this.attempts.set(id, updated);
    return updated;
  }

  get(id: string): DownloadAttempt | null {
    return this.attempts.get(id) ?? null;
  }

  list(): DownloadAttempt[] {
    return [...this.attempts.values()];
  }

  listByTorrentHash(hash: string): DownloadAttempt[] {
    return this.list().filter((attempt) => attempt.torrentHash === hash);
  }

  recoverStaleSubmitting(before: number, updatedAt: number): void {
    for (const attempt of this.attempts.values()) {
      if (
        attempt.status === "Submitting"
        && (attempt.sabRequestStartedAt ?? 0) < before
      ) {
        this.update(attempt.id, { status: "Unknown", updatedAt });
      }
    }
  }

  recoverStaleInternetArchiveDownloads(updatedAt: number): void {
    for (const attempt of this.attempts.values()) {
      if (
        attempt.source === "internet-archive"
        && !isTerminalDownloadStatus(attempt.status)
      ) {
        this.update(attempt.id, {
          status: "Failed",
          failureDetail: "The direct download path was removed",
          updatedAt
        });
      }
    }
  }
}

const torrentBytes = new TextEncoder().encode(
  "d4:infod5:filesld6:lengthi10e4:pathl5:a.xciee"
  + "d6:lengthi20e4:pathl3:sub5:b.xcieee"
  + "4:name10:Collectionee"
);
const magnet =
  "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567";

function candidate(
  protocol: "usenet" | "torrent",
  overrides: Partial<ReleaseCandidateRecord> = {}
): ReleaseCandidateRecord {
  return {
    id: `candidate-${protocol}`,
    expiresAt: 99_999,
    protocol,
    indexerId: protocol === "usenet" ? "3" : "7",
    indexerConfigRevision: 4,
    guid: `${protocol}-guid`,
    title: protocol === "usenet" ? "Game.NZB" : "Game.Torrent",
    size: 1234,
    seeders: protocol === "torrent" ? 42 : null,
    downloadPath: `/api/v1/indexer/${protocol === "usenet" ? "3" : "7"}/download`,
    category: "4050",
    sourceSnapshot: JSON.stringify({
      indexerName: protocol === "usenet" ? "NZBgeek" : "1337x",
      origin: "http://prowlarr.test",
      magnetUrl: null
    }),
    createdAt: 1,
    ...overrides
  };
}

const usenetCandidate = candidate("usenet");
const torrentCandidate = candidate("torrent");
const magnetCandidate = candidate("torrent", {
  id: "candidate-magnet",
  sourceSnapshot: JSON.stringify({
    indexerName: "Magnet Tracker",
    origin: "http://prowlarr.test",
    magnetUrl: magnet
  })
});

const archiveCandidate = candidate("torrent", {
  id: "candidate-archive",
  indexerId: "internet-archive",
  guid: "https://archive.org/details/game-item",
  seeders: null,
  downloadPath: "/download/game-item/game-item_archive.torrent",
  category: null,
  sourceSnapshot: JSON.stringify({
    indexerName: "Internet Archive",
    origin: "https://archive.org",
    identifier: "game-item",
    magnetUrl: null
  })
});

const collectionHash = "c0ffee0123456789abcdef0123456789abcdef01";
const collectionCandidate = candidate("torrent", {
  id: "candidate-collection",
  indexerId: `collection:${collectionHash}`,
  guid: `collection:${collectionHash}:1`,
  title: "b",
  seeders: null,
  downloadPath: `/collection/${collectionHash}/1`,
  category: null,
  sourceSnapshot: JSON.stringify({
    indexerName: "My Collection",
    collectionId: collectionHash,
    torrentFileName: "collection.torrent",
    fileIndex: 1,
    fileName: "b.7z",
    origin: null,
    magnetUrl: null
  })
});

const candidateRecords = new Map([
  [collectionCandidate.id, collectionCandidate],
  [archiveCandidate.id, archiveCandidate],
  [usenetCandidate.id, usenetCandidate],
  [torrentCandidate.id, torrentCandidate],
  [magnetCandidate.id, magnetCandidate]
]);

const candidates: CandidateRepository = {
  save: () => undefined,
  get: (id) => candidateRecords.get(id) ?? null
};

function submission(
  overrides: Partial<SubmitDownloadInput> = {}
): SubmitDownloadInput {
  return {
    submissionKey: "submission-key",
    candidateId: "candidate-torrent",
    gameId: 1,
    platformId: 130,
    ...overrides
  };
}

function fingerprint(parts: Array<string | number>): string {
  return createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex");
}

function storedAttempt(
  overrides: Partial<DownloadAttempt> = {}
): DownloadAttempt {
  return {
    id: "stored-attempt",
    libraryEntryId: "library-1-130",
    submissionKey: "stored-key",
    requestFingerprint: "fingerprint",
    status: "Queued",
    source: "prowlarr-usenet",
    releaseTitle: "Game",
    indexerId: "3",
    indexerNameSnapshot: "NZBgeek",
    indexerUrlSnapshot: "http://prowlarr.test",
    newznabGuid: "guid",
    iaFileName: null,
    torrentHash: null,
    selectedFiles: null,
    filesAppliedAt: null,
    size: 1234,
    category: "games",
    sabnzbdConfigRevision: 2,
    marker: "gamarr-stored-attempt",
    sabJobId: "job-1",
    progress: 0,
    failureDetail: null,
    sabRequestStartedAt: 1,
    createdAt: 1,
    updatedAt: 2,
    completedAt: null,
    ...overrides
  };
}

interface BuildOptions {
  repository?: MemoryDownloads;
  fetched?:
    | { kind: "nzb"; bytes: Uint8Array }
    | { kind: "torrent"; bytes: Uint8Array }
    | { kind: "magnet"; uri: string };
  fetchError?: unknown;
  addError?: unknown;
  torrentHash?: string | null;
  torrentConfigured?: boolean;
  sabConfigured?: boolean;
  uploadError?: unknown;
  events?: string[];
  torrents?: TorrentJob[];
  fileLists?: Array<Array<{ index: number; name: string }>>;
  now?: () => number;
  onCompleted?: (attemptIds: string[]) => void;
  client?: TorrentClientPort;
  sleep?: (ms: number) => Promise<void>;
}

function build(options: BuildOptions = {}) {
  const repository = options.repository ?? new MemoryDownloads(options.events);
  const settings: SettingsRepository = {
    getIgdb: () => null,
    saveIgdb: () => undefined,
    getSabnzbd: () => options.sabConfigured === false ? null : ({
      baseUrl: "http://sab.test",
      apiKey: "sab-key",
      defaultCategory: "games",
      maxNzbBytes: 1_048_576,
      lastTestStatus: null,
      lastTestedAt: null,
      configRevision: 2,
      updatedAt: 1
    }),
    saveSabnzbd: () => undefined,
    getQbittorrent: () => options.torrentConfigured === false ? null : ({
      baseUrl: "http://qbit.test",
      username: "gamarr",
      password: "qbit-password",
      defaultCategory: "games",
      lastTestStatus: null,
      lastTestedAt: null,
      configRevision: 3,
      updatedAt: 1
    }),
    saveQbittorrent: () => undefined,
    recordQbittorrentTest: () => undefined,
    getProwlarr: () => ({
      baseUrl: "http://prowlarr.test",
      apiKey: "prowlarr-secret-key",
      timeoutMs: 10_000,
      lastTestStatus: null,
      lastTestedAt: null,
      configRevision: 4,
      updatedAt: 1
    }),
    saveProwlarr: () => undefined
  };
  const fetch = vi.fn(async (input: {
    candidate: ReleaseCandidateRecord;
    magnetUrl: string | null;
    maxBytes: number;
  }) => {
    options.events?.push("fetch");
    if (options.fetchError !== undefined) throw options.fetchError;
    if (options.fetched) return options.fetched;
    if (input.candidate.id === magnetCandidate.id) {
      return { kind: "magnet" as const, uri: magnet };
    }
    return input.candidate.protocol === "usenet"
      ? { kind: "nzb" as const, bytes: new Uint8Array([1, 2, 3]) }
      : { kind: "torrent" as const, bytes: torrentBytes };
  });
  const add = vi.fn(async () => {
    if (options.addError !== undefined) throw options.addError;
    return {
      hash: options.torrentHash === undefined ? "torrent-hash" : options.torrentHash
    };
  });
  const fileLists = [...(options.fileLists ?? [[]])];
  const listFiles = vi.fn(async () =>
    (fileLists.shift() ?? []).map((file) => ({
      progress: 0,
      priority: 1,
      ...file
    }))
  );
  const setFilePriorities = vi.fn(async () => undefined);
  const torrentClient: TorrentClientPort = {
    add,
    listFiles,
    setFilePriorities,
    addTags: async () => undefined,
    start: async () => undefined,
    list: async () => options.torrents ?? [],
    testConnection: async () => undefined
  };
  const upload = vi.fn(async (uploadInput: NzbUpload) => {
    void uploadInput;
    if (options.uploadError !== undefined) throw options.uploadError;
    return { jobId: "sab-job" };
  });
  const sab: SabnzbdPort = {
    upload,
    getQueue: async () => [],
    getHistory: async () => [],
    testConnection: async () => undefined
  };
  const service = new DownloadService({
    repository,
    candidates,
    settings,
    releaseFetcher: { fetch },
    sabFactory: () => sab,
    torrentClient: () => options.torrentConfigured === false
      ? null
      : options.client ?? torrentClient,
    sleep: options.sleep ?? (async () => undefined),
    maxTorrentBytes: 8 * 1024 * 1024,
    id: () => "attempt-1",
    now: options.now ?? (() => 1_000),
    onCompleted: options.onCompleted
  });
  return {
    service,
    repository,
    fetch,
    add,
    upload,
    listFiles,
    setFilePriorities
  };
}

describe("DownloadService Internet Archive submission", () => {
  it("records an archive torrent grab under the internet-archive-torrent source", async () => {
    const { service, fetch, add } = build();

    const attempt = await service.submit(submission({
      candidateId: "candidate-archive"
    }));

    expect(attempt).toMatchObject({
      status: "Queued",
      source: "internet-archive-torrent",
      indexerId: "internet-archive",
      indexerNameSnapshot: "Internet Archive",
      indexerUrlSnapshot: "https://archive.org",
      selectedFiles: []
    });
    expect(fetch).toHaveBeenCalledWith({
      candidate: archiveCandidate,
      magnetUrl: null,
      maxBytes: 8 * 1024 * 1024
    });
    expect(add).toHaveBeenCalledWith(expect.objectContaining({
      payload: {
        torrent: torrentBytes,
        filename: "gamarr-attempt-1.torrent"
      }
    }));
  });

  it("keeps the legacy fingerprint when no files are selected", async () => {
    const { service } = build();
    const attempt = await service.submit(submission({
      candidateId: "candidate-archive"
    }));
    expect(attempt.requestFingerprint).toBe(
      fingerprint(["candidate-archive", 1, 130, "torrent"])
    );
  });

  it("includes selected file indices in the fingerprint and selection", async () => {
    const { service } = build();
    const attempt = await service.submit(submission({
      candidateId: "candidate-archive",
      selectedFiles: [1]
    }));
    expect(attempt.requestFingerprint).toBe(
      fingerprint(["candidate-archive", 1, 130, "torrent", 1])
    );
    expect(attempt.selectedFiles).toEqual([{ index: 1, name: "Collection/sub/b.xci" }]);
  });
});

describe("DownloadService submission by protocol", () => {
  it("submits a torrent release to qBittorrent", async () => {
    const { service, add, upload } = build();

    const attempt = await service.submit(submission());

    expect(attempt).toMatchObject({
      status: "Queued",
      source: "prowlarr-torrent",
      torrentHash: "torrent-hash",
      marker: "gamarr-attempt-1",
      selectedFiles: []
    });
    expect(add).toHaveBeenCalledWith({
      payload: {
        torrent: torrentBytes,
        filename: "gamarr-attempt-1.torrent"
      },
      category: "games",
      tag: "gamarr-attempt-1"
    });
    expect(upload).not.toHaveBeenCalled();
  });

  it("submits a magnet release to qBittorrent", async () => {
    const { service, fetch, add } = build();

    const attempt = await service.submit(submission({
      candidateId: "candidate-magnet"
    }));

    expect(attempt).toMatchObject({
      status: "Queued",
      source: "prowlarr-torrent",
      selectedFiles: []
    });
    expect(fetch).toHaveBeenCalledWith({
      candidate: magnetCandidate,
      magnetUrl: magnet,
      maxBytes: 8 * 1024 * 1024
    });
    expect(add).toHaveBeenCalledWith({
      payload: { magnet },
      category: "games",
      tag: "gamarr-attempt-1"
    });
  });

  it("submits a usenet release to SABnzbd", async () => {
    const { service, fetch, add, upload } = build();

    const attempt = await service.submit(submission({
      candidateId: "candidate-usenet"
    }));

    expect(attempt).toMatchObject({
      status: "Queued",
      source: "prowlarr-usenet",
      sabJobId: "sab-job",
      selectedFiles: null
    });
    expect(fetch).toHaveBeenCalledWith({
      candidate: usenetCandidate,
      magnetUrl: null,
      maxBytes: 1_048_576
    });
    expect(upload).toHaveBeenCalledWith({
      filename: "gamarr-attempt-1.nzb",
      bytes: new Uint8Array([1, 2, 3]),
      category: "games",
      marker: "gamarr-attempt-1"
    });
    expect(add).not.toHaveBeenCalled();
  });

  it("stores resolved names alongside selected file indices", async () => {
    const { service } = build();

    const attempt = await service.submit(submission({ selectedFiles: [1, 0] }));

    expect(attempt.selectedFiles).toEqual([
      { index: 0, name: "Collection/a.xci" },
      { index: 1, name: "Collection/sub/b.xci" }
    ]);
  });

  it("rejects a selected index the torrent does not contain", async () => {
    const { service, repository, add } = build();

    await expect(service.submit(submission({ selectedFiles: [2] })))
      .rejects.toMatchObject({
        code: "VALIDATION",
        status: 400,
        message: "Selected torrent file is not available"
      });
    expect(add).not.toHaveBeenCalled();
    expect(repository.list()).toHaveLength(1);
    expect(repository.list()[0]).toMatchObject({
      status: "Failed",
      failureDetail: "Selected torrent file is not available"
    });
  });

  it("rejects a file selection on a magnet release", async () => {
    const { service, repository, add } = build();

    await expect(service.submit(submission({
      candidateId: "candidate-magnet",
      selectedFiles: [0]
    }))).rejects.toMatchObject({
      code: "VALIDATION",
      status: 400,
      message: "File selection is not available for a magnet release"
    });
    expect(add).not.toHaveBeenCalled();
    expect(repository.list()[0]).toMatchObject({
      status: "Failed",
      failureDetail: "File selection is not available for a magnet release"
    });
  });

  it("parks an ambiguous add in Unknown", async () => {
    const { service } = build({
      addError: new TorrentAddError(
        "ambiguous",
        "qBittorrent did not confirm the torrent"
      )
    });

    const attempt = await service.submit(submission());

    expect(attempt).toMatchObject({
      status: "Unknown",
      failureDetail: "qBittorrent did not confirm the torrent"
    });
  });

  it("returns the existing attempt when a submission key replays", async () => {
    const { service, fetch, add } = build();
    const request = submission();

    const first = await service.submit(request);
    const replay = await service.submit(request);

    expect(replay).toEqual(first);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledTimes(1);
  });

  it("fails a replay whose selection differs", async () => {
    const { service, add } = build();
    await service.submit(submission({ selectedFiles: [0] }));

    await expect(service.submit(submission({ selectedFiles: [1] })))
      .rejects.toMatchObject({ code: "CONFLICT", status: 409 });
    expect(add).toHaveBeenCalledTimes(1);
  });

  it("hashes a selection identically regardless of index order", async () => {
    const { service, add } = build();

    const first = await service.submit(submission({ selectedFiles: [1, 0] }));
    const replay = await service.submit(submission({ selectedFiles: [0, 1] }));

    expect(replay.id).toBe(first.id);
    expect(first.requestFingerprint).toBe(
      "0db20d75ae02fe0de0e07a4dcf8dd9b50da590d0a88c1e3e84d9881f014dbcde"
    );
    expect(add).toHaveBeenCalledTimes(1);
  });

  it("still matches a legacy newznab attempt on replay", async () => {
    const repository = new MemoryDownloads();
    const legacy = storedAttempt({
      submissionKey: "legacy-newznab",
      requestFingerprint:
        "f0422f33b09f2cb694977563c0a76941b8615836a92927f617ea2919de1ccc4f",
      source: "newznab"
    });
    repository.attempts.set(legacy.id, legacy);
    const { service, fetch, add, upload } = build({ repository });

    const replay = await service.submit(submission({
      submissionKey: "legacy-newznab",
      candidateId: "candidate-a"
    }));

    expect(replay).toEqual(legacy);
    expect(fetch).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it("still matches a legacy internet-archive attempt on replay", async () => {
    const repository = new MemoryDownloads();
    const legacy = storedAttempt({
      submissionKey: "legacy-archive",
      requestFingerprint:
        "79751ab50f861ae192664dcecd5cf6fd444d5b28a9cad79210e7eb7a8ff97319",
      source: "internet-archive",
      iaFileName: "Game.zip"
    });
    repository.attempts.set(legacy.id, legacy);
    const { service, fetch, add, upload } = build({ repository });

    const replay = await service.submit(submission({
      submissionKey: "legacy-archive",
      candidateId: "candidate-a"
    }));

    expect(replay).toEqual(legacy);
    expect(fetch).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it("never contains an external await inside the claim transaction", async () => {
    const events: string[] = [];
    const repository = new MemoryDownloads(events);
    const { service } = build({ repository, events });

    await service.submit(submission());

    expect(events).toEqual(["claim-start", "claim-end", "fetch"]);
  });
});

describe("DownloadService submission safety", () => {
  it("uses a synthetic filename rather than a provider guid", async () => {
    const secretCandidate = candidate("usenet", {
      id: "candidate-secret-guid",
      guid: "https://provider.test/details?token=provider-secret"
    });
    candidateRecords.set(secretCandidate.id, secretCandidate);
    const { service, upload } = build();

    await service.submit(submission({
      submissionKey: "safe-filename",
      candidateId: secretCandidate.id
    }));

    const uploadInput = upload.mock.calls[0]?.[0];
    expect(uploadInput?.filename).toBe("gamarr-attempt-1.nzb");
    expect(JSON.stringify(uploadInput)).not.toContain("provider-secret");
  });

  it("does not persist a raw fetch error that contains the Prowlarr key", async () => {
    const { service } = build({
      fetchError: new Error(
        "request failed for http://prowlarr.test/?apikey=prowlarr-secret-key"
      )
    });

    const attempt = await service.submit(submission());

    expect(attempt).toMatchObject({
      status: "Failed",
      failureDetail: "Release payload retrieval failed"
    });
    expect(JSON.stringify(attempt)).not.toContain("prowlarr-secret-key");
  });

  it("keeps an ambiguous SABnzbd acknowledgement Unknown", async () => {
    const { service } = build({
      uploadError: new SabnzbdUploadError(
        "ambiguous",
        "SABnzbd did not confirm the upload"
      )
    });

    const attempt = await service.submit(submission({
      candidateId: "candidate-usenet"
    }));

    expect(attempt).toMatchObject({
      status: "Unknown",
      failureDetail: "SABnzbd acknowledgement was not confirmed"
    });
  });

  it("rejects a submission key reused for a different candidate", async () => {
    const { service } = build();
    await service.submit(submission({ candidateId: "candidate-torrent" }));

    await expect(service.submit(submission({ candidateId: "candidate-magnet" })))
      .rejects.toMatchObject({ code: "CONFLICT", status: 409 });
  });

  it("derives legacy fingerprints from stored fields, not request-only data", () => {
    expect(fingerprint(["candidate-a", 1, 130])).toBe(
      "f0422f33b09f2cb694977563c0a76941b8615836a92927f617ea2919de1ccc4f"
    );
    expect(fingerprint(["candidate-a", 1, 130, "Game.zip"])).toBe(
      "79751ab50f861ae192664dcecd5cf6fd444d5b28a9cad79210e7eb7a8ff97319"
    );
  });
});

describe("DownloadService torrent reconciliation and recovery", () => {
  it("reconciles a prowlarr torrent by hash", async () => {
    const repository = new MemoryDownloads();
    const attempt = storedAttempt({
      id: "prowlarr-by-hash",
      submissionKey: "prowlarr-by-hash-key",
      status: "Queued",
      source: "prowlarr-torrent",
      torrentHash: "hash-from-add",
      selectedFiles: [],
      marker: "gamarr-prowlarr-by-hash",
      sabJobId: null
    });
    repository.attempts.set(attempt.id, attempt);
    const { service } = build({
      repository,
      torrents: [{
        hash: "hash-from-add",
        tags: [],
        state: "downloading",
        progress: 41.6
      }]
    });

    const [reconciled] = await service.reconcile([attempt.id]);

    expect(reconciled).toMatchObject({
      status: "Downloading",
      progress: 42,
      torrentHash: "hash-from-add",
      failureDetail: null
    });
  });

  it("reconciles a prowlarr torrent by tag when no hash was returned", async () => {
    const repository = new MemoryDownloads();
    const attempt = storedAttempt({
      id: "prowlarr-by-tag",
      submissionKey: "prowlarr-by-tag-key",
      status: "Unknown",
      source: "prowlarr-torrent",
      torrentHash: null,
      selectedFiles: [],
      marker: "gamarr-prowlarr-by-tag",
      sabJobId: null
    });
    repository.attempts.set(attempt.id, attempt);
    const { service } = build({
      repository,
      torrents: [{
        hash: "hash-found-by-tag",
        tags: ["unrelated", "gamarr-prowlarr-by-tag"],
        state: "downloading",
        progress: 12
      }]
    });

    const [reconciled] = await service.reconcile([attempt.id]);

    expect(reconciled).toMatchObject({
      status: "Downloading",
      progress: 12,
      torrentHash: "hash-found-by-tag",
      failureDetail: null
    });
  });

  it("reports only attempts this reconcile moved to Completed", async () => {
    const repository = new MemoryDownloads();
    const finishing = storedAttempt({
      id: "finishing",
      submissionKey: "finishing-key",
      status: "Downloading",
      source: "prowlarr-torrent",
      torrentHash: "finishing-hash",
      selectedFiles: [],
      marker: "gamarr-finishing",
      sabJobId: null
    });
    const still = storedAttempt({
      id: "still",
      submissionKey: "still-key",
      status: "Downloading",
      source: "prowlarr-torrent",
      torrentHash: "still-hash",
      selectedFiles: [],
      marker: "gamarr-still",
      sabJobId: null
    });
    repository.attempts.set(finishing.id, finishing);
    repository.attempts.set(still.id, still);
    const onCompleted = vi.fn();
    const { service } = build({
      repository,
      onCompleted,
      torrents: [
        { hash: "finishing-hash", tags: [], state: "stalledUP", progress: 100 },
        { hash: "still-hash", tags: [], state: "downloading", progress: 40 }
      ]
    });

    await service.reconcile();
    expect(onCompleted).toHaveBeenCalledWith(["finishing"]);

    onCompleted.mockClear();
    await service.reconcile();
    expect(onCompleted).not.toHaveBeenCalled();
  });

  it("still reconciles a legacy internet-archive-torrent attempt", async () => {
    const repository = new MemoryDownloads();
    const attempt = storedAttempt({
      id: "legacy-torrent",
      submissionKey: "legacy-torrent-key",
      status: "Queued",
      source: "internet-archive-torrent",
      torrentHash: "legacy-hash",
      selectedFiles: null,
      marker: "gamarr-legacy-torrent",
      sabJobId: null
    });
    repository.attempts.set(attempt.id, attempt);
    const { service } = build({
      repository,
      torrents: [{
        hash: "legacy-hash",
        tags: ["gamarr-legacy-torrent"],
        state: "stalledUP",
        progress: 100
      }]
    });

    const [reconciled] = await service.reconcile([attempt.id]);

    expect(reconciled).toMatchObject({
      status: "Completed",
      progress: 100,
      completedAt: 1_000,
      torrentHash: "legacy-hash"
    });
  });

  it("skips file application until metadata arrives", async () => {
    const repository = new MemoryDownloads();
    const attempt = storedAttempt({
      id: "metadata-pending",
      submissionKey: "metadata-pending-key",
      source: "prowlarr-torrent",
      torrentHash: "metadata-hash",
      selectedFiles: [{ index: 1, name: "Collection/b.xci" }],
      marker: "gamarr-metadata-pending"
    });
    repository.attempts.set(attempt.id, attempt);
    const { service, listFiles, setFilePriorities } = build({
      repository,
      torrents: [{
        hash: "metadata-hash",
        tags: ["gamarr-metadata-pending"],
        state: "downloading",
        progress: 10
      }],
      fileLists: [
        [],
        [
          { index: 0, name: "Collection/a.xci" },
          { index: 1, name: "Collection/b.xci" }
        ]
      ]
    });

    await service.reconcile([attempt.id]);

    expect(repository.get(attempt.id)?.filesAppliedAt).toBeNull();
    expect(setFilePriorities).not.toHaveBeenCalled();

    await service.reconcile([attempt.id]);

    expect(listFiles).toHaveBeenCalledTimes(2);
    expect(setFilePriorities).toHaveBeenCalledWith(
      "metadata-hash",
      [0],
      0
    );
    expect(repository.get(attempt.id)?.filesAppliedAt).toBe(1_000);
  });

  it("deprioritises every unselected file", async () => {
    const repository = new MemoryDownloads();
    const attempt = storedAttempt({
      id: "subset-selection",
      submissionKey: "subset-selection-key",
      source: "prowlarr-torrent",
      torrentHash: "subset-hash",
      selectedFiles: [{ index: 1, name: "Collection/b.xci" }],
      marker: "gamarr-subset-selection"
    });
    repository.attempts.set(attempt.id, attempt);
    const { service, setFilePriorities } = build({
      repository,
      torrents: [{
        hash: "subset-hash",
        tags: ["gamarr-subset-selection"],
        state: "downloading",
        progress: 10
      }],
      fileLists: [[
        { index: 0, name: "Collection/a.xci" },
        { index: 1, name: "Collection/b.xci" },
        { index: 2, name: "Collection/c.xci" }
      ]]
    });

    await service.reconcile([attempt.id]);

    expect(setFilePriorities).toHaveBeenCalledOnce();
    expect(setFilePriorities).toHaveBeenCalledWith(
      "subset-hash",
      [0, 2],
      0
    );
  });

  it("makes no priority call when every file is selected", async () => {
    const repository = new MemoryDownloads();
    const attempt = storedAttempt({
      id: "all-selected",
      submissionKey: "all-selected-key",
      source: "prowlarr-torrent",
      torrentHash: "all-selected-hash",
      selectedFiles: [
        { index: 0, name: "Collection/a.xci" },
        { index: 1, name: "Collection/b.xci" }
      ],
      marker: "gamarr-all-selected"
    });
    repository.attempts.set(attempt.id, attempt);
    const { service, setFilePriorities } = build({
      repository,
      torrents: [{
        hash: "all-selected-hash",
        tags: ["gamarr-all-selected"],
        state: "downloading",
        progress: 10
      }],
      fileLists: [[
        { index: 0, name: "Collection/a.xci" },
        { index: 1, name: "Collection/b.xci" }
      ]]
    });

    await service.reconcile([attempt.id]);

    expect(setFilePriorities).not.toHaveBeenCalled();
    expect(repository.get(attempt.id)?.filesAppliedAt).toBe(1_000);
  });

  it("stamps filesAppliedAt exactly once", async () => {
    const repository = new MemoryDownloads();
    let timestamp = 1_000;
    const attempt = storedAttempt({
      id: "stamp-once",
      submissionKey: "stamp-once-key",
      source: "prowlarr-torrent",
      torrentHash: "stamp-once-hash",
      selectedFiles: [{ index: 0, name: "Collection/a.xci" }],
      marker: "gamarr-stamp-once"
    });
    repository.attempts.set(attempt.id, attempt);
    const { service, listFiles, setFilePriorities } = build({
      repository,
      torrents: [{
        hash: "stamp-once-hash",
        tags: ["gamarr-stamp-once"],
        state: "downloading",
        progress: 10
      }],
      fileLists: [[
        { index: 0, name: "Collection/a.xci" },
        { index: 1, name: "Collection/b.xci" }
      ]],
      now: () => timestamp
    });

    await service.reconcile([attempt.id]);
    timestamp = 2_000;
    await service.reconcile([attempt.id]);

    expect(listFiles).toHaveBeenCalledOnce();
    expect(setFilePriorities).toHaveBeenCalledOnce();
    expect(repository.get(attempt.id)?.filesAppliedAt).toBe(1_000);
  });

  it("resumes file application after a restart", async () => {
    const repository = new MemoryDownloads();
    const attempt = storedAttempt({
      id: "restart-selection",
      submissionKey: "restart-selection-key",
      source: "prowlarr-torrent",
      torrentHash: "restart-hash",
      selectedFiles: [{ index: 1, name: "Collection/b.xci" }],
      marker: "gamarr-restart-selection"
    });
    repository.attempts.set(attempt.id, attempt);
    const torrent: TorrentJob = {
      hash: "restart-hash",
      tags: ["gamarr-restart-selection"],
      state: "downloading",
      progress: 10
    };
    const beforeRestart = build({
      repository,
      torrents: [torrent],
      fileLists: [[]]
    });

    await beforeRestart.service.reconcile([attempt.id]);
    expect(repository.get(attempt.id)?.filesAppliedAt).toBeNull();

    const afterRestart = build({
      repository,
      torrents: [torrent],
      fileLists: [[
        { index: 0, name: "Collection/a.xci" },
        { index: 1, name: "Collection/b.xci" }
      ]]
    });

    await afterRestart.service.reconcile([attempt.id]);

    expect(afterRestart.setFilePriorities).toHaveBeenCalledWith(
      "restart-hash",
      [0],
      0
    );
    expect(repository.get(attempt.id)?.filesAppliedAt).toBe(1_000);
  });

  it("aborts application when a name no longer matches its index", async () => {
    const repository = new MemoryDownloads();
    const attempt = storedAttempt({
      id: "name-mismatch",
      submissionKey: "name-mismatch-key",
      source: "prowlarr-torrent",
      torrentHash: "mismatch-hash",
      selectedFiles: [{ index: 1, name: "Collection/b.xci" }],
      marker: "gamarr-name-mismatch"
    });
    repository.attempts.set(attempt.id, attempt);
    const { service, setFilePriorities } = build({
      repository,
      torrents: [{
        hash: "mismatch-hash",
        tags: ["gamarr-name-mismatch"],
        state: "downloading",
        progress: 10
      }],
      fileLists: [[
        { index: 0, name: "Collection/a.xci" },
        { index: 1, name: "Collection/renamed.xci" }
      ]]
    });

    await service.reconcile([attempt.id]);

    expect(setFilePriorities).not.toHaveBeenCalled();
    expect(repository.get(attempt.id)).toMatchObject({
      status: "Downloading",
      filesAppliedAt: null,
      failureDetail: "Torrent file list did not match the selection"
    });
  });

  it("fails leftover internet-archive attempts on startup", () => {
    const repository = new MemoryDownloads();
    const statuses = [
      "Pending",
      "Submitting",
      "Unknown",
      "Queued",
      "Downloading"
    ] as const;
    for (const status of statuses) {
      const id = `legacy-direct-${status}`;
      repository.attempts.set(id, storedAttempt({
        id,
        submissionKey: `${id}-key`,
        status,
        source: "internet-archive",
        iaFileName: "Game.zip",
        updatedAt: 1_000
      }));
    }
    repository.attempts.set("legacy-direct-completed", storedAttempt({
      id: "legacy-direct-completed",
      submissionKey: "legacy-direct-completed-key",
      status: "Completed",
      source: "internet-archive",
      iaFileName: "Game.zip",
      completedAt: 900,
      updatedAt: 900
    }));
    const { service } = build({ repository });

    service.recoverStaleSubmissions();

    for (const status of statuses) {
      expect(repository.get(`legacy-direct-${status}`)).toMatchObject({
        status: "Failed",
        failureDetail: "The direct download path was removed",
        updatedAt: 1_000
      });
    }
    expect(repository.get("legacy-direct-completed")).toMatchObject({
      status: "Completed",
      failureDetail: null,
      updatedAt: 900
    });
  });
});

describe("fingerprintParts", () => {
  it("pins a collection-torrent request to its file index", () => {
    const input = {
      candidateId: "candidate-collection",
      gameId: 1,
      platformId: 130
    } as SubmitDownloadInput;

    expect(fingerprintParts("collection-torrent", input, {
      iaFileName: null,
      collectionFileIndex: 4
    })).toEqual(["candidate-collection", 1, 130, "torrent", 4]);
    expect(fingerprintParts("collection-torrent", input, {
      iaFileName: null,
      collectionFileIndex: null
    })).toEqual(["candidate-collection", 1, 130, "torrent", -1]);
  });
});

interface FakeTorrentFile {
  index: number;
  name: string;
  priority: number;
  progress: number;
}

/**
 * A qBittorrent stand-in that keeps real per-file priorities and records every
 * call in order, so tests can assert both the sequence and the end state.
 */
function fakeQbittorrent(options: {
  loaded?: boolean;
  files?: Array<{ index: number; name: string; priority?: number }>;
  notFoundPolls?: number;
  emptyPolls?: number;
  addError?: unknown;
  /** After a failed add, `list()` reports the torrent (a lost add race). */
  presentAfterAddError?: boolean;
  addHash?: string | null;
  ignoreLowering?: boolean;
  failPriorities?: boolean;
  startError?: unknown;
}) {
  const calls: string[] = [];
  const addInputs: Array<Parameters<TorrentClientPort["add"]>[0]> = [];
  const template = options.files ?? [
    { index: 0, name: "Collection/a.7z" },
    { index: 1, name: "Collection/b.7z" },
    { index: 2, name: "Collection/c.7z" }
  ];
  const files: FakeTorrentFile[] = template.map((file) => ({
    progress: 0,
    ...file,
    priority: file.priority ?? 1
  }));
  let present = options.loaded === true;
  let notFound = options.notFoundPolls ?? 0;
  let empty = options.emptyPolls ?? 0;
  let addFailed = false;
  const client: TorrentClientPort = {
    add: async (input) => {
      calls.push(`add(stopped=${String(input.stopped)})`);
      addInputs.push(input);
      if (options.addError !== undefined) {
        addFailed = true;
        throw options.addError;
      }
      present = true;
      for (const file of files) file.priority = 1;
      return {
        hash: options.addHash === undefined ? collectionHash : options.addHash
      };
    },
    listFiles: async (hash) => {
      calls.push("listFiles");
      expect(hash).toBe(collectionHash);
      if (notFound > 0) {
        notFound -= 1;
        throw new AppError("NOT_FOUND", 404, "Torrent not found");
      }
      if (empty > 0) {
        empty -= 1;
        return [];
      }
      if (!present) throw new AppError("NOT_FOUND", 404, "Torrent not found");
      return files.map((file) => ({ ...file }));
    },
    setFilePriorities: async (hash, indices, priority) => {
      expect(hash).toBe(collectionHash);
      calls.push(`prio([${indices.join(",")}],${priority})`);
      if (options.failPriorities) throw new Error("connection reset");
      if (priority === 0 && options.ignoreLowering) return;
      for (const file of files) {
        if (indices.includes(file.index)) file.priority = priority;
      }
    },
    addTags: async (hash, tag) => {
      expect(hash).toBe(collectionHash);
      calls.push(`addTags(${tag})`);
    },
    start: async (hash) => {
      expect(hash).toBe(collectionHash);
      calls.push("start");
      if (options.startError !== undefined) throw options.startError;
    },
    list: async () => {
      calls.push("list");
      const visible = present || (addFailed && options.presentAfterAddError);
      if (visible && options.presentAfterAddError) present = true;
      return visible
        ? [{ hash: collectionHash, tags: [], state: "stoppedDL", progress: 0 }]
        : [];
    },
    testConnection: async () => undefined
  };
  return { client, calls, files, addInputs };
}

function collectionAttempt(
  id: string,
  status: DownloadAttempt["status"],
  index: number,
  name: string
): DownloadAttempt {
  return storedAttempt({
    id,
    submissionKey: `key-${id}`,
    status,
    source: "collection-torrent",
    indexerId: `collection:${collectionHash}`,
    torrentHash: collectionHash,
    selectedFiles: [{ index, name }],
    marker: `gamarr-${id}`,
    sabJobId: null
  });
}

const otherFilesEnabled =
  "Other files in this collection are enabled in qBittorrent; "
  + "set them to Do not download, then retry";

function collectionSubmission(
  overrides: Partial<SubmitDownloadInput> = {}
): SubmitDownloadInput {
  return submission({ candidateId: collectionCandidate.id, ...overrides });
}

describe("DownloadService collection submission", () => {
  it("fresh add: add(stopped) → filePrio(all,0) → filePrio([i],1) → start", async () => {
    const qbit = fakeQbittorrent({});
    const { service } = build({ client: qbit.client });

    const attempt = await service.submit(collectionSubmission());

    expect(qbit.calls).toEqual([
      "list",
      "add(stopped=true)",
      "listFiles",
      "prio([0,1,2],0)",
      "prio([1],1)",
      "listFiles",
      "start"
    ]);
    expect(qbit.addInputs[0]).toMatchObject({
      category: "games",
      tag: "gamarr-attempt-1",
      stopped: true
    });
    expect(qbit.files.map((file) => file.priority)).toEqual([0, 1, 0]);
    expect(attempt).toMatchObject({
      status: "Downloading",
      source: "collection-torrent",
      torrentHash: collectionHash,
      selectedFiles: [{ index: 1, name: "b.7z" }],
      filesAppliedAt: 1_000,
      failureDetail: null,
      requestFingerprint: fingerprint([
        collectionCandidate.id,
        1,
        130,
        "torrent",
        1
      ])
    });
  });

  it("polls listFiles through NOT_FOUND/empty until files appear", async () => {
    const qbit = fakeQbittorrent({ notFoundPolls: 2, emptyPolls: 1 });
    const sleep = vi.fn(async () => undefined);
    const { service } = build({ client: qbit.client, sleep });

    const attempt = await service.submit(collectionSubmission());

    expect(attempt.status).toBe("Downloading");
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(qbit.calls.slice(0, 7)).toEqual([
      "list",
      "add(stopped=true)",
      "listFiles",
      "listFiles",
      "listFiles",
      "listFiles",
      "prio([0,1,2],0)"
    ]);
  });

  it("fails with nothing started when the files never appear within 10 s", async () => {
    const qbit = fakeQbittorrent({ notFoundPolls: 1_000 });
    const waits: number[] = [];
    const { service } = build({
      client: qbit.client,
      sleep: async (ms) => {
        waits.push(ms);
      }
    });

    const attempt = await service.submit(collectionSubmission());

    expect(attempt.status).toBe("Failed");
    expect(attempt.failureDetail).toBeTruthy();
    expect(waits.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(10_000);
    expect(qbit.calls).not.toContain("start");
    expect(qbit.calls.some((call) => call.startsWith("prio"))).toBe(false);
    expect(qbit.addInputs[0]?.stopped).toBe(true);
  });

  it("already loaded: addTags then filePrio([i],1) then start; no add; nothing lowered", async () => {
    const repository = new MemoryDownloads();
    repository.attempts.set(
      "other",
      collectionAttempt("other", "Downloading", 0, "a.7z")
    );
    const qbit = fakeQbittorrent({
      loaded: true,
      files: [
        { index: 0, name: "Collection/a.7z", priority: 1 },
        { index: 1, name: "Collection/b.7z", priority: 0 },
        { index: 2, name: "Collection/c.7z", priority: 0 }
      ]
    });
    const { service } = build({ client: qbit.client, repository });

    const attempt = await service.submit(collectionSubmission());

    expect(qbit.calls).toEqual([
      "list",
      "addTags(gamarr-attempt-1)",
      "listFiles",
      "prio([1],1)",
      "listFiles",
      "start"
    ]);
    expect(qbit.files.map((file) => file.priority)).toEqual([1, 1, 0]);
    expect(attempt).toMatchObject({
      status: "Downloading",
      torrentHash: collectionHash,
      selectedFiles: [{ index: 1, name: "b.7z" }],
      filesAppliedAt: 1_000
    });
  });

  it("add rejected 409 → already-loaded path", async () => {
    const repository = new MemoryDownloads();
    repository.attempts.set(
      "other",
      collectionAttempt("other", "Submitting", 0, "a.7z")
    );
    const qbit = fakeQbittorrent({
      addError: new TorrentAddError(
        "rejected",
        "qBittorrent rejected the torrent submission"
      ),
      presentAfterAddError: true,
      files: [
        { index: 0, name: "Collection/a.7z", priority: 1 },
        { index: 1, name: "Collection/b.7z", priority: 0 },
        { index: 2, name: "Collection/c.7z", priority: 0 }
      ]
    });
    const { service } = build({ client: qbit.client, repository });

    const attempt = await service.submit(collectionSubmission());

    expect(qbit.calls).toEqual([
      "list",
      "add(stopped=true)",
      "list",
      "addTags(gamarr-attempt-1)",
      "listFiles",
      "prio([1],1)",
      "listFiles",
      "start"
    ]);
    expect(qbit.calls.some((call) => call.endsWith(",0)"))).toBe(false);
    expect(attempt.status).toBe("Downloading");
  });

  it("fails a rejected add when qBittorrent does not have the torrent", async () => {
    const qbit = fakeQbittorrent({
      addError: new TorrentAddError(
        "rejected",
        "qBittorrent rejected the torrent submission"
      )
    });
    const { service } = build({ client: qbit.client });

    const attempt = await service.submit(collectionSubmission());

    expect(attempt).toMatchObject({
      status: "Failed",
      failureDetail: "qBittorrent rejected the torrent submission"
    });
    expect(qbit.calls).not.toContain("start");
  });

  it("unowned file wanted on a hand-loaded torrent → Failed, never started", async () => {
    const qbit = fakeQbittorrent({ loaded: true });
    const { service } = build({ client: qbit.client });

    const attempt = await service.submit(collectionSubmission());

    expect(attempt).toMatchObject({
      status: "Failed",
      failureDetail: otherFilesEnabled
    });
    expect(qbit.calls).not.toContain("start");
    expect(qbit.calls.some((call) => call.endsWith(",0)"))).toBe(false);
  });

  it("treats a file owned by a Completed attempt as owned", async () => {
    const repository = new MemoryDownloads();
    repository.attempts.set(
      "done",
      collectionAttempt("done", "Completed", 0, "a.7z")
    );
    const qbit = fakeQbittorrent({
      loaded: true,
      files: [
        { index: 0, name: "Collection/a.7z", priority: 1 },
        { index: 1, name: "Collection/b.7z", priority: 0 },
        { index: 2, name: "Collection/c.7z", priority: 0 }
      ]
    });
    const { service } = build({ client: qbit.client, repository });

    const attempt = await service.submit(collectionSubmission());

    expect(attempt.status).toBe("Downloading");
    expect(qbit.calls.at(-1)).toBe("start");
  });

  it("does not count a Failed attempt's file as owned", async () => {
    const repository = new MemoryDownloads();
    repository.attempts.set(
      "done",
      collectionAttempt("done", "Completed", 0, "a.7z")
    );
    repository.attempts.set(
      "failed",
      collectionAttempt("failed", "Failed", 2, "c.7z")
    );
    const qbit = fakeQbittorrent({
      loaded: true,
      files: [
        { index: 0, name: "Collection/a.7z", priority: 1 },
        { index: 1, name: "Collection/b.7z", priority: 0 },
        { index: 2, name: "Collection/c.7z", priority: 1 }
      ]
    });
    const { service } = build({ client: qbit.client, repository });

    const attempt = await service.submit(collectionSubmission());

    expect(attempt).toMatchObject({
      status: "Failed",
      failureDetail: otherFilesEnabled
    });
    expect(qbit.calls).not.toContain("start");
  });

  it("re-reads priorities after the raise and refuses to start on an unowned file", async () => {
    const qbit = fakeQbittorrent({ ignoreLowering: true });
    const { service } = build({ client: qbit.client });

    const attempt = await service.submit(collectionSubmission());

    expect(attempt).toMatchObject({
      status: "Failed",
      failureDetail: otherFilesEnabled
    });
    expect(qbit.calls).toEqual([
      "list",
      "add(stopped=true)",
      "listFiles",
      "prio([0,1,2],0)",
      "prio([1],1)",
      "listFiles"
    ]);
  });

  it("leaves a fresh torrent stopped when a call after the add fails", async () => {
    const qbit = fakeQbittorrent({ failPriorities: true });
    const { service } = build({ client: qbit.client });

    const attempt = await service.submit(collectionSubmission());

    expect(attempt.status).toBe("Failed");
    expect(attempt.failureDetail).toBeTruthy();
    expect(qbit.calls).not.toContain("start");
  });

  it("fails without starting when qBittorrent reports a different hash", async () => {
    const qbit = fakeQbittorrent({
      addHash: "0123456789abcdef0123456789abcdef01234567"
    });
    const { service } = build({ client: qbit.client });

    const attempt = await service.submit(collectionSubmission());

    expect(attempt).toMatchObject({
      status: "Failed",
      failureDetail: "Collection torrent changed; search again"
    });
    expect(qbit.calls).toEqual(["list", "add(stopped=true)"]);
  });

  it("keeps another live attempt's file out of the fresh zero-all call", async () => {
    const repository = new MemoryDownloads();
    repository.attempts.set(
      "racing",
      collectionAttempt("racing", "Submitting", 2, "c.7z")
    );
    const qbit = fakeQbittorrent({});
    const { service } = build({ client: qbit.client, repository });

    const attempt = await service.submit(collectionSubmission());

    expect(qbit.calls).toContain("prio([0,1],0)");
    expect(qbit.files.map((file) => file.priority)).toEqual([0, 1, 1]);
    expect(attempt.status).toBe("Downloading");
  });

  it("zeroes stale Completed and Downloading owners' files on a fresh add", async () => {
    const repository = new MemoryDownloads();
    repository.attempts.set(
      "done",
      collectionAttempt("done", "Completed", 0, "a.7z")
    );
    repository.attempts.set(
      "stale",
      collectionAttempt("stale", "Downloading", 2, "c.7z")
    );
    const qbit = fakeQbittorrent({});
    const { service } = build({ client: qbit.client, repository });

    const attempt = await service.submit(collectionSubmission());

    expect(qbit.calls).toEqual([
      "list",
      "add(stopped=true)",
      "listFiles",
      "prio([0,1,2],0)",
      "prio([1],1)",
      "listFiles",
      "start"
    ]);
    expect(qbit.files.map((file) => file.priority)).toEqual([0, 1, 0]);
    expect(attempt.status).toBe("Downloading");
  });

  it("zeroes a stale Downloading owner of the target index before raising it", async () => {
    const repository = new MemoryDownloads();
    repository.attempts.set(
      "done",
      collectionAttempt("done", "Completed", 0, "a.7z")
    );
    repository.attempts.set(
      "stale",
      collectionAttempt("stale", "Downloading", 1, "b.7z")
    );
    const qbit = fakeQbittorrent({});
    const { service } = build({ client: qbit.client, repository });

    const attempt = await service.submit(collectionSubmission());

    expect(qbit.calls).toEqual([
      "list",
      "add(stopped=true)",
      "listFiles",
      "prio([0,1,2],0)",
      "prio([1],1)",
      "listFiles",
      "start"
    ]);
    expect(attempt.status).toBe("Downloading");
  });

  it("records Unknown when start itself is not confirmed", async () => {
    const qbit = fakeQbittorrent({ startError: new Error("socket hang up") });
    const { service } = build({ client: qbit.client });

    const attempt = await service.submit(collectionSubmission());

    expect(attempt).toMatchObject({
      status: "Unknown",
      failureDetail: "qBittorrent start was not confirmed",
      filesAppliedAt: null
    });
    expect(qbit.calls.at(-1)).toBe("start");
  });

  it("file name at index differs (already loaded) → Failed, no calls after files", async () => {
    const qbit = fakeQbittorrent({
      loaded: true,
      files: [
        { index: 0, name: "Collection/a.7z", priority: 0 },
        { index: 1, name: "Collection/z.7z", priority: 0 },
        { index: 2, name: "Collection/c.7z", priority: 0 }
      ]
    });
    const { service } = build({ client: qbit.client });

    const attempt = await service.submit(collectionSubmission());

    expect(attempt).toMatchObject({
      status: "Failed",
      failureDetail: "Collection torrent changed; search again"
    });
    expect(qbit.calls).toEqual([
      "list",
      "addTags(gamarr-attempt-1)",
      "listFiles"
    ]);
  });

  it("file name at index differs (fresh add) → Failed, never raised or started", async () => {
    const qbit = fakeQbittorrent({
      files: [
        { index: 0, name: "Collection/a.7z" },
        { index: 1, name: "Collection/z.7z" },
        { index: 2, name: "Collection/c.7z" }
      ]
    });
    const { service } = build({ client: qbit.client });

    const attempt = await service.submit(collectionSubmission());

    expect(attempt).toMatchObject({
      status: "Failed",
      failureDetail: "Collection torrent changed; search again"
    });
    expect(qbit.calls).toEqual([
      "list",
      "add(stopped=true)",
      "listFiles",
      "prio([0,1,2],0)"
    ]);
  });

  it("does not accept a suffix match from a deeper folder", async () => {
    const qbit = fakeQbittorrent({
      loaded: true,
      files: [
        { index: 0, name: "Collection/a.7z", priority: 0 },
        { index: 1, name: "Collection/extra/b.7z", priority: 0 }
      ]
    });
    const { service } = build({ client: qbit.client });

    const attempt = await service.submit(collectionSubmission());

    expect(attempt.failureDetail).toBe("Collection torrent changed; search again");
    expect(qbit.calls).not.toContain("start");
  });

  it("selectedFiles in the request → validation error before claiming", async () => {
    const qbit = fakeQbittorrent({});
    const { service, repository } = build({ client: qbit.client });

    await expect(service.submit(collectionSubmission({ selectedFiles: [1] })))
      .rejects.toThrow("Collection file selection is fixed");
    await expect(service.submit(collectionSubmission({ selectedFiles: [] })))
      .rejects.toThrow("Collection file selection is fixed");
    expect(repository.attempts.size).toBe(0);
    expect(qbit.calls).toEqual([]);
  });

  it("replay with the same submissionKey returns the attempt unchanged", async () => {
    const qbit = fakeQbittorrent({});
    const { service, fetch } = build({ client: qbit.client });

    const first = await service.submit(collectionSubmission());
    const callCount = qbit.calls.length;
    const replay = await service.submit(collectionSubmission());

    expect(replay).toEqual(first);
    expect(qbit.calls).toHaveLength(callCount);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("DownloadService collection reconciliation", () => {
  const root = "Collection";
  type Job = Awaited<ReturnType<TorrentClientPort["list"]>>[number];

  function setup(options: {
    state?: string;
    progress?: number[];
    jobs?: "absent";
    statuses?: DownloadAttempt["status"][];
  }) {
    const repository = new MemoryDownloads();
    const names = ["a.7z", "b.7z"];
    names.forEach((name, index) => {
      repository.attempts.set(
        `at-${index}`,
        collectionAttempt(
          `at-${index}`,
          options.statuses?.[index] ?? "Downloading",
          index,
          name
        )
      );
    });
    const calls: string[] = [];
    const progress = options.progress ?? [0, 0];
    const client = {
      list: async (): Promise<Job[]> => options.jobs === "absent"
        ? []
        : [{
          hash: collectionHash,
          tags: [],
          state: options.state ?? "downloading",
          progress: 0.99
        }],
      listFiles: async (hash: string) => {
        calls.push(`listFiles(${hash})`);
        return names.map((name, index) => ({
          index,
          name: `${root}/${name}`,
          progress: progress[index] ?? 0,
          priority: 1
        }));
      },
      setFilePriorities: async () => {
        calls.push("setFilePriorities");
      }
    } as unknown as TorrentClientPort;
    const { service } = build({ repository, client });
    return { service, repository, calls };
  }

  it("completes a file at 100% while the torrent is still downloading", async () => {
    const { service, repository, calls } = setup({
      state: "stalledDL",
      progress: [1, 0.3]
    });
    await service.reconcile();
    expect(repository.attempts.get("at-0")).toMatchObject({
      status: "Completed",
      progress: 100,
      failureDetail: null
    });
    expect(repository.attempts.get("at-1")).toMatchObject({
      status: "Downloading",
      progress: 30
    });
    expect(calls).toEqual([`listFiles(${collectionHash})`]);
  });

  it("completes two attempts on one torrent independently", async () => {
    const { service, repository } = setup({
      state: "stalledUP",
      progress: [1, 1]
    });
    await service.reconcile();
    expect(repository.attempts.get("at-0")?.status).toBe("Completed");
    expect(repository.attempts.get("at-1")?.status).toBe("Completed");
  });

  for (const state of ["error", "missingFiles"]) {
    it(`fails every attempt on a torrent in ${state}`, async () => {
      const { service, repository } = setup({ state, progress: [0.5, 1] });
      await service.reconcile();
      for (const id of ["at-0", "at-1"]) {
        expect(repository.attempts.get(id)).toMatchObject({
          status: "Failed",
          failureDetail: state
        });
      }
    });
  }

  for (const state of ["stoppedDL", "pausedDL"]) {
    it(`marks a ${state} torrent as stopped but keeps progress`, async () => {
      const { service, repository } = setup({ state, progress: [0.4, 0] });
      await service.reconcile();
      expect(repository.attempts.get("at-0")).toMatchObject({
        status: "Downloading",
        progress: 40,
        failureDetail: "Stopped in qBittorrent"
      });
    });
  }

  it("clears the stopped note once the torrent runs again", async () => {
    const { service, repository } = setup({
      state: "downloading",
      progress: [0.4, 0]
    });
    repository.attempts.set("at-0", {
      ...repository.attempts.get("at-0")!,
      failureDetail: "Stopped in qBittorrent"
    });
    await service.reconcile();
    expect(repository.attempts.get("at-0")).toMatchObject({
      status: "Downloading",
      progress: 40,
      failureDetail: null
    });
  });

  it("fails attempts whose torrent left qBittorrent", async () => {
    const { service, repository } = setup({ jobs: "absent" });
    await service.reconcile();
    expect(repository.attempts.get("at-0")).toMatchObject({
      status: "Failed",
      failureDetail: "Torrent was removed from qBittorrent"
    });
  });

  it("leaves a submitting attempt alone when its hash is absent", async () => {
    const { service, repository } = setup({
      jobs: "absent",
      statuses: ["Submitting", "Downloading"]
    });
    await service.reconcile();
    expect(repository.attempts.get("at-0")?.status).toBe("Submitting");
    expect(repository.attempts.get("at-1")?.status).toBe("Failed");
  });

  it("fails when the file at that index changed", async () => {
    const { service, repository } = setup({ progress: [0.2, 0] });
    repository.attempts.set("at-0", {
      ...repository.attempts.get("at-0")!,
      selectedFiles: [{ index: 0, name: "renamed.7z" }]
    });
    await service.reconcile();
    expect(repository.attempts.get("at-0")).toMatchObject({
      status: "Failed",
      failureDetail: "Collection torrent changed; search again"
    });
  });

  it("never calls setFilePriorities for collection attempts", async () => {
    const { service, calls } = setup({ progress: [0.2, 0.5] });
    await service.reconcile();
    await service.reconcile();
    expect(calls).not.toContain("setFilePriorities");
  });

  it("reports newly completed collection attempts", async () => {
    const onCompleted = vi.fn();
    const repository = new MemoryDownloads();
    repository.attempts.set(
      "at-0",
      collectionAttempt("at-0", "Downloading", 0, "a.7z")
    );
    const client = {
      list: async () => [{
        hash: collectionHash, tags: [], state: "stalledDL", progress: 0.1
      }],
      listFiles: async () => [
        { index: 0, name: "Collection/a.7z", progress: 1, priority: 1 }
      ]
    } as unknown as TorrentClientPort;
    const { service } = build({ repository, client, onCompleted });
    await service.reconcile();
    expect(onCompleted).toHaveBeenCalledWith(["at-0"]);
  });
});
