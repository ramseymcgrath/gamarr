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
});
