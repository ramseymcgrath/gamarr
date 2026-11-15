import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  GameSearchResult,
  PlatformView
} from "@/features/catalog/models";
import type { CatalogRepository } from "@/features/catalog/ports";
import type { Release } from "@/features/release-search/models";
import type {
  CandidateRepository,
  InternetArchivePort,
  ProwlarrIndexerSummary,
  ProwlarrPort,
  ReleaseCandidateRecord,
  SerialCatalogPort
} from "@/features/release-search/ports";
import {
  intersectCategories,
  ReleaseSearchService
} from "@/features/release-search/service";

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

function catalogFor(platform = selectedPlatform): CatalogRepository {
  return {
    listPlatforms: () => [
      platform,
      { id: 167, name: "PlayStation 5", visible: true, aliases: ["ps5"] }
    ],
    getPlatform: (id) => id === platform.id ? platform : null,
    upsertPlatforms: () => undefined,
    setPlatformVisibility: () => undefined,
    upsertGames: () => undefined,
    getGame: (id) => id === game.id ? game : null,
    getPopular: () => null,
    replacePopular: () => undefined
  };
}

const indexers: ProwlarrIndexerSummary[] = [
  {
    id: "one",
    name: "One",
    protocol: "torrent",
    priority: 25,
    categoryIds: ["4050"]
  },
  {
    id: "two",
    name: "Two",
    protocol: "usenet",
    priority: 10,
    categoryIds: ["4050"]
  }
];

function release(overrides: Partial<Release> = {}): Release {
  return {
    guid: "guid",
    title: "Game.Name.NSW-GROUP",
    protocol: "torrent",
    indexerId: "one",
    indexerName: "One",
    downloadUrl: "https://prowlarr.test/api/v1/indexer/one/download?link=guid",
    magnetUrl: null,
    seeders: 10,
    peers: 12,
    size: 100,
    category: "4050",
    publishedAt: 20,
    ...overrides
  };
}

class MemoryCandidates implements CandidateRepository {
  readonly saved: ReleaseCandidateRecord[] = [];

  constructor(private readonly found: ReleaseCandidateRecord | null = null) {}

  save(value: ReleaseCandidateRecord): void {
    this.saved.push(value);
  }

  get(): ReleaseCandidateRecord | null {
    return this.found;
  }
}

function prowlarrFor(input: {
  indexers?: ProwlarrIndexerSummary[];
  listIndexers?: ProwlarrPort["listIndexers"];
  search?: ProwlarrPort["search"];
} = {}): ProwlarrPort {
  return {
    listIndexers: input.listIndexers
      ?? (async () => input.indexers ?? indexers),
    search: input.search
      ?? (async () => ({ releases: [], warnings: [] }))
  };
}

function serviceFor(input: {
  catalog?: CatalogRepository;
  candidates?: CandidateRepository;
  prowlarr?: ProwlarrPort;
  internetArchive?: InternetArchivePort | null;
  serialCatalog?: SerialCatalogPort | null;
  serialLookupTimeoutMs?: number;
  fetch?: (input: {
    candidate: ReleaseCandidateRecord;
    magnetUrl: string | null;
    maxBytes: number;
  }) => Promise<
    | { kind: "nzb"; bytes: Uint8Array }
    | { kind: "torrent"; bytes: Uint8Array }
    | { kind: "magnet"; uri: string }
  >;
  usenetClientConfigured?: boolean;
  torrentClientConfigured?: boolean;
  overallTimeoutMs?: number;
  id?: () => string;
} = {}): ReleaseSearchService {
  return new ReleaseSearchService({
    catalog: input.catalog ?? catalogFor(),
    candidates: input.candidates ?? new MemoryCandidates(),
    prowlarr: input.prowlarr ?? prowlarrFor(),
    internetArchive: input.internetArchive ?? null,
    serialCatalog: input.serialCatalog ?? null,
    serialLookupTimeoutMs: input.serialLookupTimeoutMs,
    prowlarrBaseUrl: "https://prowlarr.test/root",
    prowlarrConfigRevision: 7,
    fetcher: {
      fetch: input.fetch ?? (async () => ({
        kind: "torrent" as const,
        bytes: new Uint8Array()
      }))
    },
    maxTorrentBytes: 8 * 1024 * 1024,
    usenetClientConfigured: () => input.usenetClientConfigured ?? false,
    torrentClientConfigured: () => input.torrentClientConfigured ?? false,
    now: () => 1_000,
    id: input.id,
    overallTimeoutMs: input.overallTimeoutMs
  });
}

describe("intersectCategories", () => {
  it("keeps only exact categories an indexer advertises", () => {
    expect(intersectCategories(["4050", "5000"], ["4050", "7000"]))
      .toEqual(["4050"]);
  });

  it("matches block roots in either direction", () => {
    expect(intersectCategories(["1000", "4050"], ["1010", "4000"]))
      .toEqual(["1000", "4050"]);
  });
});

describe("ReleaseSearchService", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("searches every enabled indexer", async () => {
    const searched: string[] = [];
    const service = serviceFor({
      prowlarr: prowlarrFor({
        search: async (indexer) => {
          searched.push(indexer.id);
          return { releases: [], warnings: [] };
        }
      })
    });

    await service.search({ gameId: 1, platformId: 130 });

    expect(searched.sort()).toEqual(["one", "two"]);
  });

  it("surfaces a 502 when discovery fails", async () => {
    const service = serviceFor({
      prowlarr: prowlarrFor({
        listIndexers: async () => {
          throw new Error("upstream included prowlarr-secret-key");
        }
      })
    });

    await expect(service.search({ gameId: 1, platformId: 130 })).rejects
      .toMatchObject({
        code: "UNAVAILABLE",
        status: 502,
        message: "Prowlarr is unavailable"
      });
  });

  it("keeps other indexers' results when one search fails", async () => {
    const service = serviceFor({
      prowlarr: prowlarrFor({
        search: async (indexer) => {
          if (indexer.id === "two") throw new Error("unavailable");
          return { releases: [release()], warnings: [] };
        }
      })
    });

    const response = await service.search({ gameId: 1, platformId: 130 });

    expect(response.releases).toHaveLength(1);
    expect(response.releases[0]?.sources[0]?.indexerName).toBe("One");
  });

  it("reports a warning naming the failed indexer", async () => {
    const service = serviceFor({
      prowlarr: prowlarrFor({
        search: async (indexer) => {
          if (indexer.id === "two") throw new Error("unavailable");
          return { releases: [], warnings: [] };
        }
      })
    });

    const response = await service.search({ gameId: 1, platformId: 130 });

    expect(response.warnings).toContainEqual({
      indexerId: "two",
      indexerName: "Two",
      message: "Indexer search failed"
    });
  });

  it("sends only categories the indexer advertises", async () => {
    const observed: string[][] = [];
    const service = serviceFor({
      catalog: catalogFor({ ...selectedPlatform, categoryIds: ["4050", "5000"] }),
      prowlarr: prowlarrFor({
        indexers: [{ ...indexers[0]!, categoryIds: ["4050", "7000"] }],
        search: async (_indexer, query) => {
          observed.push(query.categories);
          return { releases: [], warnings: [] };
        }
      })
    });

    await service.search({ gameId: 1, platformId: 130 });

    expect(observed).toEqual([["4050"]]);
  });

  it("treats a thousand-block root as satisfied by a member category", async () => {
    const observed: string[][] = [];
    const service = serviceFor({
      catalog: catalogFor({ ...selectedPlatform, categoryIds: ["1000"] }),
      prowlarr: prowlarrFor({
        indexers: [{ ...indexers[0]!, categoryIds: ["1010"] }],
        search: async (_indexer, query) => {
          observed.push(query.categories);
          return { releases: [], warnings: [] };
        }
      })
    });

    await service.search({ gameId: 1, platformId: 130 });

    expect(observed).toEqual([["1000"]]);
  });

  it("omits categories entirely when the intersection is empty", async () => {
    const observed: string[][] = [];
    const service = serviceFor({
      prowlarr: prowlarrFor({
        indexers: [{ ...indexers[0]!, categoryIds: ["5000"] }],
        search: async (_indexer, query) => {
          observed.push(query.categories);
          return { releases: [], warnings: [] };
        }
      })
    });

    await service.search({ gameId: 1, platformId: 130 });

    expect(observed).toEqual([[]]);
  });

  it("orders sources within a group by seeders, then priority, then date", async () => {
    const orderedIndexers: ProwlarrIndexerSummary[] = [
      { id: "a", name: "A", protocol: "torrent", priority: 20, categoryIds: [] },
      { id: "b", name: "B", protocol: "torrent", priority: 10, categoryIds: [] },
      { id: "c", name: "C", protocol: "torrent", priority: 10, categoryIds: [] },
      { id: "d", name: "D", protocol: "torrent", priority: 1, categoryIds: [] }
    ];
    const byId: Record<string, Release> = {
      a: release({ guid: "a", indexerId: "a", indexerName: "A", seeders: 50, publishedAt: 100 }),
      b: release({ guid: "b", indexerId: "b", indexerName: "B", seeders: 50, publishedAt: 50 }),
      c: release({ guid: "c", indexerId: "c", indexerName: "C", seeders: 50, publishedAt: 100 }),
      d: release({ guid: "d", indexerId: "d", indexerName: "D", seeders: null, publishedAt: 200 })
    };
    const service = serviceFor({
      prowlarr: prowlarrFor({
        indexers: orderedIndexers,
        search: async (indexer) => ({ releases: [byId[indexer.id]!], warnings: [] })
      })
    });

    const response = await service.search({ gameId: 1, platformId: 130 });

    expect(response.releases).toHaveLength(1);
    expect(response.releases[0]?.sources.map((source) => source.indexerName))
      .toEqual(["C", "B", "A", "D"]);
  });

  it("persists the protocol on each candidate", async () => {
    const candidates = new MemoryCandidates();
    let nextId = 0;
    const service = serviceFor({
      candidates,
      id: () => `candidate-${++nextId}`,
      prowlarr: prowlarrFor({
        search: async (indexer) => ({
          releases: [release({
            guid: indexer.id,
            title: `Game.Name.NSW.${indexer.id}`,
            protocol: indexer.protocol,
            indexerId: indexer.id,
            indexerName: indexer.name,
            size: indexer.id === "one" ? 100 : 200
          })],
          warnings: []
        })
      })
    });

    await service.search({ gameId: 1, platformId: 130 });

    expect(candidates.saved.map((candidate) => ({
      protocol: candidate.protocol,
      revision: candidate.indexerConfigRevision
    }))).toEqual([
      { protocol: "torrent", revision: 7 },
      { protocol: "usenet", revision: 7 }
    ]);
  });

  it("persists torrent health and magnet metadata on the candidate", async () => {
    const candidates = new MemoryCandidates();
    const magnetUrl = "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567";
    const service = serviceFor({
      candidates,
      prowlarr: prowlarrFor({
        indexers: [indexers[0]!],
        search: async () => ({
          releases: [release({ seeders: 42, magnetUrl })],
          warnings: []
        })
      })
    });

    await service.search({ gameId: 1, platformId: 130 });

    expect(candidates.saved[0]?.seeders).toBe(42);
    expect(JSON.parse(candidates.saved[0]!.sourceSnapshot)).toEqual({
      indexerName: "One",
      origin: "https://prowlarr.test",
      magnetUrl
    });
  });

  it("returns protocol and seeders for each public source", async () => {
    const service = serviceFor({
      prowlarr: prowlarrFor({
        indexers: [indexers[0]!],
        search: async () => ({
          releases: [release({ protocol: "torrent", seeders: 42 })],
          warnings: []
        })
      })
    });

    const response = await service.search({ gameId: 1, platformId: 130 });

    expect(response.releases[0]?.sources[0]).toMatchObject({
      protocol: "torrent",
      seeders: 42
    });
  });

  it("reports which download clients are configured", async () => {
    const service = serviceFor({
      usenetClientConfigured: true,
      torrentClientConfigured: false
    });

    const response = await service.search({ gameId: 1, platformId: 130 });

    expect(response).toMatchObject({
      usenetClientConfigured: true,
      torrentClientConfigured: false
    });
  });

  it("drops a release whose download URL leaves the Prowlarr origin", async () => {
    const candidates = new MemoryCandidates();
    const service = serviceFor({
      candidates,
      prowlarr: prowlarrFor({
        indexers: [indexers[0]!],
        search: async () => ({
          releases: [release({ downloadUrl: "https://tracker.test/download?id=guid" })],
          warnings: []
        })
      })
    });

    const response = await service.search({ gameId: 1, platformId: 130 });

    expect(response.releases).toEqual([]);
    expect(candidates.saved).toEqual([]);
    expect(response.warnings[0]?.message).toMatch(/different origin/);
  });

  it("never includes the api key in an unsafe-url warning", async () => {
    const apiKey = "prowlarr-secret-key";
    const service = serviceFor({
      prowlarr: prowlarrFor({
        indexers: [indexers[0]!],
        search: async () => ({
          releases: [release({
            downloadUrl: `https://tracker.test/download?apikey=${apiKey}`
          })],
          warnings: []
        })
      })
    });

    const response = await service.search({ gameId: 1, platformId: 130 });

    expect(response.warnings).toHaveLength(1);
    expect(JSON.stringify(response)).not.toContain(apiKey);
    expect(JSON.stringify(response)).not.toContain("tracker.test");
  });

  it("keeps a torrent whose enclosure is a feed-supplied magnet", async () => {
    const candidates = new MemoryCandidates();
    const magnetUrl = "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567";
    const service = serviceFor({
      candidates,
      prowlarr: prowlarrFor({
        indexers: [indexers[0]!],
        search: async () => ({
          releases: [release({ downloadUrl: magnetUrl, magnetUrl })],
          warnings: []
        })
      })
    });

    const response = await service.search({ gameId: 1, platformId: 130 });

    expect(response.releases).toHaveLength(1);
    expect(candidates.saved).toHaveLength(1);
    expect(JSON.parse(candidates.saved[0]!.sourceSnapshot).magnetUrl)
      .toBe(magnetUrl);
    expect(candidates.saved[0]!.downloadPath).not.toContain(magnetUrl);
  });

  it("keeps seeders out of the match ranking", async () => {
    const service = serviceFor({
      prowlarr: prowlarrFor({
        indexers: [indexers[0]!],
        search: async () => ({
          releases: [
            release({ guid: "low", title: "Game.Name.NSW.Low", size: 100, seeders: 1 }),
            release({ guid: "high", title: "Game.Name.NSW.High", size: 200, seeders: 10_000 })
          ],
          warnings: []
        })
      })
    });

    const response = await service.search({ gameId: 1, platformId: 130 });

    expect(response.releases.map(({ match, score }) => ({ match, score })))
      .toEqual([
        { match: "Strong", score: 90 },
        { match: "Strong", score: 90 }
      ]);
  });

  it("scales the deadline with the discovered indexer count", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const queuedIndexers = Array.from({ length: 18 }, (_, index) => ({
      ...indexers[0]!,
      id: `indexer-${index + 1}`,
      name: `Indexer ${index + 1}`
    }));
    let nextSlotMs = 0;
    let completed = 0;
    const service = serviceFor({
      prowlarr: prowlarrFor({
        indexers: queuedIndexers,
        search: async (_indexer, _query, signal) => {
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
    const torrentCandidate: ReleaseCandidateRecord = {
      id: "candidate-torrent",
      expiresAt: 99_999_999_999,
      protocol: "torrent",
      indexerId: "one",
      indexerConfigRevision: 7,
      guid: "torrent-guid",
      title: "Game Name",
      size: 1_024,
      seeders: 12,
      downloadPath: "/api/v1/indexer/one/download?link=torrent-guid",
      category: "4050",
      sourceSnapshot: JSON.stringify({
        indexerName: "One",
        origin: "https://prowlarr.test",
        magnetUrl: null
      }),
      createdAt: 1
    };

    it("lists a torrent's files from metainfo", async () => {
      const metainfo = new TextEncoder().encode(
        "d4:infod5:filesld6:lengthi10e4:pathl5:a.xciee"
        + "d6:lengthi20e4:pathl3:sub5:b.xcieee"
        + "4:name10:Collectionee"
      );
      const fetch = vi.fn(async () => ({
        kind: "torrent" as const,
        bytes: metainfo
      }));
      const service = serviceFor({
        candidates: new MemoryCandidates(torrentCandidate),
        fetch
      });

      const response = await service.listCandidateFiles("candidate-torrent");

      expect(response).toEqual({
        files: [
          { index: 0, name: "Collection/a.xci", size: 10 },
          { index: 1, name: "Collection/sub/b.xci", size: 20 }
        ],
        metadataPending: false
      });
      expect(fetch).toHaveBeenCalledWith({
        candidate: torrentCandidate,
        magnetUrl: null,
        maxBytes: 8 * 1024 * 1024
      });
    });

    it("reports metadataPending for a magnet candidate", async () => {
      const magnetUrl = "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567";
      const candidate = {
        ...torrentCandidate,
        sourceSnapshot: JSON.stringify({
          indexerName: "One",
          origin: "https://prowlarr.test",
          magnetUrl
        })
      };
      const fetch = vi.fn(async () => ({ kind: "magnet" as const, uri: magnetUrl }));
      const service = serviceFor({
        candidates: new MemoryCandidates(candidate),
        fetch
      });

      const response = await service.listCandidateFiles("candidate-torrent");

      expect(response).toEqual({ files: [], metadataPending: true });
      expect(fetch).toHaveBeenCalledWith(expect.objectContaining({ magnetUrl }));
    });

    it("rejects a usenet candidate", async () => {
      const fetch = vi.fn();
      const service = serviceFor({
        candidates: new MemoryCandidates({
          ...torrentCandidate,
          protocol: "usenet"
        }),
        fetch
      });

      await expect(service.listCandidateFiles("candidate-usenet")).rejects
        .toMatchObject({ code: "VALIDATION", status: 400 });
      expect(fetch).not.toHaveBeenCalled();
    });

    it("returns 404 for an expired candidate", async () => {
      const service = serviceFor({ candidates: new MemoryCandidates(null) });

      await expect(service.listCandidateFiles("expired")).rejects.toMatchObject({
        code: "NOT_FOUND",
        status: 404,
        message: "Release candidate has expired"
      });
    });
  });
});

describe("ReleaseSearchService Internet Archive source", () => {
  const iaItem = {
    identifier: "game-name-switch",
    title: "Game Name",
    detailsUrl: "https://archive.org/details/game-name-switch",
    torrentUrl:
      "https://archive.org/download/game-name-switch/game-name-switch_archive.torrent",
    publishedAt: 5,
    size: 400
  };

  function internetArchiveFor(
    search: InternetArchivePort["search"]
  ): InternetArchivePort {
    return { search };
  }

  it("ranks a title-matched archive item above a strong indexer release", async () => {
    const candidates = new MemoryCandidates();
    let next = 0;
    const result = await serviceFor({
      candidates,
      id: () => `candidate-${(next += 1)}`,
      prowlarr: prowlarrFor({
        indexers: [indexers[0]!],
        search: async () => ({ releases: [release()], warnings: [] })
      }),
      internetArchive: internetArchiveFor(async () => ({
        items: [iaItem],
        warnings: []
      }))
    }).search({ gameId: 1, platformId: 130 });

    expect(result.releases.map((entry) => entry.sources[0]?.indexerName))
      .toEqual(["Internet Archive", "One"]);
    expect(result.releases[0]).toMatchObject({
      title: "Game Name",
      match: "Possible",
      supportingReasons: expect.arrayContaining([
        "Preferred source: Internet Archive"
      ])
    });
    expect(result.releases[0]!.score)
      .toBeGreaterThan(result.releases[1]!.score);
  });

  it("persists the identifier and canonical path, never a data-node URL", async () => {
    const candidates = new MemoryCandidates();
    await serviceFor({
      candidates,
      id: () => "ia-candidate",
      prowlarr: prowlarrFor({ indexers: [] }),
      internetArchive: internetArchiveFor(async () => ({
        items: [iaItem],
        warnings: []
      }))
    }).search({ gameId: 1, platformId: 130 });

    expect(candidates.saved).toHaveLength(1);
    expect(candidates.saved[0]).toMatchObject({
      id: "ia-candidate",
      protocol: "torrent",
      indexerId: "internet-archive",
      indexerConfigRevision: 7,
      guid: "https://archive.org/details/game-name-switch",
      downloadPath: "/download/game-name-switch/game-name-switch_archive.torrent"
    });
    expect(JSON.parse(candidates.saved[0]!.sourceSnapshot)).toEqual({
      indexerName: "Internet Archive",
      origin: "https://archive.org",
      identifier: "game-name-switch",
      magnetUrl: null
    });
  });

  it("isolates an archive failure as a warning beside indexer results", async () => {
    const result = await serviceFor({
      prowlarr: prowlarrFor({
        indexers: [indexers[0]!],
        search: async () => ({ releases: [release()], warnings: [] })
      }),
      internetArchive: internetArchiveFor(async () => {
        throw new Error("upstream said https://secret.example/?key=1");
      })
    }).search({ gameId: 1, platformId: 130 });

    expect(result.releases).toHaveLength(1);
    expect(result.warnings).toEqual([{
      indexerId: "internet-archive",
      indexerName: "Internet Archive",
      message: "Internet Archive search failed"
    }]);
  });

  it("passes adapter AppError messages and item warnings through", async () => {
    const { AppError } = await import("@/lib/errors");
    const failing = await serviceFor({
      prowlarr: prowlarrFor({ indexers: [] }),
      internetArchive: internetArchiveFor(async () => {
        throw new AppError(
          "UNAVAILABLE",
          503,
          "Internet Archive is rate limiting requests; try again later"
        );
      })
    }).search({ gameId: 1, platformId: 130 });
    expect(failing.warnings[0]?.message)
      .toBe("Internet Archive is rate limiting requests; try again later");

    const partial = await serviceFor({
      prowlarr: prowlarrFor({ indexers: [] }),
      internetArchive: internetArchiveFor(async () => ({
        items: [],
        warnings: ["Ignored an Internet Archive result with missing or unsafe fields"]
      }))
    }).search({ gameId: 1, platformId: 130 });
    expect(partial.warnings[0]?.indexerName).toBe("Internet Archive");
  });

  it("searches the archive with the catalog title and the shared abort signal", async () => {
    const search = vi.fn<InternetArchivePort["search"]>(async () => ({
      items: [],
      warnings: []
    }));
    await serviceFor({
      prowlarr: prowlarrFor({ indexers: [] }),
      internetArchive: internetArchiveFor(search)
    }).search({ gameId: 1, platformId: 130 });

    expect(search).toHaveBeenCalledWith(
      { title: "Game Name" },
      expect.any(AbortSignal)
    );
  });

  it("makes no archive request when the source is disabled", async () => {
    const result = await serviceFor({
      prowlarr: prowlarrFor({ indexers: [] }),
      internetArchive: null
    }).search({ gameId: 1, platformId: 130 });
    expect(result.releases).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});

describe("ReleaseSearchService serial search", () => {
  const serialCatalog: SerialCatalogPort = {
    lookup: async (platformId, titles) => {
      expect(platformId).toBe(130);
      expect(titles).toEqual(["Game Name", "Game"]);
      return {
        serials: ["SLUS-21447", "SLES-54442"],
        gameFor: (serial) => serial.replace(/\W/g, "") === "SLUS21672"
          ? "Other Game (USA)"
          : null
      };
    }
  };

  it("also searches each indexer by the preferred serial and ranks by it", async () => {
    const terms: string[] = [];
    const service = serviceFor({
      serialCatalog,
      prowlarr: prowlarrFor({
        indexers: [indexers[0]!],
        search: async (_indexer, query) => {
          terms.push(`${query.reason}:${query.term}`);
          return {
            releases: query.reason === "serial"
              ? [release({ guid: "serial", title: "SLUS-21447 dump", size: 300 })]
              : [
                  release({ guid: "plain", title: "Game.Name-GROUP", size: 200, category: null }),
                  release({ guid: "other", title: "Game Name SLUS-21672", size: 400 })
                ],
            warnings: []
          };
        }
      })
    });

    const response = await service.search({ gameId: 1, platformId: 130 });
    expect(terms.sort()).toEqual(["canonical:Game Name", "serial:SLUS-21447"]);
    expect(response.searchedSerial).toBe("SLUS-21447");
    expect(response.releases.map((entry) => [entry.title, entry.match])).toEqual([
      ["SLUS-21447 dump", "Strong"],
      ["Game.Name-GROUP", "Possible"],
      ["Game Name SLUS-21672", "Conflicting"]
    ]);
  });

  it("doesn't send the serial query to usenet indexers", async () => {
    const terms: string[] = [];
    const response = await serviceFor({
      serialCatalog,
      prowlarr: prowlarrFor({
        indexers: [indexers[1]!],
        search: async (_indexer, query) => {
          terms.push(query.term);
          return { releases: [], warnings: [] };
        }
      })
    }).search({ gameId: 1, platformId: 130 });
    expect(terms).toEqual(["Game Name"]);
    expect(response.searchedSerial).toBe("SLUS-21447");
  });

  it("searches by title alone when the lookup fails or stalls", async () => {
    const terms: string[] = [];
    const prowlarr = prowlarrFor({
      indexers: [indexers[0]!],
      search: async (_indexer, query) => {
        terms.push(query.term);
        return { releases: [], warnings: [] };
      }
    });
    const failing = await serviceFor({
      prowlarr,
      serialCatalog: { lookup: async () => { throw new Error("offline"); } }
    }).search({ gameId: 1, platformId: 130 });
    const stalled = await serviceFor({
      prowlarr,
      serialLookupTimeoutMs: 10,
      serialCatalog: { lookup: () => new Promise(() => undefined) }
    }).search({ gameId: 1, platformId: 130 });
    expect(terms).toEqual(["Game Name", "Game Name"]);
    expect(failing.searchedSerial).toBeNull();
    expect(stalled.searchedSerial).toBeNull();
    expect(failing.warnings).toEqual([]);
  });

  it("keeps title results when only the serial query fails", async () => {
    const response = await serviceFor({
      serialCatalog,
      prowlarr: prowlarrFor({
        indexers: [indexers[0]!],
        search: async (_indexer, query) => {
          if (query.reason === "serial") throw new Error("rate limited");
          return { releases: [release()], warnings: [] };
        }
      })
    }).search({ gameId: 1, platformId: 130 });
    expect(response.releases).toHaveLength(1);
    expect(response.warnings).toEqual([]);
  });
});
