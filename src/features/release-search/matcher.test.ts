import { describe, expect, it } from "vitest";

import {
  deduplicateReleases,
  rankRelease
} from "@/features/release-search/matcher";

const baseInput = {
  canonicalTitle: "Game Name",
  alternativeNames: ["Game"],
  selectedAliases: ["switch", "nsw"],
  conflictingAliases: ["ps5", "xbox"],
  releaseYear: 2026,
  categoryIds: ["4050"]
};

const release = (overrides: Record<string, unknown>) => ({
  guid: "one",
  title: "Game.Name.NSW.2026-GROUP",
  protocol: "torrent" as const,
  indexerId: "indexer",
  indexerName: "Indexer",
  downloadUrl: "https://prowlarr.test/get/one",
  magnetUrl: null,
  seeders: 10,
  peers: 12,
  size: 100,
  category: "4050",
  publishedAt: 1,
  ...overrides
});

describe("rankRelease", () => {
  it("classifies title and selected-platform evidence as strong", () => {
    expect(rankRelease({
      ...baseInput,
      release: release({})
    })).toMatchObject({
      match: "Strong",
      supportingReasons: expect.arrayContaining([
        "Title matches Game Name",
        "Platform matches nsw",
        "Category 4050 matches"
      ]),
      conflictingReasons: []
    });
  });

  it("keeps a conflicting platform visible with a text explanation", () => {
    expect(rankRelease({
      ...baseInput,
      release: release({
        guid: "two",
        title: "Game.Name.PS5-GROUP",
        category: "5000",
        downloadUrl: "https://prowlarr.test/get/two"
      })
    })).toMatchObject({
      match: "Conflicting",
      conflictingReasons: ["Conflicting platform: ps5"]
    });
  });
});

describe("deduplicateReleases", () => {
  it("groups duplicate releases while retaining every source", () => {
    const grouped = deduplicateReleases([
      rankRelease({ ...baseInput, release: release({
        guid: "guid-a",
        title: "Game.Name.NSW-GROUP",
        indexerId: "a",
        indexerName: "One",
        publishedAt: 20
      }) }),
      rankRelease({ ...baseInput, release: release({
        guid: "guid-b",
        title: "Game Name NSW GROUP",
        indexerId: "b",
        indexerName: "Two",
        publishedAt: 10
      }) })
    ], (indexerId) => indexerId === "a" ? 1 : 2);

    expect(grouped).toHaveLength(1);
    expect(grouped[0]?.sources.map((source) => source.indexerName)).toEqual([
      "One",
      "Two"
    ]);
  });

  it("orders an undated release below a dated one at equal score", () => {
    // Sizes differ so the two land in separate dedup groups and the tiebreaker
    // is what decides the order.
    const grouped = deduplicateReleases([
      rankRelease({ ...baseInput, release: release({
        guid: "guid-undated",
        title: "Game.Name.NSW-GROUP",
        indexerId: "undated",
        indexerName: "Undated",
        size: 100,
        publishedAt: null
      }) }),
      rankRelease({ ...baseInput, release: release({
        guid: "guid-dated",
        title: "Game.Name.NSW-GROUP",
        indexerId: "indexer",
        indexerName: "Indexer",
        size: 200,
        publishedAt: 10
      }) })
    ], () => 1);

    expect(grouped).toHaveLength(2);
    expect(grouped.map((release) => release.guid)).toEqual([
      "guid-dated",
      "guid-undated"
    ]);
  });

  it("orders grouped sources by seeders, priority, and published date", () => {
    const priorities = new Map([["a", 20], ["b", 10], ["c", 10], ["d", 1]]);
    const grouped = deduplicateReleases([
      rankRelease({ ...baseInput, release: release({
        guid: "a", indexerId: "a", indexerName: "A", seeders: 50, publishedAt: 100
      }) }),
      rankRelease({ ...baseInput, release: release({
        guid: "b", indexerId: "b", indexerName: "B", seeders: 50, publishedAt: 50
      }) }),
      rankRelease({ ...baseInput, release: release({
        guid: "c", indexerId: "c", indexerName: "C", seeders: 50, publishedAt: 100
      }) }),
      rankRelease({ ...baseInput, release: release({
        guid: "d", indexerId: "d", indexerName: "D", seeders: null, publishedAt: 200
      }) })
    ], (indexerId) => priorities.get(indexerId) ?? Number.MAX_SAFE_INTEGER);

    expect(grouped[0]?.sources.map((source) => source.indexerName))
      .toEqual(["C", "B", "A", "D"]);
  });
});
