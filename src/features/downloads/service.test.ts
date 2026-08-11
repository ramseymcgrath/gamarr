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
import { DownloadService } from "@/features/downloads/service";
import type {
  CandidateRepository,
  ReleaseCandidateRecord
} from "@/features/release-search/ports";
import type { SettingsRepository } from "@/features/settings/service";

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

const candidateRecords = new Map([
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
  const torrentClient: TorrentClientPort = {
    add,
    listFiles: async () => [],
    setFilePriorities: async () => undefined,
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
      : torrentClient,
    maxTorrentBytes: 8 * 1024 * 1024,
    id: () => "attempt-1",
    now: () => 1_000
  });
  return { service, repository, fetch, add, upload };
}

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
