import { describe, expect, it } from "vitest";

import { SettingsService, type SettingsRepository } from "@/features/settings/service";
import type {
  IgdbSettingsRecord,
  IndexerRecord,
  SabnzbdSettingsRecord
} from "@/features/settings/models";
import {
  handleGetSettings,
  handlePutIgdb
} from "@/app/api/settings/handlers";
import { parseOriginPolicy } from "@/lib/trusted-mutation";

class MemoryRepository implements SettingsRepository {
  igdb: IgdbSettingsRecord | null = null;
  getIgdb = () => this.igdb;
  saveIgdb = (value: IgdbSettingsRecord) => { this.igdb = value; };
  getSabnzbd = (): SabnzbdSettingsRecord | null => null;
  saveSabnzbd = () => undefined;
  listIndexers = (): IndexerRecord[] => [];
  saveIndexer = () => undefined;
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

  it("gets a redacted settings snapshot", async () => {
    const service = new SettingsService(new MemoryRepository());

    const response = await handleGetSettings({ service });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      igdb: null,
      indexers: [],
      sabnzbd: null
    });
  });
});
