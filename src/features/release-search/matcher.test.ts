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

const serials = {
  serials: ["SLUS-21447", "SLES-54442"],
  gameFor: (serial: string) => ({
    SLUS21447: "Guitar Hero II (USA)",
    SLES54442: "Guitar Hero II (Europe)",
    SLUS21672: "Guitar Hero III - Legends of Rock (USA)"
  })[serial.replace(/[^A-Z0-9]/gi, "").toUpperCase()] ?? null
};

describe("rankRelease platform conflicts", () => {
  const input = {
    ...baseInput,
    canonicalTitle: "Guitar Hero III: Legends of Rock",
    alternativeNames: [],
    releaseYear: null,
    categoryIds: []
  };

  it("flags a release for another console", () => {
    const ranked = rankRelease({
      ...input,
      selectedAliases: ["ps2", "playstation 2"],
      conflictingAliases: ["wii", "wii u", "xbox 360", "xbox"],
      release: release({ title: "Guitar Hero III: Legends of Rock [Wii] [NTSC]", category: null })
    });
    expect(ranked.match).toBe("Conflicting");
    expect(ranked.conflictingReasons).toEqual(["Conflicting platform: wii"]);
  });

  it("names the longest matching platform", () => {
    const ranked = rankRelease({
      ...input,
      selectedAliases: ["ps2"],
      conflictingAliases: ["xbox", "xbox 360"],
      release: release({ title: "Guitar Hero III Legends Of Rock. Xbox 360", category: null })
    });
    expect(ranked.conflictingReasons).toEqual(["Conflicting platform: xbox 360"]);
  });

  it("doesn't treat part of the selected platform's name as another platform", () => {
    const ranked = rankRelease({
      ...input,
      selectedAliases: ["wii u"],
      conflictingAliases: ["wii", "xbox"],
      release: release({ title: "Guitar Hero III Legends of Rock Wii U", category: null })
    });
    expect(ranked.match).toBe("Strong");
  });

  it("doesn't treat a word of the game's name as a platform", () => {
    const ranked = rankRelease({
      ...input,
      canonicalTitle: "Bait and Switch",
      selectedAliases: ["ps2"],
      conflictingAliases: ["switch"],
      release: release({ title: "Bait and Switch PS2", category: null })
    });
    expect(ranked.match).toBe("Strong");
  });
});

describe("rankRelease serials", () => {
  const ps2 = {
    ...baseInput,
    canonicalTitle: "Guitar Hero II",
    alternativeNames: [],
    selectedAliases: ["ps2"],
    conflictingAliases: ["xbox 360"],
    releaseYear: null,
    serials
  };

  it("treats the game's own serial as strong even without the title", () => {
    const ranked = rankRelease({
      ...ps2,
      release: release({ title: "SLUS_214.47 [Redump]", category: null })
    });
    expect(ranked.match).toBe("Strong");
    expect(ranked.supportingReasons).toContain("Serial SLUS-21447 matches");
    expect(ranked.score).toBe(60);
  });

  it("ranks a title-and-serial release above a title-and-platform one", () => {
    const withSerial = rankRelease({
      ...ps2,
      release: release({ title: "Guitar Hero II (Europe) [SLES-54442]", category: null })
    });
    const withPlatform = rankRelease({
      ...ps2,
      release: release({ title: "Guitar Hero II PS2", category: null })
    });
    expect(withSerial.score).toBeGreaterThan(withPlatform.score);
  });

  it("flags another game's serial as conflicting", () => {
    const ranked = rankRelease({
      ...ps2,
      release: release({ title: "Guitar Hero II III Legends SLUS-21672", category: null })
    });
    expect(ranked.match).toBe("Conflicting");
    expect(ranked.conflictingReasons)
      .toEqual(["Serial SLUS-21672 is Guitar Hero III - Legends of Rock (USA)"]);
  });

  it("ignores serial-shaped tokens Redump doesn't know", () => {
    const ranked = rankRelease({
      ...ps2,
      release: release({ title: "Guitar Hero II PS2 ABCD-12345", category: null })
    });
    expect(ranked.match).toBe("Strong");
    expect(ranked.conflictingReasons).toEqual([]);
  });
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

describe("rankRelease preferred source", () => {
  it("boosts a title match from a preferred source above an indexer strong match", () => {
    const indexer = rankRelease({
      ...baseInput,
      release: release({})
    });
    const archive = rankRelease({
      ...baseInput,
      preferredSource: "Internet Archive",
      release: release({ title: "Game Name (USA)", category: null })
    });
    expect(indexer.match).toBe("Strong");
    expect(archive.match).toBe("Possible");
    expect(archive.supportingReasons)
      .toContain("Preferred source: Internet Archive");
    expect(archive.score).toBeGreaterThan(indexer.score);
  });

  it("does not boost a preferred-source release whose title does not match", () => {
    const ranked = rankRelease({
      ...baseInput,
      preferredSource: "Internet Archive",
      release: release({ title: "Unrelated Thing", category: null })
    });
    expect(ranked.score).toBe(0);
    expect(ranked.supportingReasons).toEqual([]);
  });

  it("still sinks a preferred-source release labelled for another platform", () => {
    const ranked = rankRelease({
      ...baseInput,
      preferredSource: "Internet Archive",
      release: release({ title: "Game Name (PS5)", category: null })
    });
    expect(ranked.match).toBe("Conflicting");
    expect(ranked.score).toBeLessThan(50);
  });
});
