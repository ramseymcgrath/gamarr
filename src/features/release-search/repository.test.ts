import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createDatabase } from "@/db/client";
import { migrateDatabase } from "@/db/migrate";
import { releaseCandidates } from "@/db/schema";
import type { ReleaseCandidateRecord } from "@/features/release-search/ports";
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
  return {
    database,
    candidates: new SqliteCandidateRepository(database, () => now)
  };
}

function record(id: string, expiresAt: number): ReleaseCandidateRecord {
  return {
    id,
    expiresAt,
    protocol: "torrent",
    indexerId: "7",
    indexerConfigRevision: 3,
    guid: `guid-${id}`,
    title: "Game.NSW-GROUP",
    size: 1234,
    seeders: 42,
    downloadPath: `/api/v1/indexer/7/download?link=${id}`,
    category: "4050",
    sourceSnapshot: JSON.stringify({
      indexerName: "Tracker",
      origin: "https://prowlarr.test",
      magnetUrl: null
    }),
    createdAt: 900
  };
}

describe("SqliteCandidateRepository", () => {
  it("round-trips an unexpired opaque release candidate", () => {
    const { database, candidates } = repository();
    const candidate = record("candidate", 2_000);

    candidates.save(candidate);

    expect(candidates.get("candidate")).toEqual(candidate);
    database.$client.close();
  });

  it("does not resolve expired candidates", () => {
    const { database, candidates } = repository(2_001);

    candidates.save(record("expired", 2_000));

    expect(candidates.get("expired")).toBeNull();
    database.$client.close();
  });

  it("purges expired candidates on write while keeping claimable ones", () => {
    const { database } = repository();
    const early = new SqliteCandidateRepository(database, () => 1_000);
    early.save(record("expired", 2_000));
    early.save(record("in-flight", 3_000));

    const later = new SqliteCandidateRepository(database, () => 2_001);
    later.save(record("fresh", 4_000));

    const stored = database
      .select({ id: releaseCandidates.id })
      .from(releaseCandidates)
      .all()
      .map((row) => row.id)
      .sort();
    expect(stored).toEqual(["fresh", "in-flight"]);
    expect(later.get("in-flight")).toMatchObject({ id: "in-flight" });
    database.$client.close();
  });
});
