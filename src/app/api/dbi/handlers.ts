import { errorResponse } from "@/app/api/error-response";
import type { SwitchLibraryEntry } from "@/features/switch-library/models";
import type { FileOpener, OpenedFile } from "@/features/switch-library/ports";
import { parseRangeHeader } from "@/features/switch-library/range";
import type { SwitchLibraryService } from "@/features/switch-library/service";
import { AppError } from "@/lib/errors";

/**
 * A disabled feature answers 404, never 403: a 403 would confirm the endpoint
 * exists. The message is deliberately generic for the same reason.
 */
function notFound(): AppError {
  return new AppError("NOT_FOUND", 404, "Not found");
}

export async function handleDbiIndex(dependencies: {
  service: Pick<SwitchLibraryService, "isEnabled" | "index">;
}): Promise<Response> {
  try {
    if (!dependencies.service.isEnabled()) throw notFound();
    const entries = await dependencies.service.index();
    return new Response(renderIndex(entries), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store"
      }
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleDbiFile(
  name: string,
  request: Request,
  dependencies: {
    service: Pick<SwitchLibraryService, "isEnabled" | "resolve">;
    opener: FileOpener;
  }
): Promise<Response> {
  let opened: OpenedFile | null = null;
  try {
    if (!dependencies.service.isEnabled()) throw notFound();

    // `name` is only ever a lookup key. It is never joined onto a path, so a
    // traversal attempt simply misses the map and 404s.
    const entry = await dependencies.service.resolve(name);
    if (entry === null) throw notFound();

    opened = await dependencies.opener.open(entry.absolutePath);
    if (opened === null) throw notFound();

    const range = parseRangeHeader(request.headers.get("range"), opened.sizeBytes);

    if (range.kind === "unsatisfiable") {
      await opened.close();
      return new Response(null, {
        status: 416,
        headers: {
          "content-range": `bytes */${opened.sizeBytes}`,
          "accept-ranges": "bytes"
        }
      });
    }

    if (opened.sizeBytes === 0) {
      await opened.close();
      return new Response(null, {
        status: 200,
        headers: {
          "content-length": "0",
          "accept-ranges": "bytes",
          "content-type": "application/octet-stream"
        }
      });
    }

    const start = range.kind === "partial" ? range.start : 0;
    const end = range.kind === "partial" ? range.end : opened.sizeBytes - 1;

    const headers: Record<string, string> = {
      "content-type": "application/octet-stream",
      "content-length": String(end - start + 1),
      "accept-ranges": "bytes",
      "cache-control": "no-store"
    };
    if (range.kind === "partial") {
      headers["content-range"] = `bytes ${start}-${end}/${opened.sizeBytes}`;
    }

    // From here the stream owns the handle and closes it on end or destroy,
    // so this path must not call close().
    return new Response(opened.stream(start, end), {
      status: range.kind === "partial" ? 206 : 200,
      headers
    });
  } catch (error) {
    if (opened !== null) {
      await opened.close().catch(() => undefined);
    }
    return errorResponse(error);
  }
}

/**
 * Hrefs are relative, exactly as Apache's autoindex emits them, so DBI can
 * resolve or concatenate them against the configured base URL. This is why the
 * index must be served at `/api/dbi/` with its trailing slash intact — see
 * `skipTrailingSlashRedirect` in `next.config.ts`.
 */
function renderIndex(entries: SwitchLibraryEntry[]): string {
  const rows = entries
    .map(
      (entry) =>
        `<a href="${escapeHtml(encodeURIComponent(entry.name))}">${escapeHtml(entry.name)}</a><br>`
    )
    .join("\n");
  return `<!DOCTYPE html>
<html><head><title>gamarr</title></head><body>
${rows}
</body></html>
`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
