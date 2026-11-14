import { describe, expect, it, vi } from "vitest";

import packageJson from "../../../package.json";
import {
  GAMARR_USER_AGENT,
  InternetArchiveClient,
  parseRetryAfter,
  type InternetArchiveSearchCache
} from "@/integrations/internet-archive/client";

type FetchCall = { url: URL; init: RequestInit };

function searchBody(docs: unknown[]): Response {
  return new Response(JSON.stringify({ response: { docs } }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

const doc = {
  identifier: "guitar-hero-ii-usa",
  title: "Guitar Hero II (USA)",
  year: "2006",
  downloads: 1234,
  item_size: 4_000_000_000
};

function clientWith(
  responses: Array<Response | Error>,
  options: {
    now?: () => number;
    cache?: InternetArchiveSearchCache;
    maxRetries?: number;
  } = {}
) {
  const calls: FetchCall[] = [];
  const sleeps: number[] = [];
  const queue = [...responses];
  const request = vi.fn(async (url: URL | string, init?: RequestInit) => {
    calls.push({ url: new URL(url), init: init ?? {} });
    const next = queue.shift();
    if (!next) throw new Error("unexpected request");
    if (next instanceof Error) throw next;
    return next;
  });
  const client = new InternetArchiveClient({
    fetch: request as unknown as typeof fetch,
    searchCache: options.cache ?? new Map(),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: options.now ?? (() => 1_000_000),
    maxRetries: options.maxRetries
  });
  return { client, calls, sleeps };
}

function header(call: FetchCall | undefined, name: string): string | null {
  return new Headers(call?.init.headers).get(name);
}

describe("InternetArchiveClient User-Agent", () => {
  it("identifies gamarr and its version as archive.org bot policy requires", () => {
    expect(GAMARR_USER_AGENT).toBe(`gamarr/${packageJson.version}`);
  });

  it("sends the User-Agent on search requests", async () => {
    const { client, calls } = clientWith([searchBody([doc])]);
    await client.search({ title: "Guitar Hero II" });
    expect(header(calls[0], "user-agent")).toBe(GAMARR_USER_AGENT);
  });

  it("sends the User-Agent on every torrent hop, including data-node redirects", async () => {
    const { client, calls } = clientWith([
      new Response(null, {
        status: 302,
        headers: {
          location:
            "https://ia800100.us.archive.org/1/items/guitar-hero-ii-usa/guitar-hero-ii-usa_archive.torrent"
        }
      }),
      new Response(new Uint8Array([1, 2, 3]))
    ]);
    const bytes = await client.fetchTorrent("guitar-hero-ii-usa", 100);
    expect([...bytes]).toEqual([1, 2, 3]);
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => header(call, "user-agent")))
      .toEqual([GAMARR_USER_AGENT, GAMARR_USER_AGENT]);
    expect(calls[0]!.url.href).toBe(
      "https://archive.org/download/guitar-hero-ii-usa/guitar-hero-ii-usa_archive.torrent"
    );
    expect(calls.every((call) => call.init.redirect === "manual")).toBe(true);
  });
});

describe("InternetArchiveClient search", () => {
  it("queries software items by quoted title, sorted by downloads", async () => {
    const { client, calls } = clientWith([searchBody([doc])]);
    await client.search({ title: "Guitar Hero: II!" });
    const url = calls[0]!.url;
    expect(url.pathname).toBe("/advancedsearch.php");
    expect(url.searchParams.get("q"))
      .toBe('title:("Guitar Hero II") AND mediatype:software');
    expect(url.searchParams.getAll("sort[]")).toEqual(["downloads desc"]);
    expect(url.searchParams.get("output")).toBe("json");
  });

  it("returns canonical details and torrent URLs, never data-node hosts", async () => {
    const { client } = clientWith([searchBody([doc])]);
    const result = await client.search({ title: "Guitar Hero II" });
    expect(result.items).toEqual([{
      identifier: "guitar-hero-ii-usa",
      title: "Guitar Hero II (USA)",
      detailsUrl: "https://archive.org/details/guitar-hero-ii-usa",
      torrentUrl:
        "https://archive.org/download/guitar-hero-ii-usa/guitar-hero-ii-usa_archive.torrent",
      publishedAt: Date.UTC(2006, 0, 1),
      size: 4_000_000_000,
      downloads: 1234
    }]);
  });

  it("skips unsafe identifiers with a warning", async () => {
    const { client } = clientWith([
      searchBody([doc, { identifier: "../etc/passwd", title: "Bad" }])
    ]);
    const result = await client.search({ title: "Guitar Hero II" });
    expect(result.items).toHaveLength(1);
    expect(result.warnings).toEqual([
      "Ignored an Internet Archive result with missing or unsafe fields"
    ]);
  });

  it("makes no request for a title that sanitizes to nothing", async () => {
    const { client, calls } = clientWith([]);
    await expect(client.search({ title: "!!!" }))
      .resolves.toEqual({ items: [], warnings: [] });
    expect(calls).toHaveLength(0);
  });

  it("serves a repeat search from cache until the TTL passes", async () => {
    let now = 1_000_000;
    const cache: InternetArchiveSearchCache = new Map();
    const { client, calls } = clientWith(
      [searchBody([doc]), searchBody([doc])],
      { now: () => now, cache }
    );
    await client.search({ title: "Guitar Hero II" });
    await client.search({ title: "guitar hero ii" });
    expect(calls).toHaveLength(1);

    now += 10 * 60 * 1000 + 1;
    await client.search({ title: "Guitar Hero II" });
    expect(calls).toHaveLength(2);
  });

  it("does not cache a failed search", async () => {
    const cache: InternetArchiveSearchCache = new Map();
    const { client, calls } = clientWith(
      [new Response("nope", { status: 500 }), searchBody([doc])],
      { cache }
    );
    await expect(client.search({ title: "Guitar Hero II" }))
      .rejects.toThrow("Internet Archive search failed");
    await client.search({ title: "Guitar Hero II" });
    expect(calls).toHaveLength(2);
  });
});

describe("InternetArchiveClient rate limiting and retries", () => {
  it("honors Retry-After on 429 and then succeeds", async () => {
    const { client, calls, sleeps } = clientWith([
      new Response(null, { status: 429, headers: { "retry-after": "2" } }),
      searchBody([doc])
    ]);
    const result = await client.search({ title: "Guitar Hero II" });
    expect(result.items).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([2_000]);
  });

  it("fails instead of sleeping through a long Retry-After", async () => {
    const { client, calls, sleeps } = clientWith([
      new Response(null, { status: 429, headers: { "retry-after": "120" } })
    ]);
    await expect(client.search({ title: "Guitar Hero II" })).rejects.toThrow(
      "Internet Archive is rate limiting requests; try again later"
    );
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("reports rate limiting once retries are exhausted", async () => {
    const { client, calls, sleeps } = clientWith([
      new Response(null, { status: 429 }),
      new Response(null, { status: 429 }),
      new Response(null, { status: 429 })
    ]);
    await expect(client.search({ title: "Guitar Hero II" })).rejects.toThrow(
      "Internet Archive is rate limiting requests; try again later"
    );
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([500, 1_000]);
  });

  it("backs off exponentially on 503 without Retry-After", async () => {
    const { client, sleeps } = clientWith([
      new Response(null, { status: 503 }),
      new Response(null, { status: 503 }),
      searchBody([doc])
    ]);
    await client.search({ title: "Guitar Hero II" });
    expect(sleeps).toEqual([500, 1_000]);
  });

  it("retries network errors, then fails without leaking the cause message", async () => {
    const { client, calls } = clientWith([
      new Error("connect ECONNREFUSED https://archive.org/?secret"),
      new Error("connect ECONNREFUSED https://archive.org/?secret"),
      new Error("connect ECONNREFUSED https://archive.org/?secret")
    ]);
    const failure = client.search({ title: "Guitar Hero II" });
    await expect(failure).rejects.toThrow("Internet Archive is unreachable");
    await expect(failure).rejects.not.toThrow(/secret/);
    expect(calls).toHaveLength(3);
  });

  it("does not retry a non-transient error status", async () => {
    const { client, calls } = clientWith([
      new Response("missing", { status: 404 })
    ]);
    await expect(client.fetchTorrent("guitar-hero-ii-usa", 100))
      .rejects.toThrow("Internet Archive torrent retrieval failed");
    expect(calls).toHaveLength(1);
  });
});

describe("InternetArchiveClient torrent redirects", () => {
  it("rejects a redirect off archive.org", async () => {
    const { client } = clientWith([
      new Response(null, {
        status: 302,
        headers: { location: "https://evil.example/x.torrent" }
      })
    ]);
    await expect(client.fetchTorrent("guitar-hero-ii-usa", 100))
      .rejects.toThrow("Internet Archive returned an unsafe redirect");
  });

  it("rejects an invalid identifier before any request", async () => {
    const { client, calls } = clientWith([]);
    await expect(client.fetchTorrent("../x", 100))
      .rejects.toThrow("Invalid Internet Archive identifier");
    expect(calls).toHaveLength(0);
  });

  it("bounds the torrent size", async () => {
    const { client } = clientWith([new Response(new Uint8Array(200))]);
    await expect(client.fetchTorrent("guitar-hero-ii-usa", 100))
      .rejects.toThrow("Internet Archive torrent exceeded the size limit");
  });
});

describe("parseRetryAfter", () => {
  it("reads delta-seconds and HTTP dates", () => {
    expect(parseRetryAfter("3", 0)).toBe(3_000);
    expect(parseRetryAfter("Thu, 01 Jan 1970 00:00:05 GMT", 1_000)).toBe(4_000);
    expect(parseRetryAfter("Thu, 01 Jan 1970 00:00:05 GMT", 9_000)).toBe(0);
    expect(parseRetryAfter("soon", 0)).toBeNull();
    expect(parseRetryAfter(null, 0)).toBeNull();
  });
});
