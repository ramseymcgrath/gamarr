import { z } from "zod";

import {
  TorrentAddError,
  type TorrentClientPort,
  type TorrentJob
} from "@/features/downloads/port";
import { readBoundedJson } from "@/integrations/read-bounded-response";
import { AppError } from "@/lib/errors";

interface QbittorrentClientOptions {
  baseUrl: string;
  username: string;
  password: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetch?: typeof fetch;
}

/** Large enough for a large torrent list, while keeping every JSON read bounded. */
const defaultMaxResponseBytes = 8 * 1024 * 1024;

const addResponseSchema = z.object({
  added_torrent_ids: z.array(z.string().min(1)).optional()
});

const torrentJobSchema = z.object({
  hash: z.string().min(1),
  tags: z.string().optional().default(""),
  state: z.string(),
  progress: z.number()
});

async function discardBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

export class QbittorrentClient implements TorrentClientPort {
  private readonly request: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly baseUrl: URL;
  private readonly referer: string;
  private sidCookie: string | null = null;
  private loginPromise: Promise<void> | null = null;

  constructor(private readonly options: QbittorrentClientOptions) {
    this.request = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxResponseBytes = options.maxResponseBytes ?? defaultMaxResponseBytes;
    try {
      this.baseUrl = new URL(options.baseUrl);
    } catch {
      throw new AppError("VALIDATION", 400, "qBittorrent base URL is invalid");
    }
    this.referer = this.baseUrl.origin;
  }

  async add(input: {
    torrent: Uint8Array;
    filename: string;
    category: string | null;
    tag: string;
  }): Promise<{ hash: string | null }> {
    const form = new FormData();
    form.set(
      "torrents",
      new Blob([new Uint8Array(input.torrent)], {
        type: "application/x-bittorrent"
      }),
      input.filename
    );
    form.set("tags", input.tag);
    if (input.category !== null) form.set("category", input.category);

    let response: Response;
    try {
      response = await this.authenticatedRequest("torrents/add", {
        method: "POST",
        body: form
      });
    } catch {
      throw new TorrentAddError(
        "ambiguous",
        "qBittorrent did not confirm the torrent submission"
      );
    }

    if (!response.ok) {
      await discardBody(response);
      const rejected = response.status === 409 || response.status === 415;
      throw new TorrentAddError(
        rejected ? "rejected" : "ambiguous",
        rejected
          ? "qBittorrent rejected the torrent submission"
          : "qBittorrent did not confirm the torrent submission"
      );
    }

    let payload: unknown;
    try {
      payload = await readBoundedJson(
        response,
        this.maxResponseBytes,
        () => new TorrentAddError(
          "ambiguous",
          "qBittorrent did not confirm the torrent submission"
        )
      );
    } catch (error) {
      if (error instanceof TorrentAddError) throw error;
      // WebAPI versions before 2.14 respond with the literal `Ok.`.
      return { hash: null };
    }

    const parsed = addResponseSchema.safeParse(payload);
    return { hash: parsed.success ? parsed.data.added_torrent_ids?.[0] ?? null : null };
  }

  async list(): Promise<TorrentJob[]> {
    let response: Response;
    try {
      response = await this.authenticatedRequest("torrents/info", {
        headers: { accept: "application/json" }
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        "UNAVAILABLE",
        502,
        "qBittorrent torrent list request failed"
      );
    }

    if (!response.ok) {
      await discardBody(response);
      throw new AppError(
        "UNAVAILABLE",
        502,
        "qBittorrent torrent list request failed"
      );
    }

    let payload: unknown;
    try {
      payload = await readBoundedJson(
        response,
        this.maxResponseBytes,
        () => new AppError(
          "UNAVAILABLE",
          502,
          "qBittorrent torrent list response is too large"
        )
      );
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        "UNAVAILABLE",
        502,
        "qBittorrent returned an invalid torrent list"
      );
    }

    const parsed = z.array(torrentJobSchema).safeParse(payload);
    if (!parsed.success) {
      throw new AppError(
        "UNAVAILABLE",
        502,
        "qBittorrent returned an invalid torrent list"
      );
    }

    return parsed.data.map((job) => ({
      hash: job.hash,
      tags: job.tags.split(",").map((tag) => tag.trim()).filter(Boolean),
      state: job.state,
      progress: Math.max(0, Math.min(100, Math.round(job.progress * 100)))
    }));
  }

  async testConnection(): Promise<void> {
    await this.list();
  }

  private apiUrl(path: string): URL {
    const url = new URL(this.baseUrl);
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/api/v2/${path.replace(/^\/+/, "")}`;
    url.search = "";
    url.hash = "";
    return url;
  }

  private rawRequest(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("referer", this.referer);
    if (this.sidCookie !== null) headers.set("cookie", this.sidCookie);
    return this.request(this.apiUrl(path), {
      ...init,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(this.timeoutMs)
    });
  }

  private async login(): Promise<void> {
    const form = new URLSearchParams({
      username: this.options.username,
      password: this.options.password
    });
    let response: Response;
    try {
      response = await this.rawRequest("auth/login", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form
      });
    } catch {
      throw new AppError(
        "UNAVAILABLE",
        502,
        "Could not authenticate with qBittorrent"
      );
    }

    const setCookie = response.headers.get("set-cookie");
    await discardBody(response);
    if (!response.ok) {
      throw new AppError(
        "UNAVAILABLE",
        502,
        "Could not authenticate with qBittorrent"
      );
    }
    // qBittorrent 4.x set a bare `SID`; 5.x names the session cookie
    // `QBT_SID_<webui-port>` (verified against v5.2.3 / WebAPI 2.15.1, which
    // returns `QBT_SID_8080` and answers the login with 204 and no body).
    // Both names are accepted and the pair is replayed verbatim, because the
    // name is part of what the server expects back.
    //
    // The value is bounded by `[^,;]` rather than split on commas: the header
    // carries an `expires=Tue, 04-Aug-2026 ...` attribute whose comma would
    // otherwise look like a cookie separator.
    const cookie = setCookie
      ?.match(/(?:^|[,;]\s*)((?:QBT_)?SID(?:_\d+)?)=([^,;]+)/i);
    const name = cookie?.[1];
    const value = cookie?.[2]?.trim();
    if (!name || !value) {
      throw new AppError(
        "UNAVAILABLE",
        502,
        "Could not authenticate with qBittorrent"
      );
    }
    this.sidCookie = `${name}=${value}`;
  }

  private ensureLogin(): Promise<void> {
    if (this.sidCookie !== null) return Promise.resolve();
    if (this.loginPromise === null) {
      this.loginPromise = this.login().finally(() => {
        this.loginPromise = null;
      });
    }
    return this.loginPromise;
  }

  private async authenticatedRequest(
    path: string,
    init: RequestInit
  ): Promise<Response> {
    await this.ensureLogin();
    let response = await this.rawRequest(path, init);
    if (response.status !== 403) return response;

    await discardBody(response);
    this.sidCookie = null;
    await this.ensureLogin();
    response = await this.rawRequest(path, init);
    return response;
  }
}
