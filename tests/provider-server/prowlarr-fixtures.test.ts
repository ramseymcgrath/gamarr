import { describe, expect, it } from "vitest";

import { decodeTorrentFiles } from "@/integrations/prowlarr/metainfo";
import { validateMagnet } from "@/integrations/prowlarr/magnet-policy";
import {
  handleProwlarrFixture,
  prowlarrApiKey
} from "@tests/provider-server/prowlarr-fixtures";

function fixture(
  path: string,
  apiKey: string | null = prowlarrApiKey
) {
  const response = handleProwlarrFixture({
    method: "GET",
    url: new URL(path, "http://127.0.0.1:4100"),
    apiKey: apiKey ?? undefined
  });
  if (response === null) throw new Error("Expected Prowlarr fixture response");
  return response;
}

describe("Prowlarr provider fixture", () => {
  it("requires the API key header without exposing the key", () => {
    const missing = fixture("/api/v1/indexer", null);
    const wrong = fixture("/api/v1/indexer", "wrong-key");

    expect(missing).toMatchObject({ status: 401 });
    expect(wrong).toMatchObject({ status: 401 });
    expect(String(missing.body)).not.toContain(prowlarrApiKey);
    expect(String(wrong.body)).not.toContain(prowlarrApiKey);
  });

  it("lists one enabled torrent indexer and one enabled usenet indexer", () => {
    const response = fixture("/api/v1/indexer");
    const indexers = JSON.parse(String(response.body));

    expect(response.status).toBe(200);
    expect(indexers).toEqual([
      {
        id: 7,
        name: "Fixture Torrent",
        protocol: "torrent",
        enable: true,
        priority: 10,
        capabilities: { categories: [{ id: 1000, name: "Console" }] }
      },
      {
        id: 3,
        name: "Fixture Usenet",
        protocol: "usenet",
        enable: true,
        priority: 20,
        capabilities: { categories: [{ id: 1000, name: "Console" }] }
      }
    ]);
  });

  it("serves a Torznab feed with peers, seeders, and a download enclosure", () => {
    const response = fixture(
      "/api/v1/indexer/7/newznab?t=search&q=Metroid&o=xml"
    );
    const feed = String(response.body);

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("application/xml");
    expect(feed).toContain('name="seeders" value="42"');
    expect(feed).toContain('name="peers" value="48"');
    expect(feed).toContain(
      "/api/v1/indexer/7/download?link=fixture-torrent"
    );
  });

  it("serves valid torrent metainfo for the torrent download link", () => {
    const response = fixture(
      "/api/v1/indexer/7/download?link=fixture-torrent"
    );

    expect(response.status).toBe(200);
    expect(response.headers["content-type"])
      .toBe("application/x-bittorrent");
    expect(decodeTorrentFiles(new Uint8Array(response.body as Buffer))).toEqual([
      {
        index: 0,
        name: "Metroid.Prime.4.Beyond.NSW-GAMARR.nsp",
        size: 2048
      }
    ]);
  });

  it("redirects the magnet link to a valid magnet without exposing the key", () => {
    const response = fixture(
      "/api/v1/indexer/7/download?link=fixture-magnet"
    );
    const location = response.headers.location;

    expect(response.status).toBe(302);
    expect(location).toBeDefined();
    expect(validateMagnet(location!, prowlarrApiKey)).toBe(location);
    expect(location).not.toContain(prowlarrApiKey);
  });
});
