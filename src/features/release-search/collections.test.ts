import { describe, expect, it } from "vitest";

import { matchCollectionFiles } from "@/features/release-search/collections";
import type { Collection } from "@/features/release-search/ports";

function collectionOf(names: string[]): Collection {
  return {
    id: "a".repeat(40),
    platformId: 1,
    name: "Pack",
    torrentFileName: "pack.torrent",
    files: names.map((name, index) => ({ index, name, size: 10 + index }))
  };
}

describe("matchCollectionFiles", () => {
  it("matches by title, alternative name and Redump name", () => {
    const collection = collectionOf([
      "Game Name (USA).7z",
      "Short Name (Europe).7z",
      "Redump Title (USA).7z",
      "Other (USA).7z"
    ]);
    expect(
      matchCollectionFiles(
        collection,
        ["Game Name", "Short Name"],
        ["Redump Title"]
      ).map((file) => file.index)
    ).toEqual([0, 1, 2]);
  });

  it("folds & and , The", () => {
    const collection = collectionOf([
      "Ratchet & Clank (USA).7z",
      "Legend of Zelda, The (USA).7z"
    ]);
    expect(
      matchCollectionFiles(
        collection,
        ["Ratchet and Clank", "The Legend of Zelda"],
        []
      ).map((file) => file.index)
    ).toEqual([0, 1]);
  });

  it("keeps both discs", () => {
    const collection = collectionOf([
      "X (USA) (Disc 1).7z",
      "X (USA) (Disc 2).7z"
    ]);
    expect(matchCollectionFiles(collection, ["X"], [])).toHaveLength(2);
  });

  it("does not match a sequel", () => {
    const collection = collectionOf(["Burnout 2 - Point of Impact (USA).7z"]);
    expect(matchCollectionFiles(collection, ["Burnout"], [])).toEqual([]);
  });

  it("caps at 25", () => {
    const collection = collectionOf(
      Array.from({ length: 40 }, (_, i) => `X (Rev ${i}).7z`)
    );
    expect(matchCollectionFiles(collection, ["X"], [])).toHaveLength(25);
  });
});
