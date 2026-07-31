import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createDatabase } from "@/db/client";
import { migrateDatabase } from "@/db/migrate";
import { SqliteSettingsRepository } from "@/features/settings/repository";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function repository() {
  const directory = mkdtempSync(path.join(tmpdir(), "gamarr-settings-"));
  temporaryDirectories.push(directory);
  const database = createDatabase(path.join(directory, "gamarr.db"));
  migrateDatabase(database, path.resolve("drizzle"));
  return { database, repository: new SqliteSettingsRepository(database) };
}

describe("SqliteSettingsRepository", () => {
  it("round-trips typed settings records", () => {
    const { database, repository: settings } = repository();

    settings.saveIgdb({
      clientId: "client",
      clientSecret: "secret",
      lastTestStatus: null,
      lastTestedAt: null,
      configRevision: 1,
      updatedAt: 100
    });
    settings.saveSabnzbd({
      baseUrl: "http://sab.local",
      apiKey: "key",
      defaultCategory: "games",
      maxNzbBytes: 20 * 1024 * 1024,
      lastTestStatus: "success",
      lastTestedAt: 90,
      configRevision: 1,
      updatedAt: 100
    });
    settings.saveIndexer({
      id: "indexer",
      name: "Prowlarr",
      baseUrl: "http://prowlarr.local/1/api",
      apiKey: "indexer-key",
      enabled: true,
      categoryIds: ["4050"],
      timeoutMs: 10_000,
      configRevision: 1,
      lastTestStatus: null,
      lastTestedAt: null,
      deletedAt: null,
      createdAt: 100,
      updatedAt: 100
    });
    settings.recordIgdbTest("ok", 200);
    settings.recordSabnzbdTest("failed", 201);
    settings.recordIndexerTest("indexer", "ok", 202);

    expect(settings.getIgdb()).toMatchObject({
      clientId: "client",
      clientSecret: "secret",
      lastTestStatus: "ok",
      lastTestedAt: 200
    });
    expect(settings.getSabnzbd()).toMatchObject({
      baseUrl: "http://sab.local",
      apiKey: "key",
      lastTestStatus: "failed",
      lastTestedAt: 201
    });
    expect(settings.listIndexers()).toEqual([
      expect.objectContaining({
        id: "indexer",
        categoryIds: ["4050"],
        enabled: true,
        lastTestStatus: "ok",
        lastTestedAt: 202
      })
    ]);

    database.$client.close();
  });
});
