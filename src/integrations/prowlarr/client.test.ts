import { describe, expect, it } from "vitest";

import { ProwlarrClient } from "@/integrations/prowlarr/client";

const BASE_URL = "https://prowlarr.test/root";
const API_KEY = "prowlarr-secret-key";

function indexer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 7,
    name: "1337x",
    protocol: "torrent",
    enable: true,
    priority: 25,
    capabilities: {
      categories: [{ id: 1080, name: "Console" }]
    },
    ...overrides
  };
}

function discoveryResponse(entries: unknown[]): Response {
  return Response.json(entries);
}

const searchFeed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:torznab="http://torznab.com/schemas/2015/feed">
  <channel>
    <item>
      <title>Metroid Prime (USA)</title>
      <guid>abc123</guid>
      <enclosure url="https://prowlarr.test/api/v1/indexer/7/download?link=xyz"
                 length="734003200" type="application/x-bittorrent" />
      <torznab:attr name="seeders" value="42" />
    </item>
  </channel>
</rss>`;

describe("ProwlarrClient", () => {
  it("sends the API key as a header, never in the URL", async () => {
    let recordedUrl: URL | undefined;
    let recordedHeaders: Headers | undefined;
    const client = new ProwlarrClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      timeoutMs: 10_000,
      fetch: async (input, init) => {
        recordedUrl = new URL(String(input));
        recordedHeaders = new Headers(init?.headers);
        return discoveryResponse([indexer()]);
      }
    });

    await client.listIndexers();

    expect(recordedUrl).toBeDefined();
    expect(recordedUrl!.toString()).not.toContain(API_KEY);
    expect(recordedUrl!.searchParams.has("apikey")).toBe(false);
    expect(recordedUrl!.searchParams.has("api_key")).toBe(false);
    expect(recordedHeaders?.get("X-Api-Key")).toBe(API_KEY);
  });

  it("returns only enabled indexers", async () => {
    const client = new ProwlarrClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      timeoutMs: 10_000,
      fetch: async () => discoveryResponse([
        indexer({ id: 7, name: "Enabled", enable: true }),
        indexer({ id: 8, name: "Disabled", enable: false })
      ])
    });

    const result = await client.listIndexers();

    expect(result.map((entry) => entry.name)).toEqual(["Enabled"]);
  });

  it("maps capability category ids to strings", async () => {
    const client = new ProwlarrClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      timeoutMs: 10_000,
      fetch: async () => discoveryResponse([
        indexer({
          capabilities: {
            categories: [
              { id: 1080, name: "Console" },
              { id: "4000", name: "PC" }
            ]
          }
        })
      ])
    });

    const result = await client.listIndexers();

    expect(result[0]?.categoryIds).toEqual(["1080", "4000"]);
  });

  it("skips indexers with an unrecognised protocol", async () => {
    const client = new ProwlarrClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      timeoutMs: 10_000,
      fetch: async () => discoveryResponse([
        indexer({ id: 6, name: "Unsupported", protocol: "carrier-pigeon" }),
        indexer({ id: 7, name: "Supported", protocol: "torrent" })
      ])
    });

    const result = await client.listIndexers();

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: "7", name: "Supported", protocol: "torrent" });
  });

  it("throws UNAVAILABLE when discovery returns a non-ok status", async () => {
    const client = new ProwlarrClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      timeoutMs: 10_000,
      fetch: async () => new Response(`upstream echoed ${API_KEY}`, { status: 503 })
    });

    const rejection = client.listIndexers();

    await expect(rejection).rejects.toMatchObject({
      code: "UNAVAILABLE",
      status: 502,
      message: "Prowlarr indexer list failed"
    });
    await expect(rejection).rejects.not.toMatchObject({ message: expect.stringContaining(API_KEY) });
  });

  it("throws UNAVAILABLE when the discovery payload fails validation", async () => {
    const client = new ProwlarrClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      timeoutMs: 10_000,
      fetch: async () => discoveryResponse([
        indexer({ name: "", capabilities: { categories: "not-an-array" } })
      ])
    });

    await expect(client.listIndexers()).rejects.toMatchObject({
      code: "UNAVAILABLE",
      status: 502,
      message: "Prowlarr returned an invalid indexer list"
    });
  });

  it("queries the per-indexer newznab endpoint with the search term", async () => {
    let recordedUrl: URL | undefined;
    const client = new ProwlarrClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      timeoutMs: 10_000,
      fetch: async (input) => {
        recordedUrl = new URL(String(input));
        return new Response(searchFeed);
      }
    });

    const result = await client.search(
      {
        id: "7",
        name: "1337x",
        protocol: "torrent",
        priority: 25,
        categoryIds: ["1080"]
      },
      { term: "Metroid Prime", categories: ["1080"] }
    );

    expect(recordedUrl?.pathname).toBe("/root/api/v1/indexer/7/newznab");
    expect(recordedUrl?.searchParams.get("t")).toBe("search");
    expect(recordedUrl?.searchParams.get("q")).toBe("Metroid Prime");
    expect(recordedUrl?.searchParams.get("o")).toBe("xml");
    expect(result.releases).toHaveLength(1);
    expect(result.releases[0]).toMatchObject({
      guid: "abc123",
      indexerId: "7",
      protocol: "torrent"
    });
  });

  it("omits the cat parameter when no categories are supplied", async () => {
    let recordedUrl: URL | undefined;
    const client = new ProwlarrClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      timeoutMs: 10_000,
      fetch: async (input) => {
        recordedUrl = new URL(String(input));
        return new Response(searchFeed);
      }
    });

    await client.search(
      {
        id: "7",
        name: "1337x",
        protocol: "torrent",
        priority: 25,
        categoryIds: []
      },
      { term: "Metroid Prime", categories: [] }
    );

    expect(recordedUrl?.searchParams.has("cat")).toBe(false);
  });

  it("joins supplied categories with commas", async () => {
    let recordedUrl: URL | undefined;
    const client = new ProwlarrClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      timeoutMs: 10_000,
      fetch: async (input) => {
        recordedUrl = new URL(String(input));
        return new Response(searchFeed);
      }
    });

    await client.search(
      {
        id: "7",
        name: "1337x",
        protocol: "torrent",
        priority: 25,
        categoryIds: ["1000", "1080"]
      },
      { term: "Metroid Prime", categories: ["1000", "1080"] }
    );

    expect(recordedUrl?.searchParams.get("cat")).toBe("1000,1080");
  });

  it("throws UNAVAILABLE when a search response exceeds the byte cap", async () => {
    const client = new ProwlarrClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      timeoutMs: 10_000,
      maxResponseBytes: 32,
      fetch: async () => new Response(searchFeed)
    });

    await expect(client.search(
      {
        id: "7",
        name: "1337x",
        protocol: "torrent",
        priority: 25,
        categoryIds: []
      },
      { term: "Metroid Prime", categories: [] }
    )).rejects.toMatchObject({
      code: "UNAVAILABLE",
      status: 502,
      message: "Prowlarr search response is too large"
    });
  });

  it("propagates an external abort signal", async () => {
    const controller = new AbortController();
    const abortReason = new Error("caller stopped the search");
    let receivedSignal: AbortSignal | null = null;
    const client = new ProwlarrClient({
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      timeoutMs: 10_000,
      fetch: async (_input, init) => {
        receivedSignal = init?.signal ?? null;
        return await new Promise<Response>((_resolve, reject) => {
          receivedSignal?.addEventListener("abort", () => {
            reject(receivedSignal?.reason);
          }, { once: true });
        });
      }
    });

    const pending = client.listIndexers(controller.signal);
    controller.abort(abortReason);

    await expect(pending).rejects.toBe(abortReason);
    expect(receivedSignal).not.toBeNull();
    expect(receivedSignal!.aborted).toBe(true);
    expect(receivedSignal!.reason).toBe(abortReason);
  });
});
