import { createWriteStream } from "node:fs";
import { mkdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

import {
  isSafeInternetArchiveFileName,
  isValidInternetArchiveIdentifier
} from "@/integrations/internet-archive/path-policy";
import { AppError, validationError } from "@/lib/errors";

const DEFAULT_BASE_URL = "https://archive.org";

interface InternetArchiveDownloaderOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  headersTimeoutMs?: number;
  idleTimeoutMs?: number;
  maxRedirects?: number;
}

export interface InternetArchiveDownloadInput {
  identifier: string;
  fileName: string;
  destinationDir: string;
  attemptId: string;
  maxBytes: number;
  onProgress?: (received: number, total: number | null) => void;
}

/**
 * Streams one file of an Internet Archive item to
 * `{destinationDir}/{identifier}/{fileName}` via a per-attempt
 * `.gamarr-{attemptId}.part` file — a constant-length sibling in the same
 * directory — that is renamed to the final name only after the body completes
 * within the byte ceiling.
 *
 * Unlike the Newznab fetcher there are no credentials to pin DNS for: the
 * base URL is operator configuration and redirects are confined to the
 * configured origin or `*.archive.org` over HTTPS.
 *
 * Two timeouts guard an attempt: `headersTimeoutMs` covers connection and
 * response headers, and `idleTimeoutMs` bounds the gap between body chunks so
 * a hung node fails instead of streaming nothing forever. Neither caps total
 * download duration.
 */
export class InternetArchiveDownloader {
  private readonly request: typeof fetch;
  private readonly baseUrl: string;
  private readonly headersTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly maxRedirects: number;

  constructor(options: InternetArchiveDownloaderOptions = {}) {
    this.request = options.fetch ?? fetch;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.headersTimeoutMs = options.headersTimeoutMs ?? 30_000;
    // Generous enough for a slow archive node between chunks, short enough
    // that a hung one surfaces instead of stalling the attempt forever.
    this.idleTimeoutMs = options.idleTimeoutMs ?? 60_000;
    this.maxRedirects = options.maxRedirects ?? 3;
  }

  async download(
    input: InternetArchiveDownloadInput
  ): Promise<{ bytes: number; filePath: string }> {
    if (!isValidInternetArchiveIdentifier(input.identifier)) {
      throw validationError("Invalid Internet Archive identifier");
    }
    if (!isSafeInternetArchiveFileName(input.fileName)) {
      throw validationError("Invalid Internet Archive file name");
    }
    const itemDir = path.join(input.destinationDir, input.identifier);
    const filePath = path.join(itemDir, input.fileName);
    if (!path.resolve(filePath).startsWith(path.resolve(itemDir) + path.sep)) {
      throw validationError("Invalid Internet Archive file name");
    }
    // The temp component is derived from the attempt id alone, never from the
    // file name: a name may legally reach the 255-byte component limit, and
    // appending a 36-character attempt id to it would overflow that limit on
    // ext4 and APFS alike. It stays inside itemDir so the rename below is a
    // same-filesystem atomic move — os.tmpdir() would risk EXDEV, and in the
    // container /tmp is a separate tmpfs.
    const partPath = path.join(itemDir, `.gamarr-${input.attemptId}.part`);
    if (!path.resolve(partPath).startsWith(path.resolve(itemDir) + path.sep)) {
      throw validationError("Invalid Internet Archive attempt id");
    }
    try {
      await mkdir(itemDir, { recursive: true, mode: 0o700 });
      const response = await this.requestFile(input);
      const declared = response.headers.get("content-length");
      const parsedTotal = declared === null ? Number.NaN : Number(declared);
      const total = Number.isFinite(parsedTotal) && parsedTotal >= 0
        ? parsedTotal
        : null;
      if (total !== null && total > input.maxBytes) {
        throw this.limitError();
      }
      const source = Readable.fromWeb(
        response.body as unknown as WebReadableStream
      );
      // The headers timeout is already cleared by the time a body starts, so
      // a node that holds the connection open and stops delivering bytes
      // would otherwise stall the attempt forever. This bounds the *gap*
      // between chunks only — total duration stays unbounded, because a large
      // file may legitimately stream for hours.
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const clearIdleTimer = () => {
        if (idleTimer !== undefined) {
          clearTimeout(idleTimer);
          idleTimer = undefined;
        }
      };
      // Deliberately not unref'd: this guard exists precisely for the case
      // where nothing else is driving the attempt, and the finally below
      // clears it on every path, so it never outlives the download.
      const armIdleTimer = () => {
        clearIdleTimer();
        idleTimer = setTimeout(() => {
          source.destroy(this.stalledError());
        }, this.idleTimeoutMs);
      };
      let received = 0;
      const counter = new Transform({
        transform: (
          chunk: Uint8Array,
          _encoding,
          callback
        ) => {
          armIdleTimer();
          received += chunk.byteLength;
          if (received > input.maxBytes) {
            callback(this.limitError());
            return;
          }
          input.onProgress?.(received, total);
          callback(null, chunk);
        }
      });
      armIdleTimer();
      try {
        await pipeline(
          source,
          counter,
          createWriteStream(partPath, { mode: 0o600 })
        );
      } finally {
        clearIdleTimer();
      }
      await rename(partPath, filePath);
      return { bytes: received, filePath };
    } catch (error) {
      await unlink(partPath).catch(() => undefined);
      // The per-item directory is deliberately NOT removed. Two files of the
      // same item can download concurrently — that is the point of the file
      // picker — and rmdir on an "empty" directory would delete it out from
      // under a sibling attempt that has already run mkdir but has not yet
      // opened its temp file, stranding that attempt's rename with ENOENT.
      // An empty item directory is harmless and mkdir recursive reuses it, so
      // leaving it costs nothing; a reference count keyed by itemDir would be
      // more precise but only buys back an empty directory.
      if (error instanceof AppError) throw error;
      throw new AppError(
        "UNAVAILABLE",
        502,
        "Internet Archive download failed",
        { cause: error }
      );
    }
  }

  private async requestFile(
    input: InternetArchiveDownloadInput
  ): Promise<Response> {
    const baseOrigin = new URL(this.baseUrl).origin;
    let target = new URL(
      `/download/${encodeURIComponent(input.identifier)}/`
        + encodeURIComponent(input.fileName),
      `${baseOrigin}/`
    );
    for (let redirects = 0; redirects <= this.maxRedirects; redirects += 1) {
      // The timeout covers connection and response headers only. It is
      // cleared once headers arrive so large bodies can stream for as long
      // as the archive node keeps delivering bytes.
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new Error("Internet Archive response timed out")),
        this.headersTimeoutMs
      );
      let response: Response;
      try {
        response = await this.request(target, {
          headers: { accept: "application/octet-stream" },
          redirect: "manual",
          signal: controller.signal
        });
      } catch (error) {
        throw new AppError(
          "UNAVAILABLE",
          502,
          "Internet Archive file retrieval failed",
          { cause: error }
        );
      } finally {
        clearTimeout(timer);
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        await response.body?.cancel().catch(() => undefined);
        if (!location || redirects === this.maxRedirects) {
          throw new AppError(
            "UNAVAILABLE",
            502,
            "Internet Archive returned an invalid redirect"
          );
        }
        const redirected = new URL(location, target);
        this.assertAllowedTarget(redirected, baseOrigin);
        target = redirected;
        continue;
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => undefined);
        throw new AppError(
          "UNAVAILABLE",
          502,
          "Internet Archive file retrieval failed"
        );
      }
      return response;
    }
    throw new AppError(
      "UNAVAILABLE",
      502,
      "Internet Archive redirect limit exceeded"
    );
  }

  private assertAllowedTarget(target: URL, baseOrigin: string): void {
    const archiveHost = target.hostname === "archive.org" ||
      target.hostname.endsWith(".archive.org");
    const allowed = target.origin === baseOrigin ||
      (target.protocol === "https:" && archiveHost);
    if (!allowed || target.username || target.password || target.hash) {
      throw new AppError(
        "UNAVAILABLE",
        502,
        "Internet Archive returned an unsafe redirect"
      );
    }
  }

  private stalledError(): AppError {
    return new AppError(
      "UNAVAILABLE",
      502,
      "Internet Archive download stalled"
    );
  }

  private limitError(): AppError {
    return new AppError(
      "UNAVAILABLE",
      502,
      "Internet Archive file exceeded the size limit"
    );
  }
}
