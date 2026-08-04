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

describe("rankRelease", () => {
  it("classifies title and selected-platform evidence as strong", () => {
    expect(rankRelease({
      ...baseInput,
      release: {
        guid: "one",
        title: "Game.Name.NSW.2026-GROUP",
        source: "newznab",
        indexerId: "indexer",
        indexerName: "Indexer",
        downloadUrl: "https://indexer.test/get/one",
        size: 100,
        category: "4050",
        publishedAt: 1
      }
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
      release: {
        guid: "two",
        title: "Game.Name.PS5-GROUP",
        source: "newznab",
        indexerId: "indexer",
        indexerName: "Indexer",
        downloadUrl: "https://indexer.test/get/two",
        size: 100,
        category: "5000",
        publishedAt: 1
      }
    })).toMatchObject({
      match: "Conflicting",
      conflictingReasons: ["Conflicting platform: ps5"]
    });
  });
});

describe("deduplicateReleases", () => {
  it("groups duplicate releases while retaining every source", () => {
    const grouped = deduplicateReleases([
      rankRelease({ ...baseInput, release: {
        guid: "guid-a",
        title: "Game.Name.NSW-GROUP",
        source: "newznab",
        indexerId: "a",
        indexerName: "One",
        downloadUrl: "https://one.test/get/a",
        size: 100,
        category: "4050",
        publishedAt: 20
      } }),
      rankRelease({ ...baseInput, release: {
        guid: "guid-b",
        title: "Game Name NSW GROUP",
        source: "newznab",
        indexerId: "b",
        indexerName: "Two",
        downloadUrl: "https://two.test/get/b",
        size: 100,
        category: "4050",
        publishedAt: 10
      } })
    ]);

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
      rankRelease({ ...baseInput, release: {
        guid: "guid-undated",
        title: "Game.Name.NSW-GROUP",
        source: "internet-archive",
        indexerId: "internet-archive",
        indexerName: "Internet Archive",
        downloadUrl: "https://archive.org/details/guid-undated",
        size: 100,
        category: "4050",
        publishedAt: null
      } }),
      rankRelease({ ...baseInput, release: {
        guid: "guid-dated",
        title: "Game.Name.NSW-GROUP",
        source: "newznab",
        indexerId: "indexer",
        indexerName: "Indexer",
        downloadUrl: "https://indexer.test/get/guid-dated",
        size: 200,
        category: "4050",
        publishedAt: 10
      } })
    ]);

    expect(grouped).toHaveLength(2);
    expect(grouped.map((release) => release.guid)).toEqual([
      "guid-dated",
      "guid-undated"
    ]);
  });
});
