import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createDatabase } from "@/db/client";
import { migrateDatabase } from "@/db/migrate";
import { platforms } from "@/db/schema";
import { SqliteSettingsRepository } from "@/features/settings/repository";
import { SettingsService } from "@/features/settings/service";

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
  it("round-trips a qBittorrent settings record", () => {
    const { database, repository: settings } = repository();

    settings.saveQbittorrent({
      baseUrl: "http://qbit.local:8080",
      username: "admin",
      password: "secret",
      defaultCategory: "games",
      lastTestStatus: null,
      lastTestedAt: null,
      configRevision: 1,
      updatedAt: 100
    });

    expect(settings.getQbittorrent()).toEqual({
      baseUrl: "http://qbit.local:8080",
      username: "admin",
      password: "secret",
      defaultCategory: "games",
      lastTestStatus: null,
      lastTestedAt: null,
      configRevision: 1,
      updatedAt: 100
    });

    database.$client.close();
  });

  it("records a qBittorrent connection test result", () => {
    const { database, repository: settings } = repository();
    settings.saveQbittorrent({
      baseUrl: "http://qbit.local:8080",
      username: "admin",
      password: "secret",
      defaultCategory: null,
      lastTestStatus: null,
      lastTestedAt: null,
      configRevision: 1,
      updatedAt: 100
    });

    settings.recordQbittorrentTest("ok", 200);

    expect(settings.getQbittorrent()).toMatchObject({
      baseUrl: "http://qbit.local:8080",
      password: "secret",
      lastTestStatus: "ok",
      lastTestedAt: 200
    });

    database.$client.close();
  });

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
    settings.recordIgdbTest("ok", 200);
    settings.recordSabnzbdTest("failed", 201);

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
    database.$client.close();
  });

  it("round-trips prowlarr settings", () => {
    const { database, repository: settings } = repository();
    const record = {
      baseUrl: "http://prowlarr.local:9696",
      apiKey: "prowlarr-secret",
      timeoutMs: 12_000,
      lastTestStatus: "ok",
      lastTestedAt: 90,
      configRevision: 3,
      updatedAt: 100
    };

    settings.saveProwlarr(record);

    expect(settings.getProwlarr()).toEqual(record);
    database.$client.close();
  });

  it("returns null when prowlarr is unconfigured", () => {
    const { database, repository: settings } = repository();

    expect(settings.getProwlarr()).toBeNull();

    database.$client.close();
  });

  it("bumps configRevision on save", () => {
    const { database, repository: settings } = repository();
    const service = new SettingsService(settings, () => 100);
    service.saveProwlarr({
      baseUrl: "http://prowlarr.local:9696",
      apiKey: { action: "replace", value: "prowlarr-secret" },
      timeoutMs: 10_000
    });

    service.saveProwlarr({
      baseUrl: "http://prowlarr.local:9797",
      apiKey: { action: "retain" },
      timeoutMs: 10_000
    });

    expect(settings.getProwlarr()?.configRevision).toBe(2);
    database.$client.close();
  });

  it("records a connection test without touching the credential", () => {
    const { database, repository: settings } = repository();
    settings.saveProwlarr({
      baseUrl: "http://prowlarr.local:9696",
      apiKey: "prowlarr-secret",
      timeoutMs: 10_000,
      lastTestStatus: null,
      lastTestedAt: null,
      configRevision: 1,
      updatedAt: 100
    });

    settings.recordProwlarrTest("ok", 200);

    expect(settings.getProwlarr()).toEqual({
      baseUrl: "http://prowlarr.local:9696",
      apiKey: "prowlarr-secret",
      timeoutMs: 10_000,
      lastTestStatus: "ok",
      lastTestedAt: 200,
      configRevision: 1,
      updatedAt: 100
    });
    database.$client.close();
  });

  it("replaces a platform's categories wholesale", () => {
    const { database, repository: settings } = repository();
    database.insert(platforms)
      .values({ id: 130, name: "Switch", lastSyncedAt: 100 })
      .run();
    settings.savePlatformCategories(130, ["1080", "4000"]);

    settings.savePlatformCategories(130, ["4050"]);

    expect(settings.listPlatformCategories(130)).toEqual(["4050"]);
    database.$client.close();
  });

  it("returns an empty category list for an unknown platform", () => {
    const { database, repository: settings } = repository();

    expect(settings.listPlatformCategories(999)).toEqual([]);

    database.$client.close();
  });
});
