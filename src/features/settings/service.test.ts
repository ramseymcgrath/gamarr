import { describe, expect, it } from "vitest";

import { AppError } from "@/lib/errors";
import {
  SettingsService,
  type SettingsRepository
} from "@/features/settings/service";
import type {
  IgdbSettingsRecord,
  IndexerRecord,
  SabnzbdSettingsRecord
} from "@/features/settings/models";

class MemorySettingsRepository implements SettingsRepository {
  igdb: IgdbSettingsRecord | null = null;
  sabnzbd: SabnzbdSettingsRecord | null = null;
  qbittorrent: {
    baseUrl: string;
    username: string;
    password: string;
    defaultCategory: string | null;
    lastTestStatus: string | null;
    lastTestedAt: number | null;
    configRevision: number;
    updatedAt: number;
  } | null = null;
  indexers: IndexerRecord[] = [];

  getIgdb() {
    return this.igdb;
  }

  saveIgdb(value: IgdbSettingsRecord) {
    this.igdb = value;
  }

  getSabnzbd() {
    return this.sabnzbd;
  }

  saveSabnzbd(value: SabnzbdSettingsRecord) {
    this.sabnzbd = value;
  }

  getQbittorrent() {
    return this.qbittorrent;
  }

  saveQbittorrent(value: NonNullable<MemorySettingsRepository["qbittorrent"]>) {
    this.qbittorrent = value;
  }

  recordQbittorrentTest(status: string, testedAt: number) {
    if (this.qbittorrent) {
      this.qbittorrent.lastTestStatus = status;
      this.qbittorrent.lastTestedAt = testedAt;
    }
  }

  listIndexers() {
    return this.indexers;
  }

  saveIndexer(value: IndexerRecord) {
    const index = this.indexers.findIndex((item) => item.id === value.id);
    if (index === -1) {
      this.indexers.push(value);
    } else {
      this.indexers[index] = value;
    }
  }

  deleteIndexer(id: string, deletedAt: number) {
    const indexer = this.indexers.find((item) => item.id === id);
    if (indexer) {
      indexer.enabled = false;
      indexer.deletedAt = deletedAt;
      indexer.updatedAt = deletedAt;
      indexer.configRevision += 1;
    }
  }
}

describe("SettingsService", () => {
  it("redacts the qBittorrent password", () => {
    const repository = new MemorySettingsRepository();
    const service = new SettingsService(repository);
    repository.saveQbittorrent({
      baseUrl: "http://qbit.lan:8080",
      username: "admin",
      password: "hunter2",
      defaultCategory: "games",
      lastTestStatus: null,
      lastTestedAt: null,
      configRevision: 1,
      updatedAt: 1
    });

    const redacted = service.getRedacted();

    expect(redacted.qbittorrent).toEqual({
      baseUrl: "http://qbit.lan:8080",
      username: "admin",
      hasPassword: true,
      defaultCategory: "games",
      lastTestStatus: null,
      lastTestedAt: null,
      configRevision: 1
    });
    expect(JSON.stringify(redacted)).not.toContain("hunter2");
  });

  it("retains the stored qBittorrent password when the update says retain", () => {
    const repository = new MemorySettingsRepository();
    const service = new SettingsService(repository);
    service.saveQbittorrent({
      baseUrl: "http://qbit.lan:8080",
      username: "admin",
      password: { action: "replace", value: "hunter2" },
      defaultCategory: null
    });
    service.saveQbittorrent({
      baseUrl: "http://qbit.lan:9090",
      username: "admin",
      password: { action: "retain" },
      defaultCategory: null
    });

    expect(repository.getQbittorrent()?.password).toBe("hunter2");
  });

  it("bumps the qBittorrent config revision only when something changed", () => {
    const repository = new MemorySettingsRepository();
    const service = new SettingsService(repository);
    const input = {
      baseUrl: "http://qbit.lan:8080",
      username: "admin",
      password: { action: "replace" as const, value: "hunter2" },
      defaultCategory: null
    };
    service.saveQbittorrent(input);
    const first = repository.getQbittorrent()!.configRevision;

    service.saveQbittorrent({ ...input, password: { action: "retain" } });

    expect(repository.getQbittorrent()!.configRevision).toBe(first);
  });

  it("retains an existing IGDB secret without returning it", () => {
    const repository = new MemorySettingsRepository();
    const service = new SettingsService(repository, () => 1_000);

    service.saveIgdb({
      clientId: "first-id",
      clientSecret: { action: "replace", value: "top-secret" }
    });
    service.saveIgdb({
      clientId: "second-id",
      clientSecret: { action: "retain" }
    });

    expect(repository.igdb?.clientSecret).toBe("top-secret");
    expect(service.getRedacted().igdb).toEqual({
      clientId: "second-id",
      hasClientSecret: true,
      lastTestStatus: null,
      lastTestedAt: null,
      configRevision: 2
    });
    expect(JSON.stringify(service.getRedacted())).not.toContain("top-secret");
  });

  it("requires a replacement secret for first-time configuration", () => {
    const service = new SettingsService(new MemorySettingsRepository());

    expect(() => service.saveIgdb({
      clientId: "id",
      clientSecret: { action: "retain" }
    })).toThrowError(AppError);
  });

  it("clears a saved secret explicitly", () => {
    const repository = new MemorySettingsRepository();
    const service = new SettingsService(repository);
    service.saveIgdb({
      clientId: "id",
      clientSecret: { action: "replace", value: "secret" }
    });

    service.saveIgdb({
      clientId: "id",
      clientSecret: { action: "clear" }
    });

    expect(service.getRedacted().igdb?.hasClientSecret).toBe(false);
    expect(repository.igdb?.clientSecret).toBe("");
  });

  it("normalizes indexer URLs and validates timeout bounds", () => {
    const repository = new MemorySettingsRepository();
    const service = new SettingsService(repository, () => 1_000, () => "indexer-1");

    expect(() => service.saveIndexer({
      name: "Indexer",
      baseUrl: "https://indexer.test/api/",
      apiKey: { action: "replace", value: "key" },
      enabled: true,
      categoryIds: ["4050"],
      timeoutMs: 999
    })).toThrowError(AppError);

    const saved = service.saveIndexer({
      name: "Indexer",
      baseUrl: "https://indexer.test/api/",
      apiKey: { action: "replace", value: "key" },
      enabled: true,
      categoryIds: ["4050"],
      timeoutMs: 10_000
    });

    expect(saved.baseUrl).toBe("https://indexer.test/api");
    expect(saved.hasApiKey).toBe(true);
    expect(JSON.stringify(saved)).not.toContain("\"key\"");
  });

  it("soft-deletes indexers so historical download records remain valid", () => {
    const repository = new MemorySettingsRepository();
    const service = new SettingsService(repository, () => 2_000, () => "indexer-1");
    service.saveIndexer({
      name: "Indexer",
      baseUrl: "https://indexer.test/api",
      apiKey: { action: "replace", value: "key" },
      enabled: true,
      categoryIds: ["4050"],
      timeoutMs: 10_000
    });

    service.deleteIndexer("indexer-1");

    expect(repository.indexers[0]).toMatchObject({
      enabled: false,
      deletedAt: 2_000,
      configRevision: 2
    });
    expect(service.getRedacted().indexers).toEqual([]);
  });

  it("refuses to resurrect a soft-deleted indexer through an update", () => {
    const repository = new MemorySettingsRepository();
    const service = new SettingsService(repository, () => 2_000, () => "indexer-1");
    service.saveIndexer({
      name: "Indexer",
      baseUrl: "https://indexer.test/api",
      apiKey: { action: "replace", value: "key" },
      enabled: true,
      categoryIds: ["4050"],
      timeoutMs: 10_000
    });
    service.deleteIndexer("indexer-1");

    expect(() => service.saveIndexer({
      id: "indexer-1",
      name: "Revived",
      baseUrl: "https://indexer.test/api",
      apiKey: { action: "retain" },
      enabled: true,
      categoryIds: ["4050"],
      timeoutMs: 10_000
    })).toThrow(expect.objectContaining({ code: "NOT_FOUND", status: 404 }));

    expect(repository.indexers[0]).toMatchObject({
      name: "Indexer",
      enabled: false,
      deletedAt: 2_000
    });
    expect(service.getRedacted().indexers).toEqual([]);
  });

  it("reports an unknown indexer id as not found", () => {
    const repository = new MemorySettingsRepository();
    const service = new SettingsService(repository, () => 2_000, () => "indexer-1");

    expect(() => service.saveIndexer({
      id: "missing",
      name: "Indexer",
      baseUrl: "https://indexer.test/api",
      apiKey: { action: "replace", value: "key" },
      enabled: true,
      categoryIds: ["4050"],
      timeoutMs: 10_000
    })).toThrow(expect.objectContaining({ code: "NOT_FOUND", status: 404 }));
  });
});
