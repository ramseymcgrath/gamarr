import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createDatabase, type Database } from "@/db/client";
import { migrateDatabase } from "@/db/migrate";
import {
  downloadAttempts,
  games,
  libraryEntries,
  platforms
} from "@/db/schema";
import { SqliteSwitchLibraryRepository } from "@/features/switch-library/repository";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function repository() {
  const directory = mkdtempSync(path.join(tmpdir(), "gamarr-switchlib-"));
  directories.push(directory);
  const database = createDatabase(path.join(directory, "gamarr.db"));
  migrateDatabase(database, path.resolve("drizzle"));
  return {
    database,
    repository: new SqliteSwitchLibraryRepository(database)
  };
}

function seedAttempt(
  database: Database,
  options: { attemptId: string; gameId: number; title: string }
): void {
  database.insert(platforms)
    .values({ id: 130, name: "Nintendo Switch", lastSyncedAt: 1 })
    .onConflictDoNothing()
    .run();
  database.insert(games)
    .values({ id: options.gameId, title: options.title, slug: `g${options.gameId}`, cachedAt: 1 })
    .run();
  const entryId = `entry-${options.gameId}`;
  database.insert(libraryEntries)
    .values({
      id: entryId,
      gameId: options.gameId,
      platformId: 130,
      createdAt: 1,
      updatedAt: 1
    })
    .run();
  database.insert(downloadAttempts)
    .values({
      id: options.attemptId,
      libraryEntryId: entryId,
      submissionKey: `sub-${options.attemptId}`,
      requestFingerprint: `fp-${options.attemptId}`,
      status: "Completed",
      source: "internet-archive",
      releaseTitle: options.title,
      indexerNameSnapshot: "test",
      sabnzbdConfigRevision: 1,
      sabMarker: `gamarr-${options.attemptId}`,
      createdAt: 1,
      updatedAt: 1
    })
    .run();
}

describe("SqliteSwitchLibraryRepository", () => {
  it("maps a marker to its game title", () => {
    const { database, repository: reader } = repository();
    seedAttempt(database, { attemptId: "abc", gameId: 1, title: "Metroid Prime 4" });

    const titles = reader.titlesByMarker(["gamarr-abc"]);

    expect(titles.get("gamarr-abc")).toBe("Metroid Prime 4");
  });

  it("omits markers with no matching attempt", () => {
    const { database, repository: reader } = repository();
    seedAttempt(database, { attemptId: "abc", gameId: 1, title: "Metroid Prime 4" });

    const titles = reader.titlesByMarker(["gamarr-abc", "gamarr-missing"]);

    expect(titles.has("gamarr-missing")).toBe(false);
    expect(titles.size).toBe(1);
  });

  it("resolves several markers in one call", () => {
    const { database, repository: reader } = repository();
    seedAttempt(database, { attemptId: "one", gameId: 1, title: "Game One" });
    seedAttempt(database, { attemptId: "two", gameId: 2, title: "Game Two" });

    const titles = reader.titlesByMarker(["gamarr-one", "gamarr-two"]);

    expect(titles.get("gamarr-one")).toBe("Game One");
    expect(titles.get("gamarr-two")).toBe("Game Two");
  });

  it("returns an empty map for no markers without querying", () => {
    const { repository: reader } = repository();

    expect(reader.titlesByMarker([]).size).toBe(0);
  });
});
