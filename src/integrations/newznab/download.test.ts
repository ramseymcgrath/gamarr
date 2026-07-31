import { describe, expect, it, vi } from "vitest";

import { NewznabNzbFetcher } from "@/integrations/newznab/download";

const lease = (response: Response) => ({
  response,
  release: async () => undefined
});

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

  it("follows a candidate-bound HTTPS redirect without forwarding the configured API key", async () => {
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.origin).toBe("https://indexer.test");
      expect(url.searchParams.get("apikey")).toBe("indexer-secret");
      return new Response(null, {
        status: 302,
        headers: {
          location: "https://downloads.example/get/guid?token=provider-secret"
        }
      });
    });
    const pinnedRequest = vi.fn(async (
      input: RequestInfo | URL,
      _init: RequestInit,
      addresses: readonly { address: string; family: number }[]
    ) => {
      const url = new URL(String(input));
      expect(url.href).toBe(
        "https://downloads.example/get/guid?token=provider-secret"
      );
      expect(url.href).not.toContain("indexer-secret");
      expect(addresses).toEqual([
        { address: "93.184.216.34", family: 4 }
      ]);
      return lease(new Response("<nzb />", {
        headers: { "content-type": "application/x-nzb" }
      }));
    });
    const resolve = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 }
    ]);

    const bytes = await new NewznabNzbFetcher(
      request,
      resolve,
      pinnedRequest
    ).fetch({
      candidate: {
        ...candidate,
        guid: "https://downloads.example/details/guid"
      },
      indexer,
      maxBytes: 100
    });

    expect(new TextDecoder().decode(bytes)).toBe("<nzb />");
  });

  it("removes credential-named parameters from a provider redirect", async () => {
    const request = vi.fn(async () => new Response(null, {
      status: 302,
      headers: {
        location: [
          "https://downloads.example/get/guid",
          "?Api_Key=provider-secret&token=needed"
        ].join("")
      }
    }));
    const pinnedRequest = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect([...url.searchParams]).toEqual([["token", "needed"]]);
      return lease(new Response("<nzb />"));
    });

    await new NewznabNzbFetcher(
      request,
      async () => [{ address: "93.184.216.34", family: 4 }],
      pinnedRequest
    ).fetch({
      candidate: {
        ...candidate,
        guid: "https://downloads.example/details/guid"
      },
      indexer,
      maxBytes: 100
    });
  });

  it("rejects the configured API key inside any decoded provider query value", async () => {
    for (const value of [
      "indexer-secret",
      "prefix-indexer-secret-suffix",
      "%69ndexer-secret"
    ]) {
      const request = vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.origin === "https://indexer.test") {
          return new Response(null, {
            status: 302,
            headers: {
              location: `https://downloads.example/get/guid?token=${value}`
            }
          });
        }
        return new Response("<nzb />");
      });

      await expect(new NewznabNzbFetcher(
        request,
        async () => [{ address: "93.184.216.34", family: 4 }]
      ).fetch({
        candidate: {
          ...candidate,
          guid: "https://downloads.example/details/guid"
        },
        indexer,
        maxBytes: 100
      })).rejects.toThrow("configured API credential");
    }
  });

  it("rejects redirects that do not match the candidate GUID origin", async () => {
    const redirecting = new NewznabNzbFetcher(async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://other.example/get/guid" }
      }));
    await expect(redirecting.fetch({
      candidate: {
        ...candidate,
        guid: "https://downloads.example/details/guid"
      },
      indexer,
      maxBytes: 100
    })).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("rejects candidate-bound redirects that resolve to a non-public address", async () => {
    const redirecting = new NewznabNzbFetcher(
      async () => new Response(null, {
        status: 302,
        headers: { location: "https://downloads.example/get/guid" }
      }),
      async () => [{ address: "169.254.169.254", family: 4 }]
    );

    await expect(redirecting.fetch({
      candidate: {
        ...candidate,
        guid: "https://downloads.example/details/guid"
      },
      indexer,
      maxBytes: 100
    })).rejects.toThrow("non-public address");
  });

  it("revalidates DNS before every redirected request", async () => {
    const request = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: "https://downloads.example/get/guid" }
    }));
    const pinnedRequest = vi.fn(async () => lease(new Response(null, {
      status: 302,
      headers: { location: "https://downloads.example/get/final" }
    })));
    let lookupCount = 0;
    const resolve = vi.fn(async () => {
      lookupCount += 1;
      return [{
        address: lookupCount === 1 ? "93.184.216.34" : "127.0.0.1",
        family: 4
      }];
    });

    await expect(new NewznabNzbFetcher(
      request,
      resolve,
      pinnedRequest
    ).fetch({
      candidate: {
        ...candidate,
        guid: "https://downloads.example/details/guid"
      },
      indexer,
      maxBytes: 100
    })).rejects.toThrow("non-public address");
  });

  it("rejects oversized NZB bodies", async () => {
    const oversized = new NewznabNzbFetcher(async () =>
      new Response("x".repeat(101)));
    await expect(oversized.fetch({
      candidate,
      indexer,
      maxBytes: 100
    })).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
});
