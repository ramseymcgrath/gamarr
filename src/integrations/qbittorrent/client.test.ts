import { describe, expect, it, vi } from "vitest";

import { TorrentAddError } from "@/features/downloads/port";
import { QbittorrentClient } from "@/integrations/qbittorrent/client";

function client(
  fetchImpl: typeof fetch,
  options: { baseUrl?: string; maxResponseBytes?: number } = {}
) {
  return new QbittorrentClient({
    baseUrl: options.baseUrl ?? "http://qbit.lan:8080",
    username: "admin",
    password: "hunter2",
    maxResponseBytes: options.maxResponseBytes,
    fetch: fetchImpl
  });
}

function loginOk(): Response {
  return new Response("Ok.", {
    status: 200,
    headers: { "set-cookie": "SID=abc123; path=/" }
  });
}

describe("QbittorrentClient", () => {
  it("logs in once and reuses the SID cookie", async () => {
    const calls: Request[] = [];
    const fetchImpl = vi.fn(async (
      input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      const url = String(input);
      calls.push(new Request(url, init));
      if (url.includes("/auth/login")) return loginOk();
      return Response.json([]);
    }) as unknown as typeof fetch;
    const subject = client(fetchImpl);

    await subject.list();
    await subject.list();

    expect(calls.filter((call) => call.url.includes("/auth/login"))).toHaveLength(1);
    const listings = calls.filter((call) => call.url.includes("/torrents/info"));
    expect(listings[0]!.headers.get("cookie")).toBe("SID=abc123");
    expect(listings[1]!.headers.get("cookie")).toBe("SID=abc123");
  });

  it("sends the base origin as Referer on every request", async () => {
    const requests: Request[] = [];
    const fetchImpl = vi.fn(async (
      input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      requests.push(new Request(input, init));
      return String(input).includes("/auth/login") ? loginOk() : Response.json([]);
    }) as unknown as typeof fetch;

    await client(fetchImpl, { baseUrl: "http://qbit.lan:8080/qbit/" }).list();

    expect(requests.map((request) => request.headers.get("referer"))).toEqual([
      "http://qbit.lan:8080",
      "http://qbit.lan:8080"
    ]);
    expect(requests[1]!.url).toBe(
      "http://qbit.lan:8080/qbit/api/v2/torrents/info"
    );
  });

  it("uses manual redirects and a timeout signal on every request", async () => {
    const initializers: RequestInit[] = [];
    const fetchImpl = vi.fn(async (
      input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      initializers.push(init ?? {});
      return String(input).includes("/auth/login") ? loginOk() : Response.json([]);
    }) as unknown as typeof fetch;

    await client(fetchImpl).list();

    expect(initializers).toHaveLength(2);
    for (const init of initializers) {
      expect(init.redirect).toBe("manual");
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("re-logs in once when a request comes back 403", async () => {
    let loginCalls = 0;
    let listCalls = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/auth/login")) {
        loginCalls += 1;
        return loginOk();
      }
      listCalls += 1;
      return listCalls === 1
        ? new Response("Forbidden", { status: 403 })
        : Response.json([]);
    }) as unknown as typeof fetch;

    await expect(client(fetchImpl).list()).resolves.toEqual([]);
    expect(loginCalls).toBe(2);
    expect(listCalls).toBe(2);
  });

  it("stops after a second 403", async () => {
    let loginCalls = 0;
    let listCalls = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/auth/login")) {
        loginCalls += 1;
        return loginOk();
      }
      listCalls += 1;
      return new Response("credentialed upstream response", { status: 403 });
    }) as unknown as typeof fetch;

    const error = await client(fetchImpl).list().catch((value: unknown) => value);

    expect(error).toMatchObject({
      code: "UNAVAILABLE",
      message: "qBittorrent torrent list request failed"
    });
    expect(loginCalls).toBe(2);
    expect(listCalls).toBe(2);
  });

  it("submits the torrent, category, and tag and reads a WebAPI 2.14 hash", async () => {
    const capture: { form?: FormData } = {};
    const fetchImpl = vi.fn(async (
      input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      if (String(input).includes("/auth/login")) return loginOk();
      capture.form = init?.body as FormData;
      return Response.json({
        added_torrent_ids: ["8c212779b4abde7c6bc608063a0d008b7e40ce32"],
        success_count: 1,
        pending_count: 0,
        failure_count: 0
      });
    }) as unknown as typeof fetch;
    const torrent = new Uint8Array([1, 2, 3]);

    await expect(client(fetchImpl).add({
      torrent,
      filename: "item.torrent",
      category: "games",
      tag: "gamarr-1"
    })).resolves.toEqual({
      hash: "8c212779b4abde7c6bc608063a0d008b7e40ce32"
    });

    expect(capture.form?.get("category")).toBe("games");
    expect(capture.form?.get("tags")).toBe("gamarr-1");
    const file = capture.form?.get("torrents") as File;
    expect(file.name).toBe("item.torrent");
    expect(file.type).toBe("application/x-bittorrent");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(torrent);
  });

  it("omits a null category and accepts a legacy Ok. response", async () => {
    const capture: { form?: FormData } = {};
    const fetchImpl = vi.fn(async (
      input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      if (String(input).includes("/auth/login")) return loginOk();
      capture.form = init?.body as FormData;
      return new Response("Ok.");
    }) as unknown as typeof fetch;

    await expect(client(fetchImpl).add({
      torrent: new Uint8Array([1]),
      filename: "item.torrent",
      category: null,
      tag: "gamarr-1"
    })).resolves.toEqual({ hash: null });
    expect(capture.form?.has("category")).toBe(false);
  });

  it.each([
    [415, "rejected"],
    [409, "rejected"],
    [500, "ambiguous"],
    [502, "ambiguous"]
  ] as const)("maps add status %i to %s", async (status, outcome) => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes("/auth/login")
        ? loginOk()
        : new Response("upstream secret response", { status })) as unknown as typeof fetch;

    const error = await client(fetchImpl).add({
      torrent: new Uint8Array([1]),
      filename: "item.torrent",
      category: null,
      tag: "gamarr-1"
    }).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(TorrentAddError);
    expect(error).toMatchObject({ outcome });
    expect((error as Error).message).not.toContain("upstream secret response");
  });

  it("treats a network failure during add as ambiguous without leaking it", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/auth/login")) return loginOk();
      throw new Error("socket hang up: http://admin:hunter2@qbit.lan:8080");
    }) as unknown as typeof fetch;

    const error = await client(fetchImpl).add({
      torrent: new Uint8Array([1]),
      filename: "item.torrent",
      category: null,
      tag: "gamarr-1"
    }).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(TorrentAddError);
    expect(error).toMatchObject({ outcome: "ambiguous" });
    expect((error as Error).message).not.toContain("hunter2");
    expect((error as Error).message).not.toContain("qbit.lan");
  });

  it("returns no hash for a successful JSON response with no ids", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes("/auth/login")
        ? loginOk()
        : Response.json({ added_torrent_ids: [] })) as unknown as typeof fetch;

    await expect(client(fetchImpl).add({
      torrent: new Uint8Array([1]),
      filename: "item.torrent",
      category: null,
      tag: "gamarr-1"
    })).resolves.toEqual({ hash: null });
  });

  it("parses tags and clamps scaled progress", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes("/auth/login")
        ? loginOk()
        : Response.json([
          {
            hash: "abc",
            tags: "gamarr-1, other",
            state: "downloading",
            progress: 0.161
          },
          { hash: "low", state: "stalledDL", progress: -0.2 },
          { hash: "high", tags: "", state: "uploading", progress: 1.5 }
        ])) as unknown as typeof fetch;

    await expect(client(fetchImpl).list()).resolves.toEqual([
      {
        hash: "abc",
        tags: ["gamarr-1", "other"],
        state: "downloading",
        progress: 16
      },
      { hash: "low", tags: [], state: "stalledDL", progress: 0 },
      { hash: "high", tags: [], state: "uploading", progress: 100 }
    ]);
  });

  it("bounds torrent-list JSON responses", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes("/auth/login")
        ? loginOk()
        : new Response("[" + " ".repeat(128) + "]")) as unknown as typeof fetch;

    await expect(client(fetchImpl, { maxResponseBytes: 32 }).list()).rejects.toMatchObject({
      code: "UNAVAILABLE",
      message: "qBittorrent torrent list response is too large"
    });
  });

  it("replaces invalid torrent-list JSON with a fixed message", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes("/auth/login")
        ? loginOk()
        : new Response("not json: http://admin:hunter2@qbit.lan")) as unknown as typeof fetch;

    const error = await client(fetchImpl).list().catch((value: unknown) => value);

    expect(error).toMatchObject({
      code: "UNAVAILABLE",
      message: "qBittorrent returned an invalid torrent list"
    });
    expect((error as Error).message).not.toContain("hunter2");
  });

  it("replaces login failures with a fixed message", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("invalid password hunter2", { status: 401 })) as unknown as typeof fetch;

    const error = await client(fetchImpl).list().catch((value: unknown) => value);

    expect(error).toMatchObject({
      code: "UNAVAILABLE",
      message: "Could not authenticate with qBittorrent"
    });
    expect((error as Error).message).not.toContain("hunter2");
  });

  it("tests the connection through the torrent list", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes("/auth/login") ? loginOk() : Response.json([])
    ) as unknown as typeof fetch;

    await expect(client(fetchImpl).testConnection()).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
