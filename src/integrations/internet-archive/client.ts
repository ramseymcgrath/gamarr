import { z } from "zod";

import packageJson from "../../../package.json";
import { isValidInternetArchiveIdentifier } from "@/integrations/internet-archive/path-policy";
import { assertAllowedArchiveTarget } from "@/integrations/internet-archive/redirect-policy";
import {
  readBoundedJson,
  readBoundedResponse
} from "@/integrations/read-bounded-response";
import { AppError, validationError } from "@/lib/errors";

const DEFAULT_BASE_URL = "https://archive.org";

/**
 * archive.org requires every automated request to carry a User-Agent naming
 * the tool and its version (https://archive.org/developers/bots.html). Sent on
 * every request this client makes, including redirect hops to data nodes.
 */
export const GAMARR_USER_AGENT = `gamarr/${packageJson.version}`;

/**
 * `/advancedsearch.php` returns at most `maxItems` documents of six short
 * fields, which measures in kilobytes — 2 MiB is ~200x the observed payload.
 */
const DEFAULT_MAX_SEARCH_BYTES = 2 * 1024 * 1024;
const MAX_TORRENT_REDIRECTS = 3;

/** Retries after the first attempt, for 429/5xx and network errors. */
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_BACKOFF_MS = 500;
/**
 * A `Retry-After` longer than this fails the request instead of sleeping: the
 * caller is an interactive search with its own overall deadline, and archive.org
 * asking for a long pause is better surfaced than silently waited out.
 */
const DEFAULT_MAX_RETRY_AFTER_MS = 10_000;
/** Repeat searches for the same title within this window are served locally. */
const DEFAULT_SEARCH_CACHE_TTL_MS = 10 * 60 * 1000;
const SEARCH_CACHE_MAX_ENTRIES = 200;

export interface InternetArchiveItem {
  identifier: string;
  title: string;
  /** Canonical archive.org URL — never a data-node host. */
  detailsUrl: string;
  /** Canonical archive.org URL of the item's generated `_archive.torrent`. */
  torrentUrl: string;
  /** `null` when the item carries no parseable date — never a 0 sentinel. */
  publishedAt: number | null;
  size: number | null;
  downloads: number;
}

export interface InternetArchiveSearchResult {
  items: InternetArchiveItem[];
  warnings: string[];
}

type CacheEntry = { expiresAt: number; value: InternetArchiveSearchResult };
export type InternetArchiveSearchCache = Map<string, CacheEntry>;

/** Shared across client instances: dependencies are rebuilt per request. */
const sharedSearchCache: InternetArchiveSearchCache = new Map();

interface InternetArchiveClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  maxSearchBytes?: number;
  maxItems?: number;
  maxRetries?: number;
  backoffMs?: number;
  maxRetryAfterMs?: number;
  searchCacheTtlMs?: number;
  searchCache?: InternetArchiveSearchCache;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

/** IA advancedsearch occasionally returns a scalar *or* an array for the
 * same field, so every text facet accepts both. */
const multiText = z.union([
  z.union([z.string(), z.number()]).transform(String),
  z.array(z.union([z.string(), z.number()]))
    .transform((values) => values.map(String).join(" "))
]);

const searchDocSchema = z.object({
  identifier: z.string(),
  title: multiText.optional(),
  date: multiText.optional(),
  year: multiText.optional(),
  downloads: z.number().int().nonnegative().optional(),
  item_size: z.number().int().nonnegative().optional()
});

const searchResponseSchema = z.object({
  response: z.object({ docs: z.array(searchDocSchema) })
});

/**
 * Removes anything that could break out of the quoted Lucene phrase or split
 * the term into extra clauses. Kept close to the release-title normalizer so
 * catalog titles and IA queries line up.
 */
function sanitizeSearchTerm(title: string): string {
  return title
    .replace(/[^\p{L}\p{N} ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * `null`, not 0: Internet Archive software items frequently carry neither a
 * parseable `date` nor a plausible `year`, and a 0 sentinel renders as 1970.
 */
function parsePublishedAt(date?: string, year?: string): number | null {
  const parsed = date ? Date.parse(date) : Number.NaN;
  if (Number.isFinite(parsed)) return parsed;
  const yearNumber = year ? Number(year.slice(0, 4)) : Number.NaN;
  if (Number.isInteger(yearNumber) && yearNumber > 1900 && yearNumber < 3000) {
    return Date.UTC(yearNumber, 0, 1);
  }
  return null;
}

/** `Retry-After` is either delta-seconds or an HTTP date (RFC 9110 §10.2.3). */
export function parseRetryAfter(
  value: string | null,
  now: number
): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

export class InternetArchiveClient {
  private readonly request: typeof fetch;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxSearchBytes: number;
  private readonly maxItems: number;
  private readonly maxRetries: number;
  private readonly backoffMs: number;
  private readonly maxRetryAfterMs: number;
  private readonly searchCacheTtlMs: number;
  private readonly searchCache: InternetArchiveSearchCache;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly now: () => number;

  constructor(options: InternetArchiveClientOptions = {}) {
    this.request = options.fetch ?? fetch;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxSearchBytes = options.maxSearchBytes ?? DEFAULT_MAX_SEARCH_BYTES;
    this.maxItems = options.maxItems ?? 25;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.maxRetryAfterMs = options.maxRetryAfterMs
      ?? DEFAULT_MAX_RETRY_AFTER_MS;
    this.searchCacheTtlMs = options.searchCacheTtlMs
      ?? DEFAULT_SEARCH_CACHE_TTL_MS;
    this.searchCache = options.searchCache ?? sharedSearchCache;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
  }

  async search(
    input: { title: string },
    signal?: AbortSignal
  ): Promise<InternetArchiveSearchResult> {
    const term = sanitizeSearchTerm(input.title);
    if (!term) return { items: [], warnings: [] };

    const cacheKey = `${this.baseUrl}\n${term.toLowerCase()}`;
    const cached = this.searchCache.get(cacheKey);
    if (cached && cached.expiresAt > this.now()) return cached.value;

    const url = new URL("/advancedsearch.php", this.baseUrl);
    url.searchParams.set("q", `title:("${term}") AND mediatype:software`);
    for (const field of [
      "identifier",
      "title",
      "date",
      "year",
      "downloads",
      "item_size"
    ]) {
      url.searchParams.append("fl[]", field);
    }
    url.searchParams.set("rows", String(this.maxItems));
    url.searchParams.set("output", "json");
    url.searchParams.append("sort[]", "downloads desc");

    const response = await this.send(url, "application/json", signal);
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new AppError("UNAVAILABLE", 502, "Internet Archive search failed");
    }
    const payload = await readBoundedJson(
      response,
      this.maxSearchBytes,
      () => new AppError(
        "UNAVAILABLE",
        502,
        "Internet Archive response is too large"
      )
    );
    const parsed = searchResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new AppError(
        "UNAVAILABLE",
        502,
        "Internet Archive returned an unexpected search response"
      );
    }

    const items: InternetArchiveItem[] = [];
    const warnings: string[] = [];
    for (const doc of parsed.data.response.docs) {
      const title = doc.title?.trim();
      if (!title || !isValidInternetArchiveIdentifier(doc.identifier)) {
        warnings.push(
          "Ignored an Internet Archive result with missing or unsafe fields"
        );
        continue;
      }
      items.push({
        identifier: doc.identifier,
        title,
        detailsUrl: this.canonicalUrl(`/details/${encodeURIComponent(doc.identifier)}`),
        torrentUrl: this.canonicalUrl(torrentPath(doc.identifier)),
        publishedAt: parsePublishedAt(doc.date, doc.year),
        size: doc.item_size ?? null,
        downloads: doc.downloads ?? 0
      });
    }

    const value = { items, warnings };
    this.remember(cacheKey, value);
    return value;
  }

  /**
   * Fetches an item's generated `<identifier>_archive.torrent`. archive.org may
   * redirect the download to an HTTPS data node; those hops are followed (with
   * the same User-Agent) but never persisted — callers keep canonical URLs.
   */
  async fetchTorrent(
    identifier: string,
    maxBytes: number,
    signal?: AbortSignal
  ): Promise<Uint8Array> {
    if (!isValidInternetArchiveIdentifier(identifier)) {
      throw validationError("Invalid Internet Archive identifier");
    }
    const baseOrigin = new URL(this.baseUrl).origin;
    let target = new URL(torrentPath(identifier), `${baseOrigin}/`);
    for (
      let redirects = 0;
      redirects <= MAX_TORRENT_REDIRECTS;
      redirects += 1
    ) {
      const response = await this.send(
        target,
        "application/x-bittorrent, application/octet-stream",
        signal
      );
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel().catch(() => undefined);
        if (!location || redirects === MAX_TORRENT_REDIRECTS) {
          throw new AppError(
            "UNAVAILABLE",
            502,
            "Internet Archive returned an invalid redirect"
          );
        }
        const redirected = new URL(location, target);
        assertAllowedArchiveTarget(redirected, baseOrigin);
        target = redirected;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new AppError(
          "UNAVAILABLE",
          502,
          "Internet Archive torrent retrieval failed"
        );
      }
      return readBoundedResponse(
        response,
        maxBytes,
        () => new AppError(
          "UNAVAILABLE",
          502,
          "Internet Archive torrent exceeded the size limit"
        )
      );
    }
    throw new AppError(
      "UNAVAILABLE",
      502,
      "Internet Archive redirect limit exceeded"
    );
  }

  private canonicalUrl(path: string): string {
    return new URL(path, this.baseUrl).toString();
  }

  private remember(key: string, value: InternetArchiveSearchResult): void {
    if (this.searchCacheTtlMs <= 0) return;
    const now = this.now();
    for (const [existingKey, entry] of this.searchCache) {
      if (entry.expiresAt <= now) this.searchCache.delete(existingKey);
    }
    while (this.searchCache.size >= SEARCH_CACHE_MAX_ENTRIES) {
      const oldest = this.searchCache.keys().next().value;
      if (oldest === undefined) break;
      this.searchCache.delete(oldest);
    }
    this.searchCache.set(key, {
      expiresAt: now + this.searchCacheTtlMs,
      value
    });
  }

  /**
   * One HTTP exchange with archive.org's bot guidance applied: identifying
   * User-Agent, `429`/`Retry-After` honored, transient failures retried with
   * exponential backoff. Redirects are returned to the caller, never followed.
   * Errors never carry the upstream message or URL.
   */
  private async send(
    url: URL,
    accept: string,
    signal?: AbortSignal
  ): Promise<Response> {
    for (let attempt = 0; ; attempt += 1) {
      const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
      const combined = signal
        ? AbortSignal.any([signal, timeoutSignal])
        : timeoutSignal;
      let response: Response;
      try {
        response = await this.request(url, {
          headers: { accept, "user-agent": GAMARR_USER_AGENT },
          redirect: "manual",
          signal: combined
        });
      } catch (error) {
        if (signal?.aborted || attempt >= this.maxRetries) {
          throw new AppError(
            "UNAVAILABLE",
            502,
            timeoutSignal.aborted
              ? "Internet Archive did not respond in time"
              : "Internet Archive is unreachable",
            { cause: error }
          );
        }
        await this.sleep(this.backoffMs * 2 ** attempt, signal);
        continue;
      }

      if (!isRetryableStatus(response.status) || attempt >= this.maxRetries) {
        if (response.status === 429) {
          await response.body?.cancel().catch(() => undefined);
          throw new AppError(
            "UNAVAILABLE",
            503,
            "Internet Archive is rate limiting requests; try again later"
          );
        }
        return response;
      }

      const retryAfter = parseRetryAfter(
        response.headers.get("retry-after"),
        this.now()
      );
      await response.body?.cancel().catch(() => undefined);
      if (retryAfter !== null && retryAfter > this.maxRetryAfterMs) {
        throw new AppError(
          "UNAVAILABLE",
          503,
          "Internet Archive is rate limiting requests; try again later"
        );
      }
      await this.sleep(retryAfter ?? this.backoffMs * 2 ** attempt, signal);
    }
  }
}

function torrentPath(identifier: string): string {
  const encoded = encodeURIComponent(identifier);
  return `/download/${encoded}/${encodeURIComponent(`${identifier}_archive.torrent`)}`;
}
