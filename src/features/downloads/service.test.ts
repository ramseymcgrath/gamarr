import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import type {
  DownloadAttempt,
  SubmissionClaimInput
} from "@/features/downloads/models";
import { isTerminalDownloadStatus } from "@/features/downloads/models";
import { SabnzbdUploadError } from "@/features/downloads/port";
import type { DownloadRepository } from "@/features/downloads/repository";
import { DownloadService } from "@/features/downloads/service";
import type { CandidateRepository } from "@/features/release-search/ports";
import type { SettingsRepository } from "@/features/settings/service";
import { AppError, validationError } from "@/lib/errors";

class MemoryDownloads implements DownloadRepository {
  attempts = new Map<string, DownloadAttempt>();

  findBySubmissionKey(key: string) {
    return [...this.attempts.values()].find((value) =>
      value.submissionKey === key) ?? null;
  }

  claimSubmission(input: SubmissionClaimInput) {
    const existing = this.findBySubmissionKey(input.attempt.submissionKey);
    if (existing) return { attempt: existing, created: false };
    this.attempts.set(input.attempt.id, input.attempt);
    return { attempt: input.attempt, created: true };
  }

  update(id: string, patch: Partial<DownloadAttempt>) {
    const current = this.attempts.get(id);
    if (!current) throw new Error("Download attempt does not exist");
    // Mirrors SqliteDownloadRepository: a terminal row accepts no further
    // writes, so a late callback cannot resurrect it.
    if (isTerminalDownloadStatus(current.status)) return current;
    const value = { ...current, ...patch };
    this.attempts.set(id, value);
    return value;
  }

  get(id: string) {
    return this.attempts.get(id) ?? null;
  }

  list() {
    return [...this.attempts.values()];
  }

  recoverStaleSubmitting(before: number, updatedAt: number) {
    for (const attempt of this.attempts.values()) {
      if (
        attempt.status === "Submitting" &&
        (attempt.sabRequestStartedAt ?? 0) < before
      ) {
        this.update(attempt.id, { status: "Unknown", updatedAt });
      }
    }
  }

  recoverStaleInternetArchiveDownloads(before: number, updatedAt: number) {
    for (const attempt of this.attempts.values()) {
      if (
        attempt.source === "internet-archive" &&
        (attempt.status === "Pending" || attempt.status === "Downloading") &&
        attempt.updatedAt < before
      ) {
        this.update(attempt.id, {
          status: "Failed",
          failureDetail: "Download was interrupted before completion",
          updatedAt
        });
      }
    }
  }
}

const candidate = {
  id: "candidate-a",
  expiresAt: 99_999,
  source: "newznab" as const,
  indexerId: "indexer",
  indexerConfigRevision: 1,
  guid: "guid",
  title: "Game.NSW-GROUP",
  size: 1234,
  downloadPath: "/api?t=get&id=guid",
  category: "4050",
  sourceSnapshot: JSON.stringify({
    origin: "https://indexer.test",
    indexerName: "Indexer"
  }),
  createdAt: 1
};

const candidates: CandidateRepository = {
  save: () => undefined,
  get: (id) => id.startsWith("candidate") ? { ...candidate, id } : null
};

const settings: SettingsRepository = {
  getIgdb: () => null,
  saveIgdb: () => undefined,
  getSabnzbd: () => ({
    baseUrl: "http://sab.test",
    apiKey: "sab-key",
    defaultCategory: "games",
    maxNzbBytes: 1_048_576,
    lastTestStatus: null,
    lastTestedAt: null,
    configRevision: 1,
    updatedAt: 1
  }),
  saveSabnzbd: () => undefined,
  listIndexers: () => [{
    id: "indexer",
    name: "Indexer",
    baseUrl: "https://indexer.test/api",
    apiKey: "indexer-key",
    enabled: true,
    categoryIds: [],
    timeoutMs: 10_000,
    configRevision: 1,
    lastTestStatus: null,
    lastTestedAt: null,
    deletedAt: null,
    createdAt: 1,
    updatedAt: 1
  }],
  saveIndexer: () => undefined,
  deleteIndexer: () => undefined
};

const input = (overrides: Partial<{
  submissionKey: string;
  candidateId: string;
  fileName: string;
}> = {}) => ({
  submissionKey: "same-key",
  candidateId: "candidate-a",
  gameId: 1,
  platformId: 130,
  ...overrides
});

const newznabService = (repository: MemoryDownloads) => new DownloadService({
  repository,
  candidates,
  settings,
  nzbFetcher: { fetch: async () => new Uint8Array([1]) },
  sabFactory: () => ({
    upload: async () => ({ jobId: "job" }),
    getQueue: async () => [],
    getHistory: async () => [],
    testConnection: async () => undefined
  }),
  id: () => "attempt-1",
  now: () => 1_000
});

describe("DownloadService", () => {
  it("returns the same attempt for a repeated submission key and submits once", async () => {
    const repository = new MemoryDownloads();
    let uploads = 0;
    const service = new DownloadService({
      repository,
      candidates,
      settings,
      nzbFetcher: { fetch: async () => new TextEncoder().encode("<nzb />") },
      sabFactory: () => ({
        upload: async () => ({ jobId: `job-${++uploads}` }),
        getQueue: async () => [],
        getHistory: async () => [],
        testConnection: async () => undefined
      }),
      id: () => "attempt-1",
      now: () => 1_000
    });

    const first = await service.submit(input());
    const second = await service.submit(input());

    expect(second.id).toBe(first.id);
    expect(first).toMatchObject({ status: "Queued", sabJobId: "job-1" });
    expect(uploads).toBe(1);
  });

  it("uses a synthetic NZB filename instead of exposing the provider GUID", async () => {
    const repository = new MemoryDownloads();
    let uploadedFilename = "";
    const service = new DownloadService({
      repository,
      candidates: {
        save: () => undefined,
        get: () => ({
          ...candidate,
          guid: "https://provider.example/details/guid?token=provider-secret"
        })
      },
      settings,
      nzbFetcher: { fetch: async () => new TextEncoder().encode("<nzb />") },
      sabFactory: () => ({
        upload: async ({ filename }) => {
          uploadedFilename = filename;
          return { jobId: "job-1" };
        },
        getQueue: async () => [],
        getHistory: async () => [],
        testConnection: async () => undefined
      }),
      id: () => "attempt-1",
      now: () => 1_000
    });

    await service.submit(input({ submissionKey: "safe-filename" }));

    expect(uploadedFilename).toBe("gamarr-attempt-1.nzb");
    expect(uploadedFilename).not.toContain("provider-secret");
  });

  it("marks an ambiguous acknowledgement Unknown and never auto-resubmits", async () => {
    const repository = new MemoryDownloads();
    let uploads = 0;
    const service = new DownloadService({
      repository,
      candidates,
      settings,
      nzbFetcher: { fetch: async () => new Uint8Array([1]) },
      sabFactory: () => ({
        upload: async () => {
          uploads += 1;
          throw new Error("connection closed after accept");
        },
        getQueue: async () => [],
        getHistory: async () => [],
        testConnection: async () => undefined
      }),
      id: () => "attempt-1",
      now: () => 1_000
    });

    const attempt = await service.submit(input({ submissionKey: "ambiguous" }));
    await service.reconcile([attempt.id]);

    expect(repository.get(attempt.id)?.status).toBe("Unknown");
    expect(uploads).toBe(1);
  });

  it("rejects a repeated submission key with a different fingerprint", async () => {
    const repository = new MemoryDownloads();
    const service = new DownloadService({
      repository,
      candidates,
      settings,
      nzbFetcher: { fetch: async () => new Uint8Array([1]) },
      sabFactory: () => ({
        upload: async () => ({ jobId: "job" }),
        getQueue: async () => [],
        getHistory: async () => [],
        testConnection: async () => undefined
      }),
      id: () => "attempt-1",
      now: () => 1_000
    });

    await service.submit(input());
    await expect(service.submit(input({ candidateId: "candidate-b" })))
      .rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("replays a Newznab submission that carries an ignored file name", async () => {
    const repository = new MemoryDownloads();
    const service = newznabService(repository);

    const first = await service.submit(input({ submissionKey: "nz-ignored" }));
    const replay = await service.submit(input({
      submissionKey: "nz-ignored",
      fileName: "Game.zip"
    }));

    expect(replay.id).toBe(first.id);
  });

  it("replays a Newznab submission whose first request carried a file name", async () => {
    const repository = new MemoryDownloads();
    const service = newznabService(repository);

    const first = await service.submit(input({
      submissionKey: "nz-dropped",
      fileName: "Game.zip"
    }));
    const replay = await service.submit(input({ submissionKey: "nz-dropped" }));

    expect(replay.id).toBe(first.id);
  });

  it("still matches a legacy Newznab fingerprint written before file selection existed", async () => {
    const repository = new MemoryDownloads();
    const service = newznabService(repository);
    const legacyFingerprint = createHash("sha256")
      .update(JSON.stringify(["candidate-a", 1, 130]))
      .digest("hex");
    repository.attempts.set("legacy", {
      id: "legacy",
      libraryEntryId: "library-1-130",
      submissionKey: "legacy-key",
      requestFingerprint: legacyFingerprint,
      status: "Queued",
      source: "newznab",
      releaseTitle: "Game.NSW-GROUP",
      indexerId: "indexer",
      indexerNameSnapshot: "Indexer",
      indexerUrlSnapshot: "https://indexer.test",
      newznabGuid: "guid",
      iaFileName: null,
      size: 1234,
      category: "games",
      sabnzbdConfigRevision: 1,
      sabMarker: "gamarr-legacy",
      sabJobId: "job",
      progress: 0,
      failureDetail: null,
      sabRequestStartedAt: null,
      createdAt: 1,
      updatedAt: 1,
      completedAt: null
    });

    const replay = await service.submit(input({
      submissionKey: "legacy-key",
      fileName: "Game.zip"
    }));

    expect(replay.id).toBe("legacy");
  });

  it("uses history precedence and never regresses a terminal attempt", async () => {
    const repository = new MemoryDownloads();
    const service = new DownloadService({
      repository,
      candidates,
      settings,
      nzbFetcher: { fetch: async () => new Uint8Array([1]) },
      sabFactory: () => ({
        upload: async () => ({ jobId: "job" }),
        getQueue: async () => [{
          jobId: "job",
          marker: "gamarr-attempt-1",
          status: "Downloading",
          progress: 50
        }],
        getHistory: async () => [{
          jobId: "job",
          marker: "gamarr-attempt-1",
          status: "Completed",
          progress: 100
        }],
        testConnection: async () => undefined
      }),
      id: () => "attempt-1",
      now: () => 2_000
    });
    const queued = await service.submit(input({ submissionKey: "terminal" }));

    const [completed] = await service.reconcile([queued.id]);
    repository.update(queued.id, {
      status: "Completed",
      progress: 100,
      completedAt: 2_000
    });
    const [stillCompleted] = await service.reconcile([queued.id]);

    expect(completed).toMatchObject({ status: "Completed", progress: 100 });
    expect(stillCompleted).toMatchObject({ status: "Completed", progress: 100 });
  });

  const postProcessing = [
    "Queued",
    "QuickCheck",
    "Verifying",
    "Repairing",
    "Fetching",
    "Extracting",
    "Moving",
    "Running"
  ];

  it.each(postProcessing)(
    "leaves an attempt reconcilable while history reports %s",
    async (historyStatus) => {
      const repository = new MemoryDownloads();
      const service = new DownloadService({
        repository,
        candidates,
        settings,
        nzbFetcher: { fetch: async () => new Uint8Array([1]) },
        sabFactory: () => ({
          upload: async () => ({ jobId: "job" }),
          getQueue: async () => [],
          getHistory: async () => [{
            jobId: "job",
            marker: "gamarr-attempt-1",
            status: historyStatus,
            progress: 0
          }],
          testConnection: async () => undefined
        }),
        id: () => "attempt-1",
        now: () => 2_000
      });
      const queued = await service.submit(input({ submissionKey: historyStatus }));

      const [reconciled] = await service.reconcile([queued.id]);

      expect(reconciled).toMatchObject({
        status: "Queued",
        failureDetail: null,
        completedAt: null
      });
    }
  );

  it("completes an attempt that finished post-processing after an earlier poll", async () => {
    const repository = new MemoryDownloads();
    let historyStatus = "Extracting";
    const service = new DownloadService({
      repository,
      candidates,
      settings,
      nzbFetcher: { fetch: async () => new Uint8Array([1]) },
      sabFactory: () => ({
        upload: async () => ({ jobId: "job" }),
        getQueue: async () => [],
        getHistory: async () => [{
          jobId: "job",
          marker: "gamarr-attempt-1",
          status: historyStatus,
          progress: 100
        }],
        testConnection: async () => undefined
      }),
      id: () => "attempt-1",
      now: () => 2_000
    });
    const queued = await service.submit(input({ submissionKey: "post-process" }));

    const [midway] = await service.reconcile([queued.id]);
    historyStatus = "Completed";
    const [settled] = await service.reconcile([queued.id]);

    expect(midway).toMatchObject({ status: "Queued", completedAt: null });
    expect(settled).toMatchObject({
      status: "Completed",
      progress: 100,
      completedAt: 2_000
    });
  });

  it("marks a genuine history failure as Failed", async () => {
    const repository = new MemoryDownloads();
    const service = new DownloadService({
      repository,
      candidates,
      settings,
      nzbFetcher: { fetch: async () => new Uint8Array([1]) },
      sabFactory: () => ({
        upload: async () => ({ jobId: "job" }),
        getQueue: async () => [],
        getHistory: async () => [{
          jobId: "job",
          marker: "gamarr-attempt-1",
          status: "Failed",
          progress: 0
        }],
        testConnection: async () => undefined
      }),
      id: () => "attempt-1",
      now: () => 2_000
    });
    const queued = await service.submit(input({ submissionKey: "real-failure" }));

    const [reconciled] = await service.reconcile([queued.id]);

    expect(reconciled).toMatchObject({
      status: "Failed",
      failureDetail: "Failed",
      completedAt: null
    });
  });

  it("marks a locally rejected upload Failed because nothing was submitted", async () => {
    const repository = new MemoryDownloads();
    const service = new DownloadService({
      repository,
      candidates,
      settings,
      nzbFetcher: { fetch: async () => new Uint8Array([1]) },
      sabFactory: () => ({
        upload: async () => {
          throw validationError("NZB exceeds the configured upload limit");
        },
        getQueue: async () => [],
        getHistory: async () => [],
        testConnection: async () => undefined
      }),
      id: () => "attempt-1",
      now: () => 1_000
    });

    const attempt = await service.submit(input({ submissionKey: "too-large" }));

    expect(attempt).toMatchObject({
      status: "Failed",
      failureDetail: "NZB exceeds the configured upload limit",
      sabJobId: null
    });
  });

  it("marks an upload SABnzbd explicitly rejected as Failed", async () => {
    const repository = new MemoryDownloads();
    const service = new DownloadService({
      repository,
      candidates,
      settings,
      nzbFetcher: { fetch: async () => new Uint8Array([1]) },
      sabFactory: () => ({
        upload: async () => {
          throw new SabnzbdUploadError("rejected", "SABnzbd rejected the upload");
        },
        getQueue: async () => [],
        getHistory: async () => [],
        testConnection: async () => undefined
      }),
      id: () => "attempt-1",
      now: () => 1_000
    });

    const attempt = await service.submit(input({ submissionKey: "rejected" }));

    expect(attempt).toMatchObject({
      status: "Failed",
      failureDetail: "SABnzbd rejected the upload"
    });
  });

  it("keeps a server-side upload failure Unknown because it may have been accepted", async () => {
    const repository = new MemoryDownloads();
    const service = new DownloadService({
      repository,
      candidates,
      settings,
      nzbFetcher: { fetch: async () => new Uint8Array([1]) },
      sabFactory: () => ({
        upload: async () => {
          throw new SabnzbdUploadError(
            "ambiguous",
            "SABnzbd did not confirm the upload"
          );
        },
        getQueue: async () => [],
        getHistory: async () => [],
        testConnection: async () => undefined
      }),
      id: () => "attempt-1",
      now: () => 1_000
    });

    const attempt = await service.submit(input({ submissionKey: "server-error" }));

    expect(attempt).toMatchObject({
      status: "Unknown",
      failureDetail: "SABnzbd acknowledgement was not confirmed"
    });
  });
});

describe("DownloadService Internet Archive submissions", () => {
  const iaCandidate = {
    id: "candidate-ia",
    expiresAt: 99_999,
    source: "internet-archive" as const,
    indexerId: null,
    indexerConfigRevision: 0,
    guid: "game-item",
    title: "Game Name (USA)",
    size: 4096,
    downloadPath: "/details/game-item",
    category: null,
    sourceSnapshot: JSON.stringify({
      indexerName: "Internet Archive",
      identifier: "game-item",
      origin: "https://archive.org"
    }),
    createdAt: 1
  };

  const iaCandidates: CandidateRepository = {
    save: () => undefined,
    get: (id) => id === "candidate-ia" ? iaCandidate : null
  };

  const noSabSettings: SettingsRepository = {
    ...settings,
    getSabnzbd: () => null
  };

  /** File names are matched by exact equality, exactly as the Internet Archive
   * metadata lookup does — the padded entries exist so tests can prove the
   * service never trims a name on its way upstream. */
  const itemFiles = [
    { name: "Game.zip", size: 512 },
    { name: " Game.zip", size: 999 },
    { name: " Game (USA).zip ", size: 777 }
  ];

  const iaPort = (overrides: {
    download?: () => Promise<{ bytes: number; filePath: string }>;
  } = {}) => {
    const calls = {
      downloads: 0,
      fileInfo: 0,
      requestedFileNames: [] as string[],
      downloadedFileNames: [] as string[]
    };
    const port = {
      getFileInfo: async (
        { fileName }: { identifier: string; fileName: string }
      ) => {
        calls.fileInfo += 1;
        calls.requestedFileNames.push(fileName);
        const file = itemFiles.find((value) => value.name === fileName);
        return file
          ? { name: file.name, size: file.size, format: "ZIP", source: "original" }
          : null;
      },
      download: async (input: {
        fileName: string;
        onProgress: (received: number, total: number | null) => void;
      }) => {
        calls.downloads += 1;
        calls.downloadedFileNames.push(input.fileName);
        if (overrides.download) return overrides.download();
        input.onProgress(256, 512);
        input.onProgress(512, 512);
        return { bytes: 512, filePath: "/downloads/game-item/Game.zip" };
      },
      downloadDir: "/downloads",
      maxBytes: 1_048_576
    };
    return { port, calls };
  };

  const iaInput = (overrides: Partial<{
    submissionKey: string;
    fileName: string;
  }> = {}) => ({
    submissionKey: "ia-key",
    candidateId: "candidate-ia",
    gameId: 1,
    platformId: 130,
    fileName: "Game.zip",
    ...overrides
  });

  /** `build` freezes the clock at 1_000, which is younger than the stale
   * window, so no fixture it produces can ever look stale. Tests that exercise
   * recovery or the heartbeat inject their own clock here instead. */
  const buildWithClock = (
    repository: MemoryDownloads,
    port: ReturnType<typeof iaPort>["port"],
    now: () => number,
    extra: {
      scheduleHeartbeat?: (
        callback: () => void,
        intervalMs: number
      ) => () => void;
    } = {}
  ) => new DownloadService({
    repository,
    candidates: iaCandidates,
    settings: noSabSettings,
    nzbFetcher: { fetch: async () => new Uint8Array() },
    sabFactory: () => ({
      upload: async () => {
        throw new Error("SABnzbd must not be used for direct downloads");
      },
      getQueue: async () => [],
      getHistory: async () => [],
      testConnection: async () => undefined
    }),
    internetArchive: port,
    id: () => "attempt-1",
    now,
    ...extra
  });

  const build = (
    repository: MemoryDownloads,
    port: ReturnType<typeof iaPort>["port"]
  ) => buildWithClock(repository, port, () => 1_000);

  it("claims, downloads outside the request, and completes without SABnzbd", async () => {
    const repository = new MemoryDownloads();
    const { port, calls } = iaPort();
    const service = build(repository, port);

    const attempt = await service.submit(iaInput());

    expect(attempt).toMatchObject({
      status: "Downloading",
      source: "internet-archive",
      indexerId: null,
      indexerNameSnapshot: "Internet Archive",
      indexerUrlSnapshot: "https://archive.org",
      iaFileName: "Game.zip",
      sabJobId: null,
      size: 512
    });
    await vi.waitFor(() => {
      expect(repository.get(attempt.id)?.status).toBe("Completed");
    });
    expect(repository.get(attempt.id)).toMatchObject({
      progress: 100,
      size: 512,
      completedAt: 1_000,
      failureDetail: null
    });
    expect(calls.downloads).toBe(1);
  });

  it("marks the attempt Failed when the archive node fails mid-stream", async () => {
    const repository = new MemoryDownloads();
    const { port } = iaPort({
      // AppError, matching what InternetArchiveDownloader actually throws —
      // only those messages are written to be shown to an operator.
      download: async () => {
        throw new AppError(
          "UNAVAILABLE",
          502,
          "Internet Archive file exceeded the size limit"
        );
      }
    });
    const service = build(repository, port);

    const attempt = await service.submit(iaInput({ submissionKey: "ia-fail" }));

    await vi.waitFor(() => {
      expect(repository.get(attempt.id)?.status).toBe("Failed");
    });
    expect(repository.get(attempt.id)?.failureDetail)
      .toBe("Internet Archive file exceeded the size limit");
  });

  it("does not persist the message of a non-AppError failure", async () => {
    const repository = new MemoryDownloads();
    // A raw node:fs error: its message carries the absolute download path, and
    // `failureDetail` is persisted and rendered in Activity. Only AppError
    // messages are written to be seen, so anything else must be replaced.
    const { port } = iaPort({
      download: async () => {
        throw new Error(
          "EACCES: permission denied, mkdir '/config/downloads/game-item'"
        );
      }
    });
    const service = build(repository, port);

    const attempt = await service.submit(iaInput({ submissionKey: "ia-raw" }));

    await vi.waitFor(() => {
      expect(repository.get(attempt.id)?.status).toBe("Failed");
    });
    const detail = repository.get(attempt.id)?.failureDetail;
    expect(detail).toBe("Internet Archive download failed");
    expect(detail).not.toContain("/config/downloads");
    expect(detail).not.toContain("EACCES");
  });

  it("replays the same submission key and conflicts on a different file", async () => {
    const repository = new MemoryDownloads();
    const { port, calls } = iaPort();
    const service = build(repository, port);

    const first = await service.submit(iaInput());
    await vi.waitFor(() => {
      expect(repository.get(first.id)?.status).toBe("Completed");
    });
    const second = await service.submit(iaInput());

    expect(second.id).toBe(first.id);
    expect(calls.downloads).toBe(1);
    await expect(service.submit(iaInput({ fileName: "Other.zip" })))
      .rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("requires a file selection for Internet Archive candidates", async () => {
    const repository = new MemoryDownloads();
    const { port } = iaPort();
    const service = build(repository, port);

    await expect(service.submit({
      submissionKey: "no-file",
      candidateId: "candidate-ia",
      gameId: 1,
      platformId: 130
    })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(service.submit(iaInput({ fileName: "../escape" })))
      .rejects.toMatchObject({ code: "VALIDATION" });
    expect(repository.list()).toHaveLength(0);
  });

  it("rejects a file the item no longer lists before claiming anything", async () => {
    const repository = new MemoryDownloads();
    const { port } = iaPort();
    const service = build(repository, port);

    await expect(service.submit(iaInput({ fileName: "Missing.zip" })))
      .rejects.toMatchObject({
        code: "VALIDATION",
        message: "The selected file is no longer available; search again"
      });
    expect(repository.list()).toHaveLength(0);
  });

  it("uses a listed file name verbatim when it carries surrounding whitespace", async () => {
    const repository = new MemoryDownloads();
    const { port, calls } = iaPort();
    const service = build(repository, port);

    const attempt = await service.submit(iaInput({
      submissionKey: "ia-padded",
      fileName: " Game (USA).zip "
    }));

    expect(calls.requestedFileNames).toEqual([" Game (USA).zip "]);
    expect(attempt).toMatchObject({
      status: "Downloading",
      iaFileName: " Game (USA).zip ",
      size: 777
    });
    await vi.waitFor(() => {
      expect(repository.get(attempt.id)?.status).toBe("Completed");
    });
    expect(calls.downloadedFileNames).toEqual([" Game (USA).zip "]);
  });

  it("rejects a whitespace-only file name before touching the network", async () => {
    const repository = new MemoryDownloads();
    const { port, calls } = iaPort();
    const service = build(repository, port);

    await expect(service.submit(iaInput({ fileName: "   " })))
      .rejects.toMatchObject({ code: "VALIDATION" });
    expect(calls.fileInfo).toBe(0);
    expect(repository.list()).toHaveLength(0);
  });

  it("treats two item files differing only by whitespace as different files", async () => {
    const repository = new MemoryDownloads();
    const { port } = iaPort();
    const service = build(repository, port);

    const padded = await service.submit(iaInput({
      submissionKey: "ia-distinct",
      fileName: " Game.zip"
    }));

    expect(padded).toMatchObject({ iaFileName: " Game.zip", size: 999 });
  });

  it("treats a padded Internet Archive name as a different submission", async () => {
    const repository = new MemoryDownloads();
    const { port } = iaPort();
    const service = build(repository, port);

    await service.submit(iaInput({ submissionKey: "ia-identity" }));

    await expect(service.submit(iaInput({
      submissionKey: "ia-identity",
      fileName: " Game.zip"
    }))).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("conflicts when an Internet Archive key is replayed with no file name", async () => {
    const repository = new MemoryDownloads();
    const { port } = iaPort();
    const service = build(repository, port);

    await service.submit(iaInput({ submissionKey: "ia-nofile" }));

    await expect(service.submit({
      submissionKey: "ia-nofile",
      candidateId: "candidate-ia",
      gameId: 1,
      platformId: 130
    })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("returns Internet Archive attempts from reconcile without SABnzbd settings", async () => {
    const repository = new MemoryDownloads();
    const { port } = iaPort();
    const service = build(repository, port);

    const attempt = await service.submit(iaInput({ submissionKey: "ia-poll" }));
    await vi.waitFor(() => {
      expect(repository.get(attempt.id)?.status).toBe("Completed");
    });

    const [returned] = await service.reconcile([attempt.id]);
    expect(returned).toMatchObject({ id: attempt.id, status: "Completed" });
  });

  const CLOCK = 1_000_000;

  const fixture = (overrides: Partial<DownloadAttempt>): DownloadAttempt => ({
    id: "seeded",
    libraryEntryId: "library",
    submissionKey: "seeded-key",
    requestFingerprint: "fingerprint",
    status: "Downloading",
    source: "internet-archive",
    releaseTitle: "Game",
    indexerId: null,
    indexerNameSnapshot: "Internet Archive",
    indexerUrlSnapshot: "https://archive.org",
    newznabGuid: null,
    iaFileName: "Game.zip",
    size: null,
    category: null,
    sabnzbdConfigRevision: 0,
    sabMarker: "gamarr-seeded",
    sabJobId: null,
    progress: 40,
    failureDetail: null,
    sabRequestStartedAt: null,
    createdAt: 1,
    updatedAt: CLOCK - 120_000,
    completedAt: null,
    ...overrides
  });

  it("fails abandoned Internet Archive downloads without touching live ones", () => {
    const repository = new MemoryDownloads();
    const live = fixture({ id: "ia-live", updatedAt: CLOCK - 1_000 });
    repository.attempts.set("ia-stale", fixture({ id: "ia-stale" }));
    repository.attempts.set("ia-pending", fixture({
      id: "ia-pending",
      status: "Pending"
    }));
    repository.attempts.set("ia-live", live);
    repository.attempts.set("nz-stuck", fixture({
      id: "nz-stuck",
      source: "newznab",
      submissionKey: "nz-key",
      sabMarker: "gamarr-nz"
    }));
    const { port } = iaPort();
    const service = buildWithClock(repository, port, () => CLOCK);

    service.recoverStaleSubmissions();

    expect(repository.get("ia-stale")).toMatchObject({
      status: "Failed",
      failureDetail: "Download was interrupted before completion"
    });
    expect(repository.get("ia-pending")?.status).toBe("Failed");
    // Unchanged object identity of every field: a heartbeat this recent means
    // the stream is alive, so recovery must not write to the row at all.
    expect(repository.get("ia-live")).toEqual(live);
    expect(repository.get("nz-stuck")?.status).toBe("Downloading");
  });

  it("leaves terminal Internet Archive attempts alone during recovery", () => {
    const repository = new MemoryDownloads();
    const completed = fixture({
      id: "ia-done",
      status: "Completed",
      progress: 100,
      completedAt: 5
    });
    const failed = fixture({
      id: "ia-failed",
      status: "Failed",
      failureDetail: "earlier failure"
    });
    repository.attempts.set("ia-done", completed);
    repository.attempts.set("ia-failed", failed);
    const { port } = iaPort();
    const service = buildWithClock(repository, port, () => CLOCK);

    service.recoverStaleSubmissions();

    expect(repository.get("ia-done")).toEqual(completed);
    expect(repository.get("ia-failed")).toEqual(failed);
  });

  it("keeps a streaming download alive across a repeated recovery pass", async () => {
    const repository = new MemoryDownloads();
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { port } = iaPort({
      download: async () => {
        await blocked;
        return { bytes: 512, filePath: "/downloads/game-item/Game.zip" };
      }
    });
    const service = buildWithClock(repository, port, () => CLOCK);

    const attempt = await service.submit(iaInput({ submissionKey: "ia-hmr" }));
    service.recoverStaleSubmissions();

    expect(repository.get(attempt.id)).toMatchObject({
      status: "Downloading",
      failureDetail: null
    });

    release?.();
    await vi.waitFor(() => {
      expect(repository.get(attempt.id)?.status).toBe("Completed");
    });
  });

  it("heartbeats a stalled download that never reports progress", async () => {
    const repository = new MemoryDownloads();
    let clock = CLOCK;
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { port } = iaPort({
      download: async () => {
        await blocked;
        return { bytes: 512, filePath: "/downloads/game-item/Game.zip" };
      }
    });
    let tick: (() => void) | undefined;
    let cancelled = false;
    const service = buildWithClock(repository, port, () => clock, {
      scheduleHeartbeat: (callback) => {
        tick = callback;
        return () => {
          cancelled = true;
        };
      }
    });

    const attempt = await service.submit(iaInput({ submissionKey: "ia-beat" }));
    expect(repository.get(attempt.id)?.updatedAt).toBe(CLOCK);

    clock = CLOCK + 5_000;
    tick?.();

    expect(repository.get(attempt.id)).toMatchObject({
      status: "Downloading",
      progress: 0,
      updatedAt: CLOCK + 5_000
    });

    release?.();
    await vi.waitFor(() => {
      expect(repository.get(attempt.id)?.status).toBe("Completed");
    });
    expect(cancelled).toBe(true);
  });

  it("refuses to move a terminal attempt back to a non-terminal status", () => {
    const repository = new MemoryDownloads();
    const completed = fixture({
      id: "ia-done",
      status: "Completed",
      progress: 100,
      completedAt: 5
    });
    repository.attempts.set("ia-done", completed);

    const result = repository.update("ia-done", {
      status: "Downloading",
      progress: 10
    });

    expect(result).toEqual(completed);
    expect(repository.get("ia-done")).toEqual(completed);
  });
});
