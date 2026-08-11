import { describe, expect, it } from "vitest";

import { AppError } from "@/lib/errors";
import {
  SettingsService,
  type SettingsRepository
} from "@/features/settings/service";
import type {
  IgdbSettingsRecord,
  ProwlarrSettingsRecord,
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
  prowlarr: ProwlarrSettingsRecord | null = null;

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

  getProwlarr() {
    return this.prowlarr;
  }

  saveProwlarr(value: ProwlarrSettingsRecord) {
    this.prowlarr = value;
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

  it("redacts the prowlarr api key", () => {
    const repository = new MemorySettingsRepository();
    const service = new SettingsService(repository);
    repository.saveProwlarr({
      baseUrl: "https://prowlarr.test/api",
      apiKey: "prowlarr-secret-key",
      timeoutMs: 10_000,
      lastTestStatus: "ok",
      lastTestedAt: 900,
      configRevision: 4,
      updatedAt: 1_000
    });

    const redacted = service.getRedacted();

    expect(redacted.prowlarr).toEqual({
      baseUrl: "https://prowlarr.test/api",
      hasApiKey: true,
      timeoutMs: 10_000,
      lastTestStatus: "ok",
      lastTestedAt: 900,
      configRevision: 4
    });
    expect(JSON.stringify(redacted)).not.toContain("prowlarr-secret-key");
  });

  it("retains the stored api key on a retain action", () => {
    const repository = new MemorySettingsRepository();
    const service = new SettingsService(repository, () => 2_000);
    service.saveProwlarr({
      baseUrl: "https://prowlarr.test/api",
      apiKey: { action: "replace", value: "prowlarr-secret-key" },
      timeoutMs: 10_000
    });
    service.saveProwlarr({
      baseUrl: "https://prowlarr.test/v1",
      apiKey: { action: "retain" },
      timeoutMs: 12_000
    });

    expect(repository.getProwlarr()).toMatchObject({
      baseUrl: "https://prowlarr.test/v1",
      apiKey: "prowlarr-secret-key",
      timeoutMs: 12_000,
      configRevision: 2
    });
  });

  it("clears the api key on a clear action", () => {
    const repository = new MemorySettingsRepository();
    const service = new SettingsService(repository);
    service.saveProwlarr({
      baseUrl: "https://prowlarr.test/api",
      apiKey: { action: "replace", value: "prowlarr-secret-key" },
      timeoutMs: 10_000
    });
    service.saveProwlarr({
      baseUrl: "https://prowlarr.test/api",
      apiKey: { action: "clear" },
      timeoutMs: 10_000
    });

    expect(repository.getProwlarr()?.apiKey).toBe("");
    expect(service.getRedacted().prowlarr?.hasApiKey).toBe(false);
  });

  it("rejects a non-URL base url", () => {
    const repository = new MemorySettingsRepository();
    const service = new SettingsService(repository);

    expect(() => service.saveProwlarr({
      baseUrl: "not a url",
      apiKey: { action: "replace", value: "prowlarr-secret-key" },
      timeoutMs: 10_000
    })).toThrowError(AppError);
    expect(repository.getProwlarr()).toBeNull();
  });

  it("rejects a timeout outside 1000..30000", () => {
    const repository = new MemorySettingsRepository();
    const service = new SettingsService(repository);

    for (const timeoutMs of [999, 30_001]) {
      expect(() => service.saveProwlarr({
        baseUrl: "https://prowlarr.test/api",
        apiKey: { action: "replace", value: "prowlarr-secret-key" },
        timeoutMs
      })).toThrowError(AppError);
    }
    expect(repository.getProwlarr()).toBeNull();
  });
});
