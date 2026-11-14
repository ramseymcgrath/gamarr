import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createDatabase } from "@/db/client";
import { migrateDatabase } from "@/db/migrate";
import {
  downloadAttempts,
  games,
  libraryEntries,
  platforms
} from "@/db/schema";
import { SqliteVerificationRepository } from "@/features/verification/repository";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function setup() {
  const directory = mkdtempSync(path.join(tmpdir(), "gamarr-verification-"));
  temporaryDirectories.push(directory);
  const database = createDatabase(path.join(directory, "gamarr.db"));
  migrateDatabase(database, path.resolve("drizzle"));
  database.insert(games).values({ id: 1, title: "Game", slug: "game", cachedAt: 1 }).run();
  database.insert(platforms).values({ id: 8, name: "PlayStation 2", lastSyncedAt: 1 }).run();
  database.insert(libraryEntries).values({
    id: "library-1-8", gameId: 1, platformId: 8, createdAt: 1, updatedAt: 1
  }).run();
  for (const id of ["attempt-a", "attempt-b"]) {
    database.insert(downloadAttempts).values({
      id,
      libraryEntryId: "library-1-8",
      submissionKey: `key-${id}`,
      requestFingerprint: "fp",
      status: "Completed",
      source: "prowlarr-torrent",
      releaseTitle: "Guitar Hero II",
      indexerNameSnapshot: "Indexer",
      sabnzbdConfigRevision: 1,
      sabMarker: `marker-${id}`,
      progress: 100,
      createdAt: 1,
      updatedAt: 1
    }).run();
  }
  return { database, repository: new SqliteVerificationRepository(database) };
}

describe("SqliteVerificationRepository", () => {
  it("resolves an attempt's platform through its library entry", () => {
    const { repository } = setup();
    expect(repository.target("attempt-a")).toMatchObject({
      platformId: 8,
      attempt: { id: "attempt-a", status: "Completed", marker: "marker-attempt-a" }
    });
    expect(repository.target("missing")).toBeNull();
  });

  it("claims pending rows oldest first, one at a time", () => {
    const { repository } = setup();
    repository.requestPending("attempt-b", 20);
    repository.requestPending("attempt-a", 10);
    expect(repository.claimNextPending(30)?.attemptId).toBe("attempt-a");
    expect(repository.get("attempt-a")?.status).toBe("Running");
    expect(repository.claimNextPending(31)?.attemptId).toBe("attempt-b");
    expect(repository.claimNextPending(32)).toBeNull();
  });

  it("stores a result and clears it when re-requested", () => {
    const { repository } = setup();
    repository.requestPending("attempt-a", 10);
    repository.claimNextPending(11);
    expect(repository.complete("attempt-a", {
      status: "Verified",
      fileName: "Guitar Hero II (USA).iso",
      sha1: "abc",
      serial: "SLUS-21447",
      redumpName: "Guitar Hero II (USA)",
      detail: "Matches Redump"
    }, 12)).toMatchObject({ status: "Verified", checkedAt: 12 });

    expect(repository.requestPending("attempt-a", 13)).toMatchObject({
      status: "Pending",
      fileName: null,
      sha1: null,
      redumpName: null,
      checkedAt: null,
      requestedAt: 13
    });
  });

  it("resets interrupted Running rows to Pending", () => {
    const { repository } = setup();
    repository.requestPending("attempt-a", 10);
    repository.claimNextPending(11);
    expect(repository.resetRunning(12)).toBe(1);
    expect(repository.get("attempt-a")?.status).toBe("Pending");
  });

  it("rejects statuses outside the allowed set", () => {
    const { repository } = setup();
    repository.requestPending("attempt-a", 10);
    expect(() => repository.complete("attempt-a", {
      status: "Bogus" as never,
      fileName: null,
      sha1: null,
      serial: null,
      redumpName: null,
      detail: null
    }, 11)).toThrow();
  });

  it("deletes the verification with its attempt", () => {
    const { database, repository } = setup();
    repository.requestPending("attempt-a", 10);
    database.delete(downloadAttempts).run();
    expect(repository.list()).toEqual([]);
  });
});
