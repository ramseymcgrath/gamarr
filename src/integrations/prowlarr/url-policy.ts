import { AppError } from "@/lib/errors";

export interface SafeDownloadTarget {
  origin: string;
  downloadPath: string;
}

export type DownloadUrlRejectionReason =
  | "malformed"
  | "unsupportedProtocol"
  | "credentialsOrFragment"
  | "differentOrigin";

/**
 * A per-release rejection. Typed so callers can skip the offending source
 * without mistaking it for a request-wide failure. The rejected URL is
 * deliberately never stored on the error: it routinely carries the Prowlarr API
 * key, and these errors reach user-facing warnings.
 */
export class DownloadUrlPolicyError extends AppError {
  constructor(
    readonly reason: DownloadUrlRejectionReason,
    message: string
  ) {
    super("VALIDATION", 400, message);
    this.name = "DownloadUrlPolicyError";
  }
}

export function validateDownloadUrl(
  configuredBaseUrl: string,
  releaseUrl: string
): SafeDownloadTarget {
  const base = new URL(configuredBaseUrl);
  let target: URL;
  try {
    target = new URL(releaseUrl, base);
  } catch {
    throw new DownloadUrlPolicyError("malformed", "Download URL is malformed");
  }
  if (!["http:", "https:"].includes(target.protocol)) {
    throw new DownloadUrlPolicyError(
      "unsupportedProtocol",
      "Download URL must use HTTP or HTTPS"
    );
  }
  if (target.username || target.password || target.hash) {
    throw new DownloadUrlPolicyError(
      "credentialsOrFragment",
      "Download URL contains forbidden credentials or fragment"
    );
  }
  if (target.origin !== base.origin) {
    throw new DownloadUrlPolicyError(
      "differentOrigin",
      "Download URL leaves the configured Prowlarr origin"
    );
  }
  target.searchParams.delete("apikey");
  target.searchParams.delete("api_key");
  target.searchParams.delete("key");
  return {
    origin: target.origin,
    downloadPath: `${target.pathname}${target.search}`
  };
}
