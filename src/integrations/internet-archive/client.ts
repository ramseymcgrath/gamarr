import { z } from "zod";

import type {
  InternetArchiveFile,
  InternetArchiveItem,
  InternetArchiveSearchResult
} from "@/features/release-search/models";
import { isValidInternetArchiveIdentifier } from "@/integrations/internet-archive/path-policy";
import { assertAllowedArchiveTarget } from "@/integrations/internet-archive/redirect-policy";
import {
  readBoundedJson,
  readBoundedResponse
} from "@/integrations/read-bounded-response";
import { AppError, validationError } from "@/lib/errors";

const DEFAULT_BASE_URL = "https://archive.org";

/**
 * `/advancedsearch.php` returns at most `maxItems` documents of six short
 * fields, which measures in kilobytes — 2 MiB is already ~200x the observed
 * payload and is deliberately left alone. The bug this constant was split out
 * of was never that the number was too small, but that `/metadata/` shared it.
 */
const DEFAULT_MAX_SEARCH_BYTES = 2 * 1024 * 1024;

/**
 * `/metadata/{id}` returns an item's entire file manifest. An entry is roughly
 * 300 bytes, so the old shared 2 MiB ceiling broke around 6,800 files: against
 * the `mediatype:software` corpus 157 items were unlistable, and such an item
 * ranks fine in search and then fails only in the file picker.
 *
 * 16 MiB leaves 7 items unreachable; 32 MiB leaves 1. We stop at 16 rather than
 * going higher because the body is decoded to UTF-16, `JSON.parse`d into many
 * small objects, and then zod-parsed — a 16 MiB body already peaks somewhere
 * around 150-200 MiB transient, and 64 MiB risks OOM in the container. The
 * remaining few items are reachable by raising GAMARR_IA_METADATA_MAX_BYTES.
 */
const DEFAULT_MAX_METADATA_BYTES = 16 * 1024 * 1024;
const MAX_TORRENT_REDIRECTS = 3;

type FetchOperation = "search" | "metadata";

interface InternetArchiveClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  maxSearchBytes?: number;
  maxMetadataBytes?: number;
  maxItems?: number;
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

const metadataFileSchema = z.object({
  name: z.string(),
  size: z.string().optional(),
  format: z.string().optional(),
  source: z.string().optional()
});

const metadataResponseSchema = z.object({
  files: z.array(metadataFileSchema).optional()
});

/**
 * Removes anything that could break out of the quoted Lucene phrase or split
 * the term into extra clauses. Kept deliberately close to the release-title
 * normalizer so catalog titles and IA queries line up.
 */
function sanitizeSearchTerm(title: string): string {
  return title
    .replace(/[^\p{L}\p{N} ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * `null`, not 0: Internet Archive software items frequently carry neither a
 * parseable `date` nor a plausible `year`, and a 0 sentinel renders as 1970 in
 * the results list instead of admitting the date is unknown.
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

/** Rendered into a user-facing message, so bytes rather than a rounded 0 MiB. */
function formatByteCeiling(bytes: number): string {
  const mebibytes = bytes / (1024 * 1024);
  return mebibytes >= 1
    ? `${Number(mebibytes.toFixed(1))} MiB`
    : `${bytes} bytes`;
}

/**
 * A metadata overflow is a property of the *item* and the operator can lift it,
 * so it says so and names the knob; a search overflow stays generic because no
 * per-item action helps. Neither message may carry a URL or an API key — these
 * surface verbatim in the file picker and in submit failures.
 */
function responseTooLargeError(
  operation: FetchOperation,
  limitBytes: number
): AppError {
  return new AppError(
    "UNAVAILABLE",
    502,
    operation === "metadata"
      ? "This Internet Archive item has too many files to list (its metadata "
        + `exceeds ${formatByteCeiling(limitBytes)}). Raise `
        + "GAMARR_IA_METADATA_MAX_BYTES to open it."
      : "Internet Archive response is too large"
  );
}

export class InternetArchiveClient {
  private readonly request: typeof fetch;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxSearchBytes: number;
  private readonly maxMetadataBytes: number;
  private readonly maxItems: number;

  constructor(options: InternetArchiveClientOptions = {}) {
    this.request = options.fetch ?? fetch;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxSearchBytes = options.maxSearchBytes ?? DEFAULT_MAX_SEARCH_BYTES;
    this.maxMetadataBytes = options.maxMetadataBytes
      ?? DEFAULT_MAX_METADATA_BYTES;
    this.maxItems = options.maxItems ?? 25;
  }

  async search(
    input: { title: string },
    signal?: AbortSignal
  ): Promise<InternetArchiveSearchResult> {
    const term = sanitizeSearchTerm(input.title);
    if (!term) return { items: [], warnings: [] };
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
    const payload = await this.fetchJson(
      url,
      "search",
      this.maxSearchBytes,
      signal
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
        detailsUrl: new URL(
          `/details/${encodeURIComponent(doc.identifier)}`,
          this.baseUrl
        ).toString(),
        publishedAt: parsePublishedAt(doc.date, doc.year),
        size: doc.item_size ?? null,
        downloads: doc.downloads ?? 0
      });
    }
    return { items, warnings };
  }

  async listFiles(
    identifier: string,
    signal?: AbortSignal
  ): Promise<InternetArchiveFile[]> {
    if (!isValidInternetArchiveIdentifier(identifier)) {
      throw validationError("Invalid Internet Archive identifier");
    }
    const url = new URL(
      `/metadata/${encodeURIComponent(identifier)}`,
      this.baseUrl
    );
    const payload = await this.fetchJson(
      url,
      "metadata",
      this.maxMetadataBytes,
      signal
    );
    const parsed = metadataResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new AppError(
        "UNAVAILABLE",
        502,
        "Internet Archive returned an unexpected metadata response"
      );
    }
    return (parsed.data.files ?? []).map((file) => {
      const size = Number(file.size);
      return {
        name: file.name,
        size: file.size !== undefined && Number.isFinite(size) && size >= 0
          ? size
          : null,
        format: file.format ?? null,
        source: file.source ?? null
      };
    });
  }

  async getFileInfo(
    identifier: string,
    fileName: string,
    signal?: AbortSignal
  ): Promise<InternetArchiveFile | null> {
    const files = await this.listFiles(identifier, signal);
    return files.find((file) => file.name === fileName) ?? null;
  }

  async fetchTorrent(
    identifier: string,
    fileName: string,
    maxBytes: number,
    signal?: AbortSignal
  ): Promise<Uint8Array> {
    if (!isValidInternetArchiveIdentifier(identifier)) {
      throw validationError("Invalid Internet Archive identifier");
    }
    const baseOrigin = new URL(this.baseUrl).origin;
    let target = new URL(
      `/download/${encodeURIComponent(identifier)}/`
        + encodeURIComponent(fileName),
      `${baseOrigin}/`
    );
    for (
      let redirects = 0;
      redirects <= MAX_TORRENT_REDIRECTS;
      redirects += 1
    ) {
      const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
      let response: Response;
      try {
        response = await this.request(target, {
          headers: { accept: "application/octet-stream" },
          redirect: "manual",
          signal: signal
            ? AbortSignal.any([signal, timeoutSignal])
            : timeoutSignal
        });
      } catch (error) {
        throw new AppError(
          "UNAVAILABLE",
          502,
          "Internet Archive torrent retrieval failed",
          { cause: error }
        );
      }
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

  private async fetchJson(
    url: URL,
    operation: FetchOperation,
    maxBytes: number,
    signal?: AbortSignal
  ): Promise<unknown> {
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const response = await this.request(url, {
      headers: { accept: "application/json" },
      redirect: "manual",
      signal: signal
        ? AbortSignal.any([signal, timeoutSignal])
        : timeoutSignal
    });
    if (!response.ok) {
      throw new AppError(
        "UNAVAILABLE",
        502,
        `Internet Archive ${operation} failed`
      );
    }
    return readBoundedJson(
      response,
      maxBytes,
      () => responseTooLargeError(operation, maxBytes)
    );
  }
}
