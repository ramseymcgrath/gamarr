import { describe, expect, it, vi } from "vitest";

import {
  handleGetSettings,
  handlePutIgdb,
  handlePutProwlarr,
  handlePutQbittorrent,
  handleTestQbittorrent,
  handleTestProwlarr
} from "@/app/api/settings/handlers";
import type {
  IgdbSettingsRecord,
  ProwlarrSettingsRecord,
  QbittorrentSettingsRecord,
  SabnzbdSettingsRecord
} from "@/features/settings/models";
import { SettingsService, type SettingsRepository } from "@/features/settings/service";
import { parseOriginPolicy } from "@/lib/trusted-mutation";

class MemoryRepository implements SettingsRepository {
  igdb: IgdbSettingsRecord | null = null;
  qbittorrent: QbittorrentSettingsRecord | null = null;
  prowlarr: ProwlarrSettingsRecord | null = null;
  getIgdb = () => this.igdb;
  saveIgdb = (value: IgdbSettingsRecord) => { this.igdb = value; };
  getSabnzbd = (): SabnzbdSettingsRecord | null => null;
  saveSabnzbd = () => undefined;
  getQbittorrent = () => this.qbittorrent;
  saveQbittorrent = (value: QbittorrentSettingsRecord) => {
    this.qbittorrent = value;
  };
  recordQbittorrentTest = () => undefined;
  getProwlarr = () => this.prowlarr;
  saveProwlarr = (value: ProwlarrSettingsRecord) => {
    this.prowlarr = value;
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

function putProwlarrRequest(
  apiKey = "prowlarr-secret-key",
  origin = "http://gamarr.local"
) {
  return new Request("http://gamarr.local/api/settings/prowlarr", {
    method: "PUT",
    headers: {
      host: "gamarr.local",
      origin,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      baseUrl: "http://prowlarr.lan:9696",
      apiKey: { action: "replace", value: apiKey },
      timeoutMs: 10_000
    })
  });
}

function testProwlarrRequest(origin = "http://gamarr.local") {
  return new Request("http://gamarr.local/api/settings/prowlarr/test", {
    method: "POST",
    headers: {
      host: "gamarr.local",
      origin
    }
  });
}

function testQbittorrentRequest(origin = "http://gamarr.local") {
  return new Request("http://gamarr.local/api/settings/qbittorrent/test", {
    method: "POST",
    headers: {
      host: "gamarr.local",
      origin
    }
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
      prowlarr: null,
      qbittorrent: null,
      sabnzbd: null
    });
  });

  it("never returns the prowlarr api key", async () => {
    const key = "prowlarr-secret-key";
    const repository = new MemoryRepository();
    const service = new SettingsService(repository, () => 100);

    const response = await handlePutProwlarr(
      putProwlarrRequest(key),
      { service, policy }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(repository.prowlarr?.apiKey).toBe(key);
    expect(body.prowlarr).toEqual({
      baseUrl: "http://prowlarr.lan:9696",
      hasApiKey: true,
      timeoutMs: 10_000,
      lastTestStatus: null,
      lastTestedAt: null,
      configRevision: 1
    });
    expect(JSON.stringify(body)).not.toContain(key);
  });

  it("rejects a cross-origin mutation", async () => {
    const repository = new MemoryRepository();
    const service = new SettingsService(repository);

    const response = await handlePutProwlarr(
      putProwlarrRequest("secret", "http://attacker.test"),
      { service, policy }
    );

    expect(response.status).toBe(403);
    expect(repository.prowlarr).toBeNull();
  });

  it("returns discovered indexer names and protocols from a test", async () => {
    const key = "prowlarr-secret-key";
    const listIndexers = vi.fn(async () => [
      {
        id: "7",
        name: "1337x",
        protocol: "torrent" as const,
        priority: 10,
        categoryIds: ["1000"]
      },
      {
        id: "3",
        name: "NZBgeek",
        protocol: "usenet" as const,
        priority: 25,
        categoryIds: ["4000"]
      }
    ]);
    const recordResult = vi.fn();

    const response = await handleTestProwlarr(testProwlarrRequest(), {
      policy,
      getSettings: () => ({
        baseUrl: "http://prowlarr.lan:9696",
        apiKey: key,
        timeoutMs: 10_000,
        lastTestStatus: null,
        lastTestedAt: null,
        configRevision: 1,
        updatedAt: 1
      }),
      clientFactory: () => ({ listIndexers }),
      recordResult
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      indexers: [
        { id: "7", name: "1337x", protocol: "torrent", priority: 10 },
        { id: "3", name: "NZBgeek", protocol: "usenet", priority: 25 }
      ],
      usenet: 1,
      torrent: 1
    });
    expect(listIndexers).toHaveBeenCalledOnce();
    expect(recordResult).toHaveBeenCalledWith("ok");
    expect(JSON.stringify(body)).not.toContain(key);
  });

  it("rejects a cross-origin Prowlarr test before discovery", async () => {
    const listIndexers = vi.fn();
    const recordResult = vi.fn();

    const response = await handleTestProwlarr(
      testProwlarrRequest("http://attacker.test"),
      {
        policy,
        getSettings: () => null,
        clientFactory: () => ({ listIndexers }),
        recordResult
      }
    );

    expect(response.status).toBe(403);
    expect(listIndexers).not.toHaveBeenCalled();
    expect(recordResult).not.toHaveBeenCalled();
  });

  it("tests qBittorrent through an injected client without exposing its password", async () => {
    const password = "qbittorrent-secret";
    const testConnection = vi.fn(async () => undefined);
    const recordResult = vi.fn();

    const response = await handleTestQbittorrent(testQbittorrentRequest(), {
      policy,
      getSettings: () => ({
        baseUrl: "http://qbit.lan:8080",
        username: "admin",
        password,
        defaultCategory: "games",
        lastTestStatus: null,
        lastTestedAt: null,
        configRevision: 1,
        updatedAt: 1
      }),
      clientFactory: () => ({ testConnection }),
      recordResult
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ status: "ok" });
    expect(testConnection).toHaveBeenCalledOnce();
    expect(recordResult).toHaveBeenCalledWith("ok");
    expect(JSON.stringify(body)).not.toContain(password);
  });

  it("rejects a cross-origin qBittorrent test before connecting", async () => {
    const testConnection = vi.fn();
    const recordResult = vi.fn();

    const response = await handleTestQbittorrent(
      testQbittorrentRequest("http://attacker.test"),
      {
        policy,
        getSettings: () => null,
        clientFactory: () => ({ testConnection }),
        recordResult
      }
    );

    expect(response.status).toBe(403);
    expect(testConnection).not.toHaveBeenCalled();
    expect(recordResult).not.toHaveBeenCalled();
  });
});
