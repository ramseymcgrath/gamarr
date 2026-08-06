import { describe, expect, it } from "vitest";

import { SettingsService, type SettingsRepository } from "@/features/settings/service";
import type {
  IgdbSettingsRecord,
  IndexerRecord,
  QbittorrentSettingsRecord,
  SabnzbdSettingsRecord
} from "@/features/settings/models";
import {
  handleDeleteIndexer,
  handleGetSettings,
  handlePutIndexer,
  handlePutIgdb,
  handlePutQbittorrent
} from "@/app/api/settings/handlers";
import { parseOriginPolicy } from "@/lib/trusted-mutation";

class MemoryRepository implements SettingsRepository {
  igdb: IgdbSettingsRecord | null = null;
  qbittorrent: QbittorrentSettingsRecord | null = null;
  indexers: IndexerRecord[] = [];
  getIgdb = () => this.igdb;
  saveIgdb = (value: IgdbSettingsRecord) => { this.igdb = value; };
  getSabnzbd = (): SabnzbdSettingsRecord | null => null;
  saveSabnzbd = () => undefined;
  getQbittorrent = () => this.qbittorrent;
  saveQbittorrent = (value: QbittorrentSettingsRecord) => {
    this.qbittorrent = value;
  };
  recordQbittorrentTest = () => undefined;
  listIndexers = (): IndexerRecord[] => this.indexers;
  saveIndexer = (value: IndexerRecord) => {
    const index = this.indexers.findIndex((item) => item.id === value.id);
    if (index === -1) this.indexers.push(value);
    else this.indexers[index] = value;
  };
  deleteIndexer = (id: string, deletedAt: number) => {
    const indexer = this.indexers.find((item) => item.id === id);
    if (indexer) {
      indexer.deletedAt = deletedAt;
      indexer.enabled = false;
    }
  };
}

const policy = parseOriginPolicy("http://gamarr.local");

function putRequest(origin = "http://gamarr.local") {
  return new Request("http://gamarr.local/api/settings/igdb", {
    method: "PUT",
    headers: {
      host: "gamarr.local",
      origin,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      clientId: "client",
      clientSecret: { action: "replace", value: "never-return-this" }
    })
  });
}

function putQbittorrentRequest(origin = "http://gamarr.local") {
  return new Request("http://gamarr.local/api/settings/qbittorrent", {
    method: "PUT",
    headers: {
      host: "gamarr.local",
      origin,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      baseUrl: "http://qbit.lan:8080",
      username: "admin",
      password: { action: "replace", value: "never-return-this" },
      defaultCategory: "games"
    })
  });
}

describe("settings HTTP handlers", () => {
  it("saves IGDB settings and returns only the redacted model", async () => {
    const service = new SettingsService(new MemoryRepository(), () => 100);

    const response = await handlePutIgdb(putRequest(), { service, policy });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.igdb).toMatchObject({ clientId: "client", hasClientSecret: true });
    expect(JSON.stringify(body)).not.toContain("never-return-this");
  });

  it("rejects an untrusted origin before reading or saving the body", async () => {
    const service = new SettingsService(new MemoryRepository());

    const response = await handlePutIgdb(putRequest("http://attacker.test"), {
      service,
      policy
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { code: "FORBIDDEN", message: "Request origin is not allowed" }
    });
  });

  it("rejects a cross-origin qBittorrent update", async () => {
    const repository = new MemoryRepository();
    const service = new SettingsService(repository);

    const response = await handlePutQbittorrent(
      putQbittorrentRequest("http://attacker.test"),
      { service, policy }
    );

    expect(response.status).toBe(403);
    expect(repository.qbittorrent).toBeNull();
  });

  it("saves a qBittorrent update and returns only redacted settings", async () => {
    const repository = new MemoryRepository();
    const service = new SettingsService(repository, () => 100);

    const response = await handlePutQbittorrent(
      putQbittorrentRequest(),
      { service, policy }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(repository.qbittorrent).toMatchObject({
      baseUrl: "http://qbit.lan:8080",
      username: "admin",
      password: "never-return-this",
      defaultCategory: "games"
    });
    expect(body.qbittorrent).toMatchObject({
      baseUrl: "http://qbit.lan:8080",
      username: "admin",
      hasPassword: true,
      defaultCategory: "games"
    });
    expect(JSON.stringify(body)).not.toContain("never-return-this");
  });

  it("gets a redacted settings snapshot", async () => {
    const service = new SettingsService(new MemoryRepository());

    const response = await handleGetSettings({ service });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      igdb: null,
      indexers: [],
      qbittorrent: null,
      sabnzbd: null
    });
  });

  it("updates and soft-deletes a named indexer", async () => {
    const repository = new MemoryRepository();
    const service = new SettingsService(repository, () => 100, () => "indexer");
    service.saveIndexer({
      name: "Old",
      baseUrl: "https://indexer.test/api",
      apiKey: { action: "replace", value: "secret" },
      enabled: true,
      categoryIds: [],
      timeoutMs: 10_000
    });
    const update = await handlePutIndexer(
      "indexer",
      new Request("http://gamarr.local/api/settings/indexers/indexer", {
        method: "PUT",
        headers: {
          host: "gamarr.local",
          origin: "http://gamarr.local",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          name: "New",
          baseUrl: "https://indexer.test/api",
          apiKey: { action: "retain" },
          enabled: true,
          categoryIds: ["4050"],
          timeoutMs: 10_000
        })
      }),
      { service, policy }
    );
    const deleted = await handleDeleteIndexer(
      "indexer",
      new Request("http://gamarr.local/api/settings/indexers/indexer", {
        method: "DELETE",
        headers: {
          host: "gamarr.local",
          origin: "http://gamarr.local"
        }
      }),
      { service, policy }
    );

    expect(update.status).toBe(200);
    expect(await update.json()).toMatchObject({ id: "indexer", name: "New" });
    expect(deleted.status).toBe(204);
    expect(repository.indexers[0]?.deletedAt).toBe(100);
  });
});
