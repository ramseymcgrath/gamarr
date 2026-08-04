import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDatabase, type Database } from "@/db/client";
import { migrateDatabase } from "@/db/migrate";
import { games, platforms } from "@/db/schema";
import type { DownloadAttempt } from "@/features/downloads/models";
import { SqliteDownloadRepository } from "@/features/downloads/repository";

const temporaryDirectories: string[] = [];
const openDatabases: Database[] = [];
let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedEnv = { ...process.env };
});

afterEach(() => {
  process.env = savedEnv;
  for (const database of openDatabases.splice(0)) database.$client.close();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * Points the composition root at an empty directory, exactly as a fresh
 * checkout or the e2e fixture looks before migrations have run, and loads it
 * fresh so its one-shot recovery flag starts unarmed.
 */
async function loadAgainstEmptyDatabase() {
  const directory = mkdtempSync(path.join(tmpdir(), "gamarr-deps-"));
  temporaryDirectories.push(directory);
  const databasePath = path.join(directory, "gamarr.db");
  process.env.GAMARR_DATABASE_PATH = databasePath;
  process.env.GAMARR_ALLOWED_ORIGINS = "http://localhost:3000";
  vi.resetModules();
  const dependencies = await import("@/app/api/downloads/dependencies");
  return { dependencies, databasePath };
}

/** Migrates the file in place through a second connection, the way the e2e
 * global setup does after the dev server has already opened it. */
function migrateInPlace(databasePath: string): Database {
  const database = createDatabase(databasePath);
  openDatabases.push(database);
  migrateDatabase(database, path.resolve("drizzle"));
  database.insert(games).values({
    id: 1,
    title: "Game",
    slug: "game",
    cachedAt: 1
  }).run();
  database.insert(platforms).values({
    id: 130,
    name: "Switch",
    lastSyncedAt: 1
  }).run();
  return database;
}

function seedAbandonedDownload(database: Database, updatedAt: number): void {
  new SqliteDownloadRepository(database).claimSubmission({
    library: {
      id: "library-1-130",
      gameId: 1,
      platformId: 130,
      createdAt: 1,
      updatedAt: 1
    },
    attempt: {
      id: "ia-orphan",
      libraryEntryId: "library-1-130",
      submissionKey: "orphan-key",
      requestFingerprint: "fingerprint",
      status: "Downloading",
      source: "internet-archive",
      releaseTitle: "Game",
      indexerId: null,
      indexerNameSnapshot: "Internet Archive",
      indexerUrlSnapshot: "https://archive.org",
      newznabGuid: null,
      iaFileName: "Game.zip",
      size: null,
      category: null,
      sabnzbdConfigRevision: 0,
      sabMarker: "gamarr-ia-orphan",
      sabJobId: null,
      progress: 40,
      failureDetail: null,
      sabRequestStartedAt: null,
      createdAt: 1,
      updatedAt,
      completedAt: null
    } satisfies DownloadAttempt
  });
}

describe("download composition root recovery", () => {
  it("defers recovery instead of reporting an error when the schema is missing", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { dependencies } = await loadAgainstEmptyDatabase();

    expect(dependencies.recoverDownloadsAtStartup()).toBe(false);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("runs the deferred pass on first use once the schema exists", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { dependencies, databasePath } = await loadAgainstEmptyDatabase();

    expect(dependencies.recoverDownloadsAtStartup()).toBe(false);
    const database = migrateInPlace(databasePath);
    seedAbandonedDownload(database, 1);

    dependencies.downloadDependencies();

    expect(new SqliteDownloadRepository(database).get("ia-orphan")).toMatchObject({
      status: "Failed",
      failureDetail: "Download was interrupted before completion"
    });
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("does not repeat the pass once it has succeeded", async () => {
    const { dependencies, databasePath } = await loadAgainstEmptyDatabase();
    const database = migrateInPlace(databasePath);
    const repository = new SqliteDownloadRepository(database);
    seedAbandonedDownload(database, 1);

    expect(dependencies.recoverDownloadsAtStartup()).toBe(true);
    expect(repository.get("ia-orphan")?.status).toBe("Failed");

    // A second abandoned row appearing after the pass succeeded must be left
    // alone: recovery is one-shot, not per-request work.
    database.$client
      .prepare("update download_attempts set status = 'Downloading' where id = ?")
      .run("ia-orphan");
    dependencies.downloadDependencies();

    expect(repository.get("ia-orphan")?.status).toBe("Downloading");
  });

  it("still surfaces a recovery failure that is not a missing schema", async () => {
    const { dependencies, databasePath } = await loadAgainstEmptyDatabase();
    const database = createDatabase(databasePath);
    openDatabases.push(database);
    // The table exists but is the wrong shape: also a SQLITE_ERROR, and one
    // that must not be mistaken for "migrations have not run yet".
    database.$client.exec("create table download_attempts (id text primary key)");

    expect(() => dependencies.recoverDownloadsAtStartup())
      .toThrow(/no such column/i);
  });
});
