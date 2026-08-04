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
    source: "newznab",
    releaseTitle: "Game.NSW",
    indexerId: null,
    indexerNameSnapshot: "Indexer",
    indexerUrlSnapshot: "https://indexer.test",
    newznabGuid: "guid",
    iaFileName: null,
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

  it("fails interrupted Internet Archive downloads without touching others", () => {
    const { database, repository } = setup();
    const claim = (value: DownloadAttempt) => repository.claimSubmission({
      library: {
        id: "library-1-130",
        gameId: 1,
        platformId: 130,
        createdAt: 1,
        updatedAt: 1
      },
      attempt: value
    });
    claim(attempt({
      id: "ia-active",
      submissionKey: "key-ia",
      sabMarker: "gamarr-ia-active",
      source: "internet-archive",
      status: "Downloading",
      iaFileName: "Game.zip",
      progress: 40
    }));
    claim(attempt({
      id: "ia-beating",
      submissionKey: "key-beat",
      sabMarker: "gamarr-ia-beating",
      source: "internet-archive",
      status: "Downloading",
      iaFileName: "Game.zip",
      progress: 40,
      updatedAt: 300
    }));
    claim(attempt({
      id: "nz-active",
      submissionKey: "key-nz",
      sabMarker: "gamarr-nz-active",
      status: "Downloading",
      progress: 40
    }));

    repository.recoverStaleInternetArchiveDownloads(200, 500);

    expect(repository.get("ia-active")).toMatchObject({
      status: "Failed",
      failureDetail: "Download was interrupted before completion",
      updatedAt: 500
    });
    // Heartbeat newer than the cutoff: the stream is still live.
    expect(repository.get("ia-beating")).toMatchObject({
      status: "Downloading",
      failureDetail: null,
      updatedAt: 300
    });
    expect(repository.get("nz-active")?.status).toBe("Downloading");
    database.$client.close();
  });

  it("refuses writes that would move a terminal attempt backwards", () => {
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
        status: "Completed",
        progress: 100,
        completedAt: 50,
        updatedAt: 50
      })
    });

    const returned = repository.update("attempt", {
      status: "Downloading",
      progress: 10,
      completedAt: null,
      updatedAt: 900
    });

    expect(returned).toMatchObject({
      status: "Completed",
      progress: 100,
      completedAt: 50,
      updatedAt: 50
    });
    expect(repository.get("attempt")).toEqual(returned);
    database.$client.close();
  });

  it("refuses a heartbeat-style patch against a terminal attempt", () => {
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
        status: "Failed",
        failureDetail: "earlier failure",
        updatedAt: 50
      })
    });

    repository.update("attempt", { updatedAt: 900 });

    expect(repository.get("attempt")).toMatchObject({
      status: "Failed",
      failureDetail: "earlier failure",
      updatedAt: 50
    });
    database.$client.close();
  });

  it("still advances a non-terminal attempt through the normal lifecycle", () => {
    const { database, repository } = setup();
    repository.claimSubmission({
      library: {
        id: "library-1-130",
        gameId: 1,
        platformId: 130,
        createdAt: 1,
        updatedAt: 1
      },
      attempt: attempt({ status: "Pending" })
    });

    repository.update("attempt", { status: "Downloading", updatedAt: 2 });
    repository.update("attempt", { progress: 40, updatedAt: 3 });
    const completed = repository.update("attempt", {
      status: "Completed",
      progress: 100,
      completedAt: 4,
      updatedAt: 4
    });

    expect(completed).toMatchObject({
      status: "Completed",
      progress: 100,
      completedAt: 4
    });
    database.$client.close();
  });

  it("throws when the attempt row no longer exists", () => {
    const { database, repository } = setup();

    expect(() => repository.update("missing", { progress: 1 })).toThrow();
    database.$client.close();
  });
});
