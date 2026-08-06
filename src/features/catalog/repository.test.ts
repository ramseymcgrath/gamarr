import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createDatabase } from "@/db/client";
import { migrateDatabase } from "@/db/migrate";
import { SqliteCatalogRepository } from "@/features/catalog/repository";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function repository() {
  const directory = mkdtempSync(path.join(tmpdir(), "gamarr-catalog-"));
  temporaryDirectories.push(directory);
  const database = createDatabase(path.join(directory, "gamarr.db"));
  migrateDatabase(database, path.resolve("drizzle"));
  return { database, repository: new SqliteCatalogRepository(database) };
}

describe("SqliteCatalogRepository", () => {
  it("preserves local visibility and aliases while refreshing provider fields", () => {
    const { database, repository: catalog } = repository();
    catalog.upsertPlatforms([
      { id: 130, name: "Switch", abbreviation: "NSW" }
    ], 100);
    catalog.setPlatformVisibility(130, true, ["switch", "nsw"]);

    catalog.upsertPlatforms([
      { id: 130, name: "Nintendo Switch", abbreviation: "Switch" }
    ], 200);

    expect(catalog.getPlatform(130)).toMatchObject({
      name: "Nintendo Switch",
      abbreviation: "Switch",
      visible: true,
      aliases: ["switch", "nsw"],
      lastSyncedAt: 200
    });
    database.$client.close();
  });

  it("round-trips cached games", () => {
    const { database, repository: catalog } = repository();
    catalog.upsertGames([{
      id: 1,
      name: "Game",
      slug: "game",
      summary: "Summary",
      coverUrl: "https://images.test/cover.jpg",
      releaseYear: 2026,
      genres: ["Adventure"],
      alternativeNames: ["Alt Game"],
      platformIds: [130]
    }], 100);

    expect(catalog.getGame(1)).toEqual({
      id: 1,
      name: "Game",
      slug: "game",
      summary: "Summary",
      coverUrl: "https://images.test/cover.jpg",
      releaseYear: 2026,
      genres: ["Adventure"],
      alternativeNames: ["Alt Game"],
      platformIds: [130]
    });
    database.$client.close();
  });

  it("round-trips a popular list in rank order", () => {
    const { database, repository: catalog } = repository();
    catalog.upsertPlatforms([{ id: 130, name: "Switch" }], 100);
    catalog.upsertGames([
      { id: 1, name: "First", slug: "first", summary: null, coverUrl: null,
        releaseYear: null, genres: [], alternativeNames: [], platformIds: [130] },
      { id: 2, name: "Second", slug: "second", summary: null, coverUrl: null,
        releaseYear: null, genres: [], alternativeNames: [], platformIds: [130] },
      { id: 3, name: "Third", slug: "third", summary: null, coverUrl: null,
        releaseYear: null, genres: [], alternativeNames: [], platformIds: [130] }
    ], 100);

    catalog.replacePopular(130, [3, 1, 2], 500);

    expect(catalog.getPopular(130)).toEqual({
      fetchedAt: 500,
      games: [
        expect.objectContaining({ id: 3 }),
        expect.objectContaining({ id: 1 }),
        expect.objectContaining({ id: 2 })
      ]
    });
    database.$client.close();
  });

  it("distinguishes an empty popular list from one never fetched", () => {
    const { database, repository: catalog } = repository();
    catalog.upsertPlatforms([{ id: 130, name: "Switch" }], 100);

    expect(catalog.getPopular(130)).toBeNull();

    catalog.replacePopular(130, [], 500);

    expect(catalog.getPopular(130)).toEqual({ fetchedAt: 500, games: [] });
    database.$client.close();
  });

  it("drops popular ids that are no longer cached games", () => {
    const { database, repository: catalog } = repository();
    catalog.upsertPlatforms([{ id: 130, name: "Switch" }], 100);
    catalog.upsertGames([{
      id: 1, name: "First", slug: "first", summary: null, coverUrl: null,
      releaseYear: null, genres: [], alternativeNames: [], platformIds: [130]
    }], 100);

    catalog.replacePopular(130, [99, 1], 500);

    expect(catalog.getPopular(130)?.games).toEqual([
      expect.objectContaining({ id: 1 })
    ]);
    database.$client.close();
  });

  it("replaces a popular list rather than appending to it", () => {
    const { database, repository: catalog } = repository();
    catalog.upsertPlatforms([{ id: 130, name: "Switch" }], 100);
    catalog.upsertGames([
      { id: 1, name: "First", slug: "first", summary: null, coverUrl: null,
        releaseYear: null, genres: [], alternativeNames: [], platformIds: [130] },
      { id: 2, name: "Second", slug: "second", summary: null, coverUrl: null,
        releaseYear: null, genres: [], alternativeNames: [], platformIds: [130] }
    ], 100);

    catalog.replacePopular(130, [1, 2], 500);
    catalog.replacePopular(130, [2], 900);

    expect(catalog.getPopular(130)).toEqual({
      fetchedAt: 900,
      games: [expect.objectContaining({ id: 2 })]
    });
    database.$client.close();
  });
});
