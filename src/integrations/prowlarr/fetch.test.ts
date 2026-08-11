import { describe, expect, it, vi } from "vitest";

import {
  ProwlarrFetcher,
  type PinnedRequest,
  type ProwlarrFetcherOptions
} from "@/integrations/prowlarr/fetch";

const apiKey = "prowlarr-secret";
const infoHash = "0123456789abcdef0123456789abcdef01234567";
const magnet = `magnet:?xt=urn:btih:${infoHash}`;

const lease = (response: Response) => ({
  response,
  release: async () => undefined
});

const candidate = {
  id: "candidate",
  expiresAt: 2_000,
  source: "newznab" as const,
  protocol: "usenet" as const,
  indexerId: "7",
  indexerConfigRevision: 1,
  guid: "guid",
  title: "Game",
  size: null,
  downloadPath: "/api/v1/indexer/7/download?link=guid",
  category: null,
  sourceSnapshot: "{}",
  createdAt: 1
};

const torrentCandidate = {
  ...candidate,
  protocol: "torrent" as const
};

function createFetcher(
  overrides: Partial<ProwlarrFetcherOptions> = {}
): ProwlarrFetcher {
  return new ProwlarrFetcher({
    baseUrl: "https://prowlarr.test",
    apiKey,
    timeoutMs: 10_000,
    ...overrides
  });
}

describe("ProwlarrFetcher", () => {
  it("retrieves bounded release bytes from the configured Prowlarr origin", async () => {
    const request = vi.fn(async (
      input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      const url = new URL(String(input));
      expect(url.origin).toBe("https://prowlarr.test");
      expect(url.href).not.toContain("apikey");
      expect(url.href).not.toContain(apiKey);
      expect(new Headers(init?.headers).get("x-api-key")).toBe(apiKey);
      return new Response("<nzb />", {
        headers: { "content-type": "application/x-nzb" }
      });
    });

    const result = await createFetcher({ fetch: request as typeof fetch }).fetch({
      candidate,
      magnetUrl: null,
      maxBytes: 100
    });

    expect(result.kind).toBe("nzb");
    if (result.kind !== "nzb") throw new Error("Expected NZB bytes");
    expect(new TextDecoder().decode(result.bytes)).toBe("<nzb />");
  });

  it("follows a candidate-bound HTTPS redirect without forwarding the configured API key", async () => {
    const request = vi.fn(async (
      input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      const url = new URL(String(input));
      expect(url.origin).toBe("https://prowlarr.test");
      expect(url.href).not.toContain(apiKey);
      expect(new Headers(init?.headers).get("x-api-key")).toBe(apiKey);
      return new Response(null, {
        status: 302,
        headers: {
          location: "https://downloads.example/get/guid?token=provider-secret"
        }
      });
    });
    const pinnedRequest = vi.fn(async (
      input: URL,
      init: RequestInit,
      addresses: readonly { address: string; family: number }[]
    ) => {
      expect(input.href).toBe(
        "https://downloads.example/get/guid?token=provider-secret"
      );
      expect(input.href).not.toContain(apiKey);
      expect(new Headers(init.headers).has("x-api-key")).toBe(false);
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

    const result = await createFetcher({
      fetch: request as typeof fetch,
      resolve,
      pinnedRequest: pinnedRequest as PinnedRequest
    }).fetch({
      candidate: {
        ...candidate,
        guid: "https://downloads.example/details/guid"
      },
      magnetUrl: null,
      maxBytes: 100
    });

    expect(result.kind).toBe("nzb");
    if (result.kind !== "nzb") throw new Error("Expected NZB bytes");
    expect(new TextDecoder().decode(result.bytes)).toBe("<nzb />");
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
    const pinnedRequest = vi.fn(async (input: URL) => {
      expect([...input.searchParams]).toEqual([["token", "needed"]]);
      return lease(new Response("<nzb />"));
    });

    await createFetcher({
      fetch: request as typeof fetch,
      resolve: async () => [{ address: "93.184.216.34", family: 4 }],
      pinnedRequest: pinnedRequest as PinnedRequest
    }).fetch({
      candidate: {
        ...candidate,
        guid: "https://downloads.example/details/guid"
      },
      magnetUrl: null,
      maxBytes: 100
    });
  });

  it("rejects the configured API key inside any decoded provider query value", async () => {
    for (const value of [
      apiKey,
      `prefix-${apiKey}-suffix`,
      "%70rowlarr-secret"
    ]) {
      const request = vi.fn(async () => new Response(null, {
        status: 302,
        headers: {
          location: `https://downloads.example/get/guid?token=${value}`
        }
      }));

      await expect(createFetcher({
        fetch: request as typeof fetch,
        resolve: async () => [{ address: "93.184.216.34", family: 4 }]
      }).fetch({
        candidate: {
          ...candidate,
          guid: "https://downloads.example/details/guid"
        },
        magnetUrl: null,
        maxBytes: 100
      })).rejects.toThrow("configured API credential");
    }
  });

  it("rejects a same-origin redirect that echoes the API key", async () => {
    const request = vi.fn(async () => new Response(null, {
      status: 302,
      headers: {
        location: `https://prowlarr.test/next?token=${apiKey}`
      }
    }));
    let thrown: unknown;

    try {
      await createFetcher({ fetch: request as typeof fetch }).fetch({
        candidate,
        magnetUrl: null,
        maxBytes: 100
      });
    } catch (error) {
      thrown = error;
    }

    expect(request).toHaveBeenCalledTimes(1);
    expect(thrown).toMatchObject({ code: "UNAVAILABLE" });
    expect((thrown as Error).message).not.toContain(apiKey);
  });

  it("rejects redirects that do not match the candidate GUID origin", async () => {
    const request = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: "https://other.example/get/guid" }
    }));

    await expect(createFetcher({ fetch: request as typeof fetch }).fetch({
      candidate: {
        ...candidate,
        guid: "https://downloads.example/details/guid"
      },
      magnetUrl: null,
      maxBytes: 100
    })).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("rejects candidate-bound redirects that resolve to a non-public address", async () => {
    const request = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: "https://downloads.example/get/guid" }
    }));

    await expect(createFetcher({
      fetch: request as typeof fetch,
      resolve: async () => [{ address: "169.254.169.254", family: 4 }]
    }).fetch({
      candidate: {
        ...candidate,
        guid: "https://downloads.example/details/guid"
      },
      magnetUrl: null,
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

    await expect(createFetcher({
      fetch: request as typeof fetch,
      resolve,
      pinnedRequest: pinnedRequest as PinnedRequest
    }).fetch({
      candidate: {
        ...candidate,
        guid: "https://downloads.example/details/guid"
      },
      magnetUrl: null,
      maxBytes: 100
    })).rejects.toThrow("non-public address");
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("rejects oversized release payload bodies", async () => {
    const request = vi.fn(async () => new Response("x".repeat(101)));

    await expect(createFetcher({ fetch: request as typeof fetch }).fetch({
      candidate,
      magnetUrl: null,
      maxBytes: 100
    })).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("returns a feed-supplied magnet without making a request", async () => {
    const request = vi.fn(async () => {
      throw new Error("HTTP request must not be made");
    });

    await expect(createFetcher({ fetch: request as typeof fetch }).fetch({
      candidate: torrentCandidate,
      magnetUrl: magnet,
      maxBytes: 100
    })).resolves.toEqual({ kind: "magnet", uri: magnet });
    expect(request).not.toHaveBeenCalled();
  });

  it("returns a magnet from a redirect Location", async () => {
    const request = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: magnet }
    }));

    await expect(createFetcher({ fetch: request as typeof fetch }).fetch({
      candidate: torrentCandidate,
      magnetUrl: null,
      maxBytes: 100
    })).resolves.toEqual({ kind: "magnet", uri: magnet });
  });

  it("rejects a redirect magnet that echoes the API key", async () => {
    const unsafe = `${magnet}&tr=https%3A%2F%2Ftracker.test%2F${apiKey}`;
    const request = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: unsafe }
    }));
    let thrown: unknown;

    try {
      await createFetcher({ fetch: request as typeof fetch }).fetch({
        candidate: torrentCandidate,
        magnetUrl: null,
        maxBytes: 100
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({ code: "VALIDATION" });
    expect((thrown as Error).message).not.toContain(apiKey);
    expect((thrown as Error).message).not.toContain(infoHash);
  });

  it("rejects a feed-supplied magnet with a non-btih topic", async () => {
    const request = vi.fn(async () => {
      throw new Error("HTTP request must not be made");
    });

    await expect(createFetcher({ fetch: request as typeof fetch }).fetch({
      candidate: torrentCandidate,
      magnetUrl: "magnet:?xt=urn:sha1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      maxBytes: 100
    })).rejects.toMatchObject({ reason: "unsupportedTopic" });
    expect(request).not.toHaveBeenCalled();
  });

  it("labels a torrent-protocol body as kind torrent", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const request = vi.fn(async () => new Response(bytes));

    await expect(createFetcher({ fetch: request as typeof fetch }).fetch({
      candidate: torrentCandidate,
      magnetUrl: null,
      maxBytes: 100
    })).resolves.toEqual({ kind: "torrent", bytes });
  });

  it("labels a usenet-protocol body as kind nzb", async () => {
    const bytes = new Uint8Array([4, 5, 6]);
    const request = vi.fn(async () => new Response(bytes));

    await expect(createFetcher({ fetch: request as typeof fetch }).fetch({
      candidate,
      magnetUrl: null,
      maxBytes: 100
    })).resolves.toEqual({ kind: "nzb", bytes });
  });

  it("rejects a body larger than maxBytes", async () => {
    const request = vi.fn(async () => new Response("small", {
      headers: { "content-length": "101" }
    }));

    await expect(createFetcher({ fetch: request as typeof fetch }).fetch({
      candidate,
      magnetUrl: null,
      maxBytes: 100
    })).rejects.toThrow("release payload exceeded the size limit");
  });
});
