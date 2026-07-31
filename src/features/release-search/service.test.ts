import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  GameSearchResult,
  PlatformView
} from "@/features/catalog/models";
import type { CatalogRepository } from "@/features/catalog/ports";
import type { IndexerRecord } from "@/features/settings/models";
import type { SettingsRepository } from "@/features/settings/service";
import type {
  CandidateRepository,
  NewznabPort
} from "@/features/release-search/ports";
import { ReleaseSearchService } from "@/features/release-search/service";

const game: GameSearchResult = {
  id: 1,
  name: "Game Name",
  slug: "game-name",
  summary: null,
  coverUrl: null,
  releaseYear: 2026,
  genres: [],
  alternativeNames: ["Game"],
  platformIds: [130]
};

const selectedPlatform: PlatformView = {
  id: 130,
  name: "Nintendo Switch",
  visible: true,
  aliases: ["switch", "nsw"],
  categoryIds: ["4050"]
};

const catalog: CatalogRepository = {
  listPlatforms: () => [
    selectedPlatform,
    { id: 167, name: "PlayStation 5", visible: true, aliases: ["ps5"] }
  ],
  getPlatform: (id) => id === 130 ? selectedPlatform : null,
  upsertPlatforms: () => undefined,
  setPlatformVisibility: () => undefined,
  upsertGames: () => undefined,
  getGame: (id) => id === 1 ? game : null
};

const indexers: IndexerRecord[] = [
  {
    id: "one",
    name: "One",
    baseUrl: "https://one.test/api",
    apiKey: "secret-one",
    enabled: true,
    categoryIds: ["4050"],
    timeoutMs: 10_000,
    configRevision: 1,
    lastTestStatus: null,
    lastTestedAt: null,
    deletedAt: null,
    createdAt: 1,
    updatedAt: 1
  },
  {
    id: "two",
    name: "Two",
    baseUrl: "https://two.test/api",
    apiKey: "secret-two",
    enabled: true,
    categoryIds: ["4050"],
    timeoutMs: 10_000,
    configRevision: 1,
    lastTestStatus: null,
    lastTestedAt: null,
    deletedAt: null,
    createdAt: 1,
    updatedAt: 1
  }
];

const settings: SettingsRepository = {
  getIgdb: () => null,
  saveIgdb: () => undefined,
  getSabnzbd: () => null,
  saveSabnzbd: () => undefined,
  listIndexers: () => indexers,
  saveIndexer: () => undefined,
  deleteIndexer: () => undefined
};

class MemoryCandidates implements CandidateRepository {
  saved: Parameters<CandidateRepository["save"]>[0][] = [];
  save(value: Parameters<CandidateRepository["save"]>[0]) {
    this.saved.push(value);
  }
  get() {
    return null;
  }
}

describe("ReleaseSearchService", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns partial results, grouped sources, and opaque candidates", async () => {
    const candidates = new MemoryCandidates();
    const clients: Record<string, NewznabPort> = {
      one: {
        search: async () => ({
          releases: [{
            guid: "one-guid",
            title: "Game.Name.NSW-GROUP",
            indexerId: "one",
            indexerName: "One",
            downloadUrl: "https://one.test/api?t=get&id=one-guid&apikey=secret-one",
            size: 100,
            category: "4050",
            publishedAt: 20
          }],
          warnings: []
        })
      },
      two: {
        search: async () => {
          throw new Error("timeout");
        }
      }
    };
    let nextId = 0;
    const service = new ReleaseSearchService({
      catalog,
      settings,
      candidates,
      clientFactory: (indexer) => clients[indexer.id]!,
      id: () => `candidate-${++nextId}`,
      now: () => 1_000
    });

    const response = await service.search({ gameId: 1, platformId: 130 });

    expect(response.releases).toEqual([
      expect.objectContaining({
        match: "Strong",
        sources: [{
          candidateId: "candidate-1",
          indexerName: "One"
        }]
      })
    ]);
    expect(response.warnings).toEqual([
      { indexerId: "two", indexerName: "Two", message: "Indexer search failed" }
    ]);
    expect(JSON.stringify(response)).not.toContain("secret-one");
    expect(JSON.stringify(response)).not.toContain("https://one.test");
    expect(candidates.saved[0]).toMatchObject({
      id: "candidate-1",
      downloadPath: "/api?t=get&id=one-guid",
      expiresAt: 1_801_000
    });
  });

  it("issues one broad canonical-title query per indexer", async () => {
    const observed: Array<{ indexerId: string; term: string }> = [];
    const service = new ReleaseSearchService({
      catalog,
      settings,
      candidates: new MemoryCandidates(),
      clientFactory: (indexer) => ({
        search: async (query) => {
          observed.push({ indexerId: indexer.id, term: query.term });
          return { releases: [], warnings: [] };
        }
      })
    });

    await service.search({ gameId: 1, platformId: 130 });

    expect(observed).toEqual([
      { indexerId: "one", term: "Game Name" },
      { indexerId: "two", term: "Game Name" }
    ]);
  });

  it("scales the deadline for a shared-host Prowlarr queue", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const queuedIndexers = Array.from({ length: 18 }, (_, index) => ({
      ...indexers[0]!,
      id: `indexer-${index + 1}`,
      name: `Indexer ${index + 1}`,
      baseUrl: `https://prowlarr.test/${index + 1}/api`
    }));
    let nextSlotMs = 0;
    let completed = 0;
    const service = new ReleaseSearchService({
      catalog,
      settings: {
        ...settings,
        listIndexers: () => queuedIndexers
      },
      candidates: new MemoryCandidates(),
      clientFactory: () => ({
        search: async (_query, signal) => {
          signal.throwIfAborted();
          nextSlotMs += 2_000;
          const delay = Math.max(0, nextSlotMs + 500 - Date.now());
          return new Promise((resolve, reject) => {
            const requestTimeout = setTimeout(() => {
              clearTimeout(responseTimer);
              reject(new Error("Per-indexer request timed out"));
            }, 10_000);
            const responseTimer = setTimeout(() => {
              clearTimeout(requestTimeout);
              completed += 1;
              resolve({ releases: [], warnings: [] });
            }, delay);
            signal.addEventListener("abort", () => {
              clearTimeout(requestTimeout);
              clearTimeout(responseTimer);
              reject(signal.reason);
            }, { once: true });
          });
        }
      })
    });

    const pending = service.search({ gameId: 1, platformId: 130 });
    await vi.advanceTimersByTimeAsync(37_000);
    const response = await pending;

    expect(completed).toBe(18);
    expect(response.warnings).toEqual([]);
  });

  it("aborts outstanding indexer work at the overall deadline", async () => {
    vi.useFakeTimers();
    let observedAbort = 0;
    const service = new ReleaseSearchService({
      catalog,
      settings,
      candidates: new MemoryCandidates(),
      clientFactory: () => ({
        search: async (_query, signal) => new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            observedAbort += 1;
            reject(signal.reason);
          }, { once: true });
        })
      }),
      overallTimeoutMs: 20_000
    });

    const pending = service.search({ gameId: 1, platformId: 130 });
    await vi.advanceTimersByTimeAsync(20_000);
    const response = await pending;

    expect(observedAbort).toBeGreaterThan(0);
    expect(response.releases).toEqual([]);
    expect(response.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: "Indexer search timed out" })
    ]));
  });
});
