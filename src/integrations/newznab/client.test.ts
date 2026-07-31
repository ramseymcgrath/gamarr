import { describe, expect, it } from "vitest";

import { NewznabClient } from "@/integrations/newznab/client";

const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:newznab="http://www.newznab.com/DTD/2010/feeds/attributes/" version="2.0">
  <channel>
    <item>
      <title>Game.Name.NSW-GROUP</title>
      <guid isPermaLink="false">guid-one</guid>
      <pubDate>Thu, 31 Jul 2026 00:00:00 GMT</pubDate>
      <category>Console</category>
      <enclosure url="https://indexer.test/api?t=get&amp;id=guid-one&amp;apikey=secret" length="1234" type="application/x-nzb" />
      <newznab:attr name="category" value="4050" />
      <newznab:attr name="size" value="1234" />
    </item>
    <item>
      <title>Missing fields</title>
    </item>
  </channel>
</rss>`;

describe("NewznabClient", () => {
  it("reads Newznab capabilities for setup validation and category mapping", async () => {
    const capabilities = `<?xml version="1.0" encoding="UTF-8"?>
      <caps>
        <server version="1.2.3" title="Example Indexer" />
        <searching><search available="yes" /></searching>
        <categories>
          <category id="4000" name="PC">
            <subcat id="4050" name="Games" />
          </category>
          <category id="100000" name="Console" />
        </categories>
      </caps>`;
    const client = new NewznabClient({
      id: "indexer",
      name: "Indexer",
      baseUrl: "https://indexer.test/api",
      apiKey: "secret",
      timeoutMs: 10_000,
      fetch: async (input) => {
        expect(new URL(String(input)).searchParams.get("t")).toBe("caps");
        return new Response(capabilities);
      }
    });

    await expect(client.getCapabilities()).resolves.toEqual({
      serverTitle: "Example Indexer",
      serverVersion: "1.2.3",
      searchAvailable: true,
      categories: [
        { id: "4000", name: "PC", parentId: null },
        { id: "4050", name: "Games", parentId: "4000" },
        { id: "100000", name: "Console", parentId: null }
      ]
    });
  });

  it("keeps valid RSS siblings and reports schema-invalid items", async () => {
    const client = new NewznabClient({
      id: "indexer",
      name: "Indexer",
      baseUrl: "https://indexer.test/api",
      apiKey: "secret",
      timeoutMs: 10_000,
      fetch: async () => new Response(rss, {
        headers: { "content-type": "application/rss+xml" }
      })
    });

    const result = await client.search({
      term: "Game Name NSW",
      categories: ["4050"],
      reason: "canonical-platform"
    });

    expect(result.releases).toEqual([
      expect.objectContaining({
        guid: "guid-one",
        title: "Game.Name.NSW-GROUP",
        size: 1234,
        category: "4050"
      })
    ]);
    expect(result.warnings).toHaveLength(1);
  });

  it("rejects malformed XML and oversized responses", async () => {
    const malformed = new NewznabClient({
      id: "indexer",
      name: "Indexer",
      baseUrl: "https://indexer.test/api",
      apiKey: "secret",
      timeoutMs: 10_000,
      fetch: async () => new Response("<rss><broken>")
    });
    await expect(malformed.search({
      term: "game",
      categories: [],
      reason: "canonical"
    })).rejects.toMatchObject({ code: "UNAVAILABLE" });

    const oversized = new NewznabClient({
      id: "indexer",
      name: "Indexer",
      baseUrl: "https://indexer.test/api",
      apiKey: "secret",
      timeoutMs: 10_000,
      maxResponseBytes: 10,
      fetch: async () => new Response(rss)
    });
    await expect(oversized.search({
      term: "game",
      categories: [],
      reason: "canonical"
    })).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("stops reading an oversized chunked response instead of buffering it", async () => {
    const chunk = new TextEncoder().encode("x".repeat(64));
    const pulled: number[] = [];
    let index = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index >= 100) {
          controller.close();
          return;
        }
        pulled.push(index);
        controller.enqueue(chunk);
        index += 1;
      }
    }, { highWaterMark: 0 });
    const client = new NewznabClient({
      id: "indexer",
      name: "Indexer",
      baseUrl: "https://indexer.test/api",
      apiKey: "secret",
      timeoutMs: 10_000,
      maxResponseBytes: 100,
      fetch: async () => new Response(stream)
    });

    await expect(client.search({
      term: "game",
      categories: [],
      reason: "canonical"
    })).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(pulled.length).toBeLessThanOrEqual(2);
  });

  it("decodes a multi-byte title split across transport chunks", async () => {
    const feed = rss.replace("Game.Name.NSW-GROUP", "Game.🎮.NSW-GROUP");
    const encoded = new TextEncoder().encode(feed);
    const split = encoded.indexOf(0xf0) + 2;
    let sent = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) {
          controller.close();
          return;
        }
        sent = true;
        controller.enqueue(encoded.slice(0, split));
        controller.enqueue(encoded.slice(split));
      }
    }, { highWaterMark: 0 });
    const client = new NewznabClient({
      id: "indexer",
      name: "Indexer",
      baseUrl: "https://indexer.test/api",
      apiKey: "secret",
      timeoutMs: 10_000,
      maxResponseBytes: encoded.byteLength,
      fetch: async () => new Response(stream)
    });

    const result = await client.search({
      term: "game",
      categories: [],
      reason: "canonical"
    });

    expect(result.releases[0]?.title).toBe("Game.🎮.NSW-GROUP");
  });
});
