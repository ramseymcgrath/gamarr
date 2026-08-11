import { z } from "zod";

import {
  parseFeed,
  type FeedRelease
} from "@/integrations/prowlarr/feed";
import { readBoundedResponse } from "@/integrations/read-bounded-response";
import { AppError } from "@/lib/errors";

const indexerSchema = z.object({
  id: z.union([z.number(), z.string()]),
  name: z.string().min(1),
  protocol: z.string(),
  enable: z.boolean().optional().default(true),
  priority: z.number().optional().default(25),
  capabilities: z
    .object({
      categories: z
        .array(z.object({ id: z.union([z.number(), z.string()]) }))
        .optional()
        .default([])
    })
    .optional()
    .default({ categories: [] })
});

export interface ProwlarrIndexer {
  id: string;
  name: string;
  protocol: "usenet" | "torrent";
  priority: number;
  categoryIds: string[];
}

export interface ProwlarrClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  fetch?: typeof fetch;
  maxResponseBytes?: number;
  maxItems?: number;
}

export class ProwlarrClient {
  private readonly request: typeof fetch;
  private readonly maxResponseBytes: number;
  private readonly maxItems: number;

  constructor(private readonly options: ProwlarrClientOptions) {
    this.request = options.fetch ?? fetch;
    this.maxResponseBytes = options.maxResponseBytes ?? 2 * 1024 * 1024;
    this.maxItems = options.maxItems ?? 1_000;
  }

  async listIndexers(signal?: AbortSignal): Promise<ProwlarrIndexer[]> {
    const url = this.apiUrl("api/v1/indexer");
    const body = await this.fetchBounded(url, "indexer list", signal, "json");
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      throw new AppError("UNAVAILABLE", 502, "Prowlarr returned invalid JSON");
    }
    const parsed = z.array(indexerSchema).safeParse(payload);
    if (!parsed.success) {
      throw new AppError(
        "UNAVAILABLE",
        502,
        "Prowlarr returned an invalid indexer list"
      );
    }
    return parsed.data
      .filter((entry) => entry.enable)
      .filter((entry) => entry.protocol === "usenet" || entry.protocol === "torrent")
      .map((entry) => ({
        id: String(entry.id),
        name: entry.name,
        protocol: entry.protocol as "usenet" | "torrent",
        priority: entry.priority,
        categoryIds: entry.capabilities.categories.map((category) =>
          String(category.id))
      }));
  }

  async search(
    indexer: ProwlarrIndexer,
    query: { term: string; categories: string[] },
    signal?: AbortSignal
  ): Promise<{ releases: FeedRelease[]; warnings: string[] }> {
    const url = this.apiUrl(`api/v1/indexer/${encodeURIComponent(indexer.id)}/newznab`);
    url.searchParams.set("t", "search");
    url.searchParams.set("q", query.term);
    url.searchParams.set("o", "xml");
    if (query.categories.length > 0) {
      url.searchParams.set("cat", query.categories.join(","));
    }
    const xml = await this.fetchBounded(url, "search", signal, "xml");
    return parseFeed(
      xml,
      { id: indexer.id, name: indexer.name, protocol: indexer.protocol },
      this.maxItems
    );
  }

  private apiUrl(path: string): URL {
    const url = new URL(this.options.baseUrl);
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/${path}`;
    url.search = "";
    url.hash = "";
    return url;
  }

  private async fetchBounded(
    url: URL,
    operation: string,
    signal: AbortSignal | undefined,
    kind: "json" | "xml"
  ): Promise<string> {
    const timeoutSignal = AbortSignal.timeout(this.options.timeoutMs);
    const response = await this.request(url, {
      // The key travels as a header so it never enters a URL Gamarr builds,
      // which is what keeps it out of logs and error paths.
      headers: {
        "x-api-key": this.options.apiKey,
        accept: kind === "json"
          ? "application/json"
          : "application/rss+xml, application/xml, text/xml"
      },
      redirect: "manual",
      signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
    });
    if (!response.ok) {
      throw new AppError("UNAVAILABLE", 502, `Prowlarr ${operation} failed`);
    }
    const bytes = await readBoundedResponse(
      response,
      this.maxResponseBytes,
      () => new AppError(
        "UNAVAILABLE",
        502,
        `Prowlarr ${operation} response is too large`
      )
    );
    return new TextDecoder().decode(bytes);
  }
}
