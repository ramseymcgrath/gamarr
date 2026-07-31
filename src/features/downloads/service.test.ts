import { describe, expect, it } from "vitest";

import type {
  DownloadAttempt,
  SubmissionClaimInput
} from "@/features/downloads/models";
import type { DownloadRepository } from "@/features/downloads/repository";
import { DownloadService } from "@/features/downloads/service";
import type { CandidateRepository } from "@/features/release-search/ports";
import type { SettingsRepository } from "@/features/settings/service";

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
    const value = { ...this.attempts.get(id)!, ...patch };
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
}

const candidate = {
  id: "candidate-a",
  expiresAt: 99_999,
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
}> = {}) => ({
  submissionKey: "same-key",
  candidateId: "candidate-a",
  gameId: 1,
  platformId: 130,
  ...overrides
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
});
