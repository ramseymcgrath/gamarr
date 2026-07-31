import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createDatabase } from "@/db/client";
import { migrateDatabase } from "@/db/migrate";
import { games, platforms } from "@/db/schema";
import type { DownloadAttempt } from "@/features/downloads/models";
import { SqliteDownloadRepository } from "@/features/downloads/repository";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function setup() {
  const directory = mkdtempSync(path.join(tmpdir(), "gamarr-downloads-"));
  temporaryDirectories.push(directory);
  const database = createDatabase(path.join(directory, "gamarr.db"));
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
  return { database, repository: new SqliteDownloadRepository(database) };
}

function attempt(overrides: Partial<DownloadAttempt> = {}): DownloadAttempt {
  return {
    id: "attempt",
    libraryEntryId: "library-1-130",
    submissionKey: "key",
    requestFingerprint: "fingerprint",
    status: "Pending",
    releaseTitle: "Game.NSW",
    indexerId: null,
    indexerNameSnapshot: "Indexer",
    indexerUrlSnapshot: "https://indexer.test",
    newznabGuid: "guid",
    size: 10,
    category: "games",
    sabnzbdConfigRevision: 1,
    sabMarker: "gamarr-attempt",
    sabJobId: null,
    progress: 0,
    failureDetail: null,
    sabRequestStartedAt: null,
    createdAt: 1,
    updatedAt: 1,
    completedAt: null,
    ...overrides
  };
}

describe("SqliteDownloadRepository", () => {
  it("atomically claims one submission key and returns the winner", () => {
    const { database, repository } = setup();
    const claim = {
      library: {
        id: "library-1-130",
        gameId: 1,
        platformId: 130,
        createdAt: 1,
        updatedAt: 1
      },
      attempt: attempt()
    };

    expect(repository.claimSubmission(claim).created).toBe(true);
    expect(repository.claimSubmission({
      ...claim,
      attempt: attempt({ id: "second" })
    })).toEqual({
      attempt: attempt(),
      created: false
    });
    database.$client.close();
  });

  it("recovers stale Submitting attempts as Unknown", () => {
    const { database, repository } = setup();
    repository.claimSubmission({
      library: {
        id: "library-1-130",
        gameId: 1,
        platformId: 130,
        createdAt: 1,
        updatedAt: 1
      },
      attempt: attempt({
        status: "Submitting",
        sabRequestStartedAt: 100
      })
    });

    repository.recoverStaleSubmitting(200, 300);

    expect(repository.get("attempt")).toMatchObject({
      status: "Unknown",
      updatedAt: 300
    });
    database.$client.close();
  });
});
