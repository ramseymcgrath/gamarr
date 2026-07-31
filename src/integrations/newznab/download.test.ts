import { describe, expect, it, vi } from "vitest";

import { NewznabNzbFetcher } from "@/integrations/newznab/download";

const candidate = {
  id: "candidate",
  expiresAt: 2_000,
  indexerId: "indexer",
  indexerConfigRevision: 1,
  guid: "guid",
  title: "Game",
  size: null,
  downloadPath: "/api?t=get&id=guid",
  category: null,
  sourceSnapshot: "{}",
  createdAt: 1
};

const indexer = {
  id: "indexer",
  name: "Indexer",
  baseUrl: "https://indexer.test/api",
  apiKey: "indexer-secret",
  enabled: true,
  categoryIds: [],
  timeoutMs: 10_000,
  configRevision: 1,
  lastTestStatus: null,
  lastTestedAt: null,
  deletedAt: null,
  createdAt: 1,
  updatedAt: 1
};

describe("NewznabNzbFetcher", () => {
  it("retrieves bounded NZB bytes from the configured indexer origin", async () => {
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.origin).toBe("https://indexer.test");
      expect(url.searchParams.get("apikey")).toBe("indexer-secret");
      return new Response("<nzb />", {
        headers: { "content-type": "application/x-nzb" }
      });
    });

    const bytes = await new NewznabNzbFetcher(request).fetch({
      candidate,
      indexer,
      maxBytes: 100
    });

    expect(new TextDecoder().decode(bytes)).toBe("<nzb />");
  });

  it("rejects cross-origin redirects and oversized bodies", async () => {
    const redirecting = new NewznabNzbFetcher(async () =>
      new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data" }
      }));
    await expect(redirecting.fetch({
      candidate,
      indexer,
      maxBytes: 100
    })).rejects.toMatchObject({ code: "UNAVAILABLE" });

    const oversized = new NewznabNzbFetcher(async () =>
      new Response("x".repeat(101)));
    await expect(oversized.fetch({
      candidate,
      indexer,
      maxBytes: 100
    })).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
});
