import { AppError } from "@/lib/errors";

/**
 * Internet Archive may move a download from its public origin to an HTTPS
 * archive node. Same-origin redirects also remain valid for configured mirror
 * origins, but no redirect may introduce credentials or a fragment.
 */
export function assertAllowedArchiveTarget(
  target: URL,
  baseOrigin: string
): void {
  const archiveHost = target.hostname === "archive.org"
    || target.hostname.endsWith(".archive.org");
  const allowed = target.origin === baseOrigin
    || (target.protocol === "https:" && archiveHost);
  if (!allowed || target.username || target.password || target.hash) {
    throw new AppError(
      "UNAVAILABLE",
      502,
      "Internet Archive returned an unsafe redirect"
    );
  }
}
