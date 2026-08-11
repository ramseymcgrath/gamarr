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
    torrentHash: null,
    selectedFiles: null,
    filesAppliedAt: null,
    size: 10,
    category: "games",
    sabnzbdConfigRevision: 1,
    marker: "gamarr-attempt",
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

const library = {
  id: "library-1-130",
  gameId: 1,
  platformId: 130,
  createdAt: 1,
  updatedAt: 1
};

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

  it("fails every non-terminal legacy Internet Archive download", () => {
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
      id: "ia-unknown",
      submissionKey: "key-ia-unknown",
      marker: "gamarr-ia-unknown",
      source: "internet-archive",
      status: "Unknown",
      iaFileName: "Game.zip",
      progress: 40
    }));
    claim(attempt({
      id: "ia-fresh",
      submissionKey: "key-ia-fresh",
      marker: "gamarr-ia-fresh",
      source: "internet-archive",
      status: "Downloading",
      iaFileName: "Game.zip",
      progress: 40,
      updatedAt: 300
    }));
    claim(attempt({
      id: "nz-active",
      submissionKey: "key-nz",
      marker: "gamarr-nz-active",
      status: "Downloading",
      progress: 40
    }));

    repository.recoverStaleInternetArchiveDownloads(500);

    expect(repository.get("ia-unknown")).toMatchObject({
      status: "Failed",
      failureDetail: "The direct download path was removed",
      updatedAt: 500
    });
    expect(repository.get("ia-fresh")).toMatchObject({
      status: "Failed",
      failureDetail: "The direct download path was removed",
      updatedAt: 500
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

  it("round-trips a torrent attempt's source and hash", () => {
    const { database, repository } = setup();
    repository.claimSubmission({
      library,
      attempt: attempt({
        source: "internet-archive-torrent",
        newznabGuid: null,
        indexerUrlSnapshot: null,
        sabnzbdConfigRevision: 0,
        torrentHash: null
      })
    });
    const updated = repository.update("attempt", {
      status: "Queued",
      torrentHash: "8c212779b4abde7c6bc608063a0d008b7e40ce32",
      updatedAt: 2
    });

    expect(updated.source).toBe("internet-archive-torrent");
    expect(updated.torrentHash).toBe("8c212779b4abde7c6bc608063a0d008b7e40ce32");
    database.$client.close();
  });

  it("refuses a torrent write once the attempt is terminal", () => {
    const { database, repository } = setup();
    repository.claimSubmission({
      library,
      attempt: attempt({
        source: "internet-archive-torrent",
        newznabGuid: null,
        indexerUrlSnapshot: null,
        sabnzbdConfigRevision: 0,
        torrentHash: null
      })
    });
    repository.update("attempt", {
      status: "Completed",
      completedAt: 3,
      updatedAt: 3
    });
    const after = repository.update("attempt", {
      torrentHash: "deadbeef",
      updatedAt: 4
    });

    expect(after.torrentHash).toBeNull();
    database.$client.close();
  });

  it("refuses a filesAppliedAt stamp on a terminal attempt", () => {
    const { database, repository } = setup();
    repository.claimSubmission({
      library,
      attempt: attempt({
        source: "prowlarr-torrent",
        status: "Completed",
        selectedFiles: [{ index: 0, name: "Game.NSW" }],
        filesAppliedAt: null,
        progress: 100,
        completedAt: 3,
        updatedAt: 3
      })
    });

    const returned = repository.update("attempt", {
      filesAppliedAt: 4,
      updatedAt: 4
    });

    expect(returned).toMatchObject({
      status: "Completed",
      filesAppliedAt: null,
      updatedAt: 3
    });
    expect(repository.get("attempt")).toEqual(returned);
    database.$client.close();
  });
});
