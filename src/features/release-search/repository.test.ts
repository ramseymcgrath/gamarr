import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createDatabase } from "@/db/client";
import { migrateDatabase } from "@/db/migrate";
import { indexers } from "@/db/schema";
import { SqliteCandidateRepository } from "@/features/release-search/repository";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function repository(now = 1_000) {
  const directory = mkdtempSync(path.join(tmpdir(), "gamarr-candidates-"));
  temporaryDirectories.push(directory);
  const database = createDatabase(path.join(directory, "gamarr.db"));
  migrateDatabase(database, path.resolve("drizzle"));
  database.insert(indexers).values({
    id: "indexer",
    name: "Indexer",
    baseUrl: "https://indexer.test/api",
    apiKey: "secret",
    createdAt: 1,
    updatedAt: 1
  }).run();
  return {
    database,
    candidates: new SqliteCandidateRepository(database, () => now)
  };
}

describe("SqliteCandidateRepository", () => {
  it("round-trips an unexpired opaque release candidate", () => {
    const { database, candidates } = repository();
    const candidate = {
      id: "candidate",
      expiresAt: 2_000,
      indexerId: "indexer",
      indexerConfigRevision: 1,
      guid: "guid",
      title: "Game.NSW-GROUP",
      size: 1234,
      downloadPath: "/api?t=get&id=guid",
      category: "4050",
      sourceSnapshot: "{\"origin\":\"https://indexer.test\"}",
      createdAt: 900
    };

    candidates.save(candidate);

    expect(candidates.get("candidate")).toEqual(candidate);
    database.$client.close();
  });

  it("does not resolve expired candidates", () => {
    const { database, candidates } = repository(2_001);
    candidates.save({
      id: "expired",
      expiresAt: 2_000,
      indexerId: "indexer",
      indexerConfigRevision: 1,
      guid: "guid",
      title: "Game",
      size: null,
      downloadPath: "/api?t=get&id=guid",
      category: null,
      sourceSnapshot: "{}",
      createdAt: 900
    });

    expect(candidates.get("expired")).toBeNull();
    database.$client.close();
  });
});
