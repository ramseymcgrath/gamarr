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

/**
 * What qBittorrent 5.x actually answers `auth/login` with, verified against a
 * live v5.2.3 / WebAPI 2.15.1 instance: HTTP 204, no body, and a session
 * cookie named `QBT_SID_<webui-port>` rather than the bare `SID` the WebUI
 * documentation describes. The `expires` attribute carries a comma, which is
 * why the parser cannot treat commas as cookie separators.
 */
function loginOkModern(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "set-cookie":
        "QBT_SID_8080=Xk9rT2mQ4vB8nL1pZ0wYcE7hJ3sA6dF5; HttpOnly; "
        + "SameSite=Lax; expires=Tue, 04-Aug-2026 18:06:55 GMT; path=/"
    }
  });
}

describe("QbittorrentClient", () => {
  it("authenticates against a qBittorrent 5.x QBT_SID cookie and 204", async () => {
    const calls: Request[] = [];
    const fetchImpl = vi.fn(async (
      input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      const url = String(input);
      calls.push(new Request(url, init));
      if (url.includes("/auth/login")) return loginOkModern();
      return Response.json([]);
    }) as unknown as typeof fetch;

    await client(fetchImpl).list();

    const listing = calls.find((call) => call.url.includes("/torrents/info"));
    expect(listing!.headers.get("cookie"))
      .toBe("QBT_SID_8080=Xk9rT2mQ4vB8nL1pZ0wYcE7hJ3sA6dF5");
  });

  it("rejects rather than obscures an add that failed to authenticate", async () => {
    let addCalls = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/auth/login")) {
        return new Response("Fails.", { status: 403 });
      }
      addCalls += 1;
      return Response.json({});
    }) as unknown as typeof fetch;

    const error = await client(fetchImpl).add({
      payload: {
        torrent: new Uint8Array([1]),
        filename: "item.torrent"
      },
      category: null,
      tag: "gamarr-1"
    }).catch((value: unknown) => value);

    // Nothing was submitted: ensureLogin() throws before any bytes leave. An
    // "ambiguous" verdict would park the attempt in Unknown, which is never
    // resubmitted automatically, and bury the actionable auth message.
    expect(error).toBeInstanceOf(TorrentAddError);
    expect((error as TorrentAddError).outcome).toBe("rejected");
    expect((error as TorrentAddError).message).toMatch(/authenticate/i);
    expect(addCalls).toBe(0);
  });

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

  it("submits a magnet through the urls field", async () => {
    const capture: { form?: FormData } = {};
    const fetchImpl = vi.fn(async (
      input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      if (String(input).includes("/auth/login")) return loginOk();
      capture.form = init?.body as FormData;
      return Response.json({ added_torrent_ids: [] });
    }) as unknown as typeof fetch;
    const magnet =
      "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567";

    await expect(client(fetchImpl).add({
      payload: { magnet },
      category: null,
      tag: "gamarr-1"
    })).resolves.toEqual({ hash: null });

    expect(capture.form?.get("urls")).toBe(magnet);
    expect(capture.form?.has("torrents")).toBe(false);
  });

  it("still submits torrent bytes as a file part", async () => {
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
      payload: { torrent, filename: "item.torrent" },
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
      payload: {
        torrent: new Uint8Array([1]),
        filename: "item.torrent"
      },
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
      payload: {
        torrent: new Uint8Array([1]),
        filename: "item.torrent"
      },
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
      payload: {
        torrent: new Uint8Array([1]),
        filename: "item.torrent"
      },
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
      payload: {
        torrent: new Uint8Array([1]),
        filename: "item.torrent"
      },
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

  it("lists files with their indices", async () => {
    const calls: Request[] = [];
    const fetchImpl = vi.fn(async (
      input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      calls.push(new Request(input, init));
      if (String(input).includes("/auth/login")) return loginOk();
      return Response.json([
        { name: "a", index: 0, progress: 0.5, priority: 1 },
        { name: "b", index: 1, progress: 1, priority: 0 }
      ]);
    }) as unknown as typeof fetch;

    await expect(client(fetchImpl).listFiles("torrent-hash")).resolves.toEqual([
      { name: "a", index: 0, progress: 0.5, priority: 1 },
      { name: "b", index: 1, progress: 1, priority: 0 }
    ]);

    const listing = calls.find((call) => call.url.includes("/torrents/files"));
    expect(new URL(listing!.url).searchParams.get("hash")).toBe("torrent-hash");
  });

  it("falls back to array position when index is absent", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes("/auth/login")
        ? loginOk()
        : Response.json([
          { name: "a", progress: 0, priority: 1 },
          { name: "b", progress: 0, priority: 1 }
        ])
    ) as unknown as typeof fetch;

    await expect(client(fetchImpl).listFiles("torrent-hash")).resolves.toEqual([
      { name: "a", index: 0, progress: 0, priority: 1 },
      { name: "b", index: 1, progress: 0, priority: 1 }
    ]);
  });

  it("returns an empty list when metadata has not arrived", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes("/auth/login") ? loginOk() : Response.json([])
    ) as unknown as typeof fetch;

    await expect(client(fetchImpl).listFiles("torrent-hash")).resolves.toEqual([]);
  });

  it("throws UNAVAILABLE when the file list is invalid", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes("/auth/login")
        ? loginOk()
        : Response.json([{ name: "" }])
    ) as unknown as typeof fetch;

    await expect(client(fetchImpl).listFiles("torrent-hash"))
      .rejects.toMatchObject({
        code: "UNAVAILABLE",
        message: "qBittorrent returned an invalid file list"
      });
  });

  it("posts a pipe-separated id list to filePrio", async () => {
    const calls: Request[] = [];
    const fetchImpl = vi.fn(async (
      input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      calls.push(new Request(input, init));
      return String(input).includes("/auth/login")
        ? loginOk()
        : new Response("Ok.");
    }) as unknown as typeof fetch;

    await expect(
      client(fetchImpl).setFilePriorities("torrent-hash", [1, 3], 0)
    ).resolves.toBeUndefined();

    const priority = calls.find((call) => call.url.includes("/torrents/filePrio"));
    expect(priority?.method).toBe("POST");
    expect(priority?.headers.get("content-type"))
      .toBe("application/x-www-form-urlencoded");
    const body = new URLSearchParams(await priority!.text());
    expect(Object.fromEntries(body)).toEqual({
      hash: "torrent-hash",
      id: "1|3",
      priority: "0"
    });
  });

  it("makes no request when the index list is empty", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("request must not be made");
    }) as unknown as typeof fetch;

    await expect(
      client(fetchImpl).setFilePriorities("torrent-hash", [], 0)
    ).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("add sends stopped=true", async () => {
    const calls: Request[] = [];
    const fetchImpl = vi.fn(async (
      input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      calls.push(new Request(input, init));
      return String(input).includes("/auth/login")
        ? loginOk()
        : Response.json({ added_torrent_ids: ["h"] });
    }) as unknown as typeof fetch;

    await client(fetchImpl).add({
      payload: { magnet: "magnet:?xt=urn:btih:h" },
      category: null,
      tag: "gamarr-1",
      stopped: true
    });
    const add = calls.find((call) => call.url.includes("/torrents/add"));
    expect((await add!.formData()).get("stopped")).toBe("true");
  });

  it("add omits stopped by default", async () => {
    const calls: Request[] = [];
    const fetchImpl = vi.fn(async (
      input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      calls.push(new Request(input, init));
      return String(input).includes("/auth/login")
        ? loginOk()
        : Response.json({ added_torrent_ids: ["h"] });
    }) as unknown as typeof fetch;

    await client(fetchImpl).add({
      payload: { magnet: "magnet:?xt=urn:btih:h" },
      category: null,
      tag: "gamarr-1"
    });
    const add = calls.find((call) => call.url.includes("/torrents/add"));
    expect((await add!.formData()).has("stopped")).toBe(false);
  });

  it("listFiles 404 maps to NOT_FOUND", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes("/auth/login")
        ? loginOk()
        : new Response("Not Found", { status: 404 })
    ) as unknown as typeof fetch;

    await expect(client(fetchImpl).listFiles("torrent-hash"))
      .rejects.toMatchObject({
        code: "NOT_FOUND",
        status: 404,
        message: "qBittorrent does not have this torrent yet"
      });
  });

  it("parses a 2,065-file response", async () => {
    const files = Array.from({ length: 2065 }, (_, index) => ({
      name: `disc/file-${index}.bin`,
      index,
      progress: index / 2065,
      priority: 0
    }));
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes("/auth/login") ? loginOk() : Response.json(files)
    ) as unknown as typeof fetch;

    const result = await client(fetchImpl).listFiles("torrent-hash");
    expect(result).toHaveLength(2065);
    expect(result[2064]).toEqual(files[2064]);
  });

  it("setFilePriorities sends one request for 2,065 indices", async () => {
    const calls: Request[] = [];
    const fetchImpl = vi.fn(async (
      input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      calls.push(new Request(input, init));
      return String(input).includes("/auth/login")
        ? loginOk()
        : new Response("Ok.");
    }) as unknown as typeof fetch;
    const indices = Array.from({ length: 2065 }, (_, index) => index);

    await client(fetchImpl).setFilePriorities("torrent-hash", indices, 1);

    const prio = calls.filter((call) => call.url.includes("/torrents/filePrio"));
    expect(prio).toHaveLength(1);
    const body = new URLSearchParams(await prio[0]!.text());
    expect(body.get("id")).toBe(indices.join("|"));
    expect(body.get("priority")).toBe("1");
  });

  it("addTags and start post the hash", async () => {
    const calls: Request[] = [];
    const fetchImpl = vi.fn(async (
      input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      calls.push(new Request(input, init));
      return String(input).includes("/auth/login")
        ? loginOk()
        : new Response("Ok.");
    }) as unknown as typeof fetch;
    const subject = client(fetchImpl);

    await subject.addTags("torrent-hash", "gamarr-pick");
    await subject.start("torrent-hash");

    const tags = calls.find((call) => call.url.includes("/torrents/addTags"));
    expect(tags?.method).toBe("POST");
    expect(Object.fromEntries(new URLSearchParams(await tags!.text()))).toEqual({
      hashes: "torrent-hash",
      tags: "gamarr-pick"
    });
    const start = calls.find((call) => call.url.includes("/torrents/start"));
    expect(start?.method).toBe("POST");
    expect(Object.fromEntries(new URLSearchParams(await start!.text()))).toEqual({
      hashes: "torrent-hash"
    });
  });

  it("addTags surfaces a failed request as UNAVAILABLE", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes("/auth/login")
        ? loginOk()
        : new Response("no", { status: 500 })
    ) as unknown as typeof fetch;
    await expect(client(fetchImpl).start("h")).rejects.toMatchObject({
      code: "UNAVAILABLE"
    });
  });

  it("list maps save_path", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes("/auth/login")
        ? loginOk()
        : Response.json([
          { hash: "a", state: "x", progress: 0, save_path: "/downloads/" },
          { hash: "b", state: "x", progress: 0 }
        ])) as unknown as typeof fetch;

    const jobs = await client(fetchImpl).list();
    expect(jobs[0]!.savePath).toBe("/downloads/");
    expect(jobs[1]).not.toHaveProperty("savePath");
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
