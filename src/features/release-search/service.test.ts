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
  InternetArchiveSearchPort,
  NewznabPort,
  ReleaseCandidateRecord
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
            source: "newznab" as const,
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
          indexerName: "One",
          source: "newznab"
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

  const release = (overrides: Record<string, unknown>) => ({
    guid: "guid",
    title: "Game.Name.NSW-GROUP",
    source: "newznab" as const,
    indexerId: "one",
    indexerName: "One",
    downloadUrl: "https://one.test/api?t=get&id=guid&apikey=secret-one",
    size: 100,
    category: "4050",
    publishedAt: 20,
    ...overrides
  });

  it("drops only the unsafe release from an otherwise healthy indexer", async () => {
    const candidates = new MemoryCandidates();
    const clients: Record<string, NewznabPort> = {
      one: {
        search: async () => ({
          releases: [
            release({ guid: "safe-a", size: 100 }),
            release({
              guid: "safe-b",
              title: "Game.Name.Update.NSW-GROUP",
              size: 200
            }),
            release({
              guid: "unsafe",
              title: "Game.Name.Repack.NSW-GROUP",
              size: 300,
              downloadUrl: "https://cdn.example/get?id=unsafe&apikey=secret-one"
            })
          ],
          warnings: []
        })
      },
      two: {
        search: async () => ({ releases: [], warnings: [] })
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

    expect(response.releases).toHaveLength(2);
    expect(candidates.saved).toHaveLength(2);
    expect(response.warnings).toEqual([{
      indexerId: "one",
      indexerName: "One",
      message: "Ignored 1 release result: unsafe download URL (1 different origin)."
    }]);
    expect(JSON.stringify(response)).not.toContain("secret-one");
    expect(JSON.stringify(response)).not.toContain("cdn.example");
  });

  it("keeps a healthy indexer when another indexer is entirely unsafe", async () => {
    const candidates = new MemoryCandidates();
    const clients: Record<string, NewznabPort> = {
      one: {
        search: async () => ({
          releases: [
            release({
              guid: "creds",
              title: "Game.Name.NSW-GROUP",
              size: 100,
              downloadUrl: "https://user:pass@one.test/api?t=get&id=creds"
            }),
            release({
              guid: "offsite",
              title: "Game.Name.Repack.NSW-GROUP",
              size: 300,
              downloadUrl: "https://cdn.example/get?id=offsite"
            })
          ],
          warnings: []
        })
      },
      two: {
        search: async () => ({
          releases: [release({
            guid: "two-safe",
            title: "Game.Name.Deluxe.NSW-GROUP",
            size: 400,
            indexerId: "two",
            indexerName: "Two",
            downloadUrl: "https://two.test/api?t=get&id=two-safe&apikey=secret-two"
          })],
          warnings: []
        })
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

    expect(response.releases).toHaveLength(1);
    expect(response.releases[0]?.sources).toEqual([{
      candidateId: "candidate-1",
      indexerName: "Two",
      source: "newznab"
    }]);
    expect(response.warnings).toEqual([{
      indexerId: "one",
      indexerName: "One",
      message: "Ignored 2 release results: unsafe download URLs "
        + "(1 credentials or fragment; 1 different origin)."
    }]);
  });

  it("merges Internet Archive items as their own source type", async () => {
    const candidates = new MemoryCandidates();
    let observedTitle = "";
    let nextId = 0;
    const service = new ReleaseSearchService({
      catalog,
      settings,
      candidates,
      clientFactory: () => ({
        search: async () => ({ releases: [], warnings: [] })
      }),
      internetArchive: {
        search: async ({ title }) => {
          observedTitle = title;
          return {
            items: [{
              identifier: "game-name-usa",
              title: "Game Name (USA)",
              detailsUrl: "https://archive.org/details/game-name-usa",
              publishedAt: 30,
              size: 4096,
              downloads: 100
            }],
            warnings: []
          };
        },
        listFiles: async () => []
      },
      id: () => `candidate-${++nextId}`,
      now: () => 1_000
    });

    const response = await service.search({ gameId: 1, platformId: 130 });

    expect(observedTitle).toBe("Game Name");
    expect(response.warnings).toEqual([]);
    expect(response.releases).toEqual([
      expect.objectContaining({
        title: "Game Name (USA)",
        match: "Possible",
        sources: [{
          candidateId: "candidate-1",
          indexerName: "Internet Archive",
          source: "internet-archive"
        }]
      })
    ]);
    expect(candidates.saved[0]).toMatchObject({
      source: "internet-archive",
      indexerId: null,
      guid: "game-name-usa",
      downloadPath: "/details/game-name-usa"
    });
    // The IA candidate carries no indexer URL, credentials, or API key.
    expect(JSON.stringify(response)).not.toContain("apikey");
  });

  it("keeps indexer results when the Internet Archive search fails", async () => {
    const service = new ReleaseSearchService({
      catalog,
      settings,
      candidates: new MemoryCandidates(),
      clientFactory: (indexer) => ({
        search: async () => ({
          releases: indexer.id === "one" ? [release({})] : [],
          warnings: []
        })
      }),
      internetArchive: {
        search: async () => {
          throw new Error("connection refused");
        },
        listFiles: async () => []
      }
    });

    const response = await service.search({ gameId: 1, platformId: 130 });

    expect(response.releases).toHaveLength(1);
    expect(response.releases[0]?.sources[0]?.source).toBe("newznab");
    expect(response.warnings).toEqual([{
      indexerId: "internet-archive",
      indexerName: "Internet Archive",
      message: "Internet Archive search failed"
    }]);
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

  describe("listCandidateFiles", () => {
    const iaCandidate: ReleaseCandidateRecord = {
      id: "candidate-ia",
      expiresAt: 99_999_999_999,
      source: "internet-archive",
      indexerId: null,
      indexerConfigRevision: 0,
      guid: "game-item",
      title: "Game Name (USA)",
      size: 4096,
      downloadPath: "/details/game-item",
      category: null,
      sourceSnapshot: "{}",
      createdAt: 1
    };

    /**
     * A Newznab candidate carrying every value that must never be echoed back:
     * the indexer's private host, its row ID, its guid, and a download path
     * whose `r=` credential survives url-policy's apikey/api_key/key stripping.
     */
    const newznabCandidate: ReleaseCandidateRecord = {
      ...iaCandidate,
      id: "candidate-nzb",
      source: "newznab",
      indexerId: "indexer-secret-id",
      guid: "nzb-guid",
      downloadPath: "/getnzb?id=abc&r=leaked-token",
      sourceSnapshot: JSON.stringify({
        indexerName: "Private Indexer",
        origin: "https://indexer.internal"
      })
    };

    const serviceFor = (
      candidate: ReleaseCandidateRecord | null,
      internetArchive?: Pick<InternetArchiveSearchPort, "listFiles">
    ) => new ReleaseSearchService({
      catalog,
      settings,
      candidates: { save: () => undefined, get: () => candidate },
      clientFactory: () => ({
        search: async () => ({ releases: [], warnings: [] })
      }),
      internetArchive: internetArchive && {
        search: async () => ({ items: [], warnings: [] }),
        listFiles: internetArchive.listFiles
      }
    });

    it("selects the files of the item the candidate points at", async () => {
      const listFiles = vi.fn(async () => [
        { name: "big.zip", size: 20, format: "ZIP", source: "original" },
        { name: "thumb.jpg", size: 99, format: "JPEG", source: "derivative" }
      ]);

      const response = await serviceFor(iaCandidate, { listFiles })
        .listCandidateFiles("candidate-ia");

      // The item is addressed by the candidate's guid, not its ID — passing
      // the ID would silently query a non-existent Internet Archive item.
      expect(listFiles).toHaveBeenCalledWith("game-item");
      expect(response).toEqual({
        files: [{ name: "big.zip", size: 20, format: "ZIP" }]
      });
    });

    // Expiry and absence deliberately collapse into this single 404:
    // `SqliteCandidateRepository.get` filters on
    // `and(eq(id), gt(expiresAt, now()))` and returns null for both, so the
    // endpoint cannot be used as an existence oracle for candidate IDs. The
    // expiry half of that filter is covered by repository.test.ts.
    it("rejects a candidate the repository will not hand back", async () => {
      const service = serviceFor(null, { listFiles: async () => [] });

      await expect(service.listCandidateFiles("candidate-ia")).rejects
        .toMatchObject({
          code: "NOT_FOUND",
          status: 404,
          message: "Release candidate has expired"
        });
    });

    it("rejects a non-Internet-Archive candidate without echoing its secrets", async () => {
      const listFiles = vi.fn(async () => []);
      const service = serviceFor(newznabCandidate, { listFiles });

      const error = await service.listCandidateFiles("candidate-nzb")
        .catch((cause: unknown) => cause);

      expect(error).toMatchObject({
        code: "VALIDATION",
        status: 400,
        message: "Candidate is not an Internet Archive item"
      });
      // Rejected before any upstream call, so nothing derived from the
      // candidate can reach the Internet Archive either.
      expect(listFiles).not.toHaveBeenCalled();
      const message = (error as Error).message;
      expect(message).not.toContain("indexer.internal");
      expect(message).not.toContain("leaked-token");
      expect(message).not.toContain("indexer-secret-id");
      expect(message).not.toContain("nzb-guid");
    });

    it("fails loudly when no Internet Archive source is configured", async () => {
      const service = serviceFor(iaCandidate);

      await expect(service.listCandidateFiles("candidate-ia")).rejects
        .toMatchObject({
          code: "UNAVAILABLE",
          status: 503,
          message: "Internet Archive source is not configured"
        });
    });
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
