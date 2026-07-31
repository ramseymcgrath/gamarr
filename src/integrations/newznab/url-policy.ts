import { validationError } from "@/lib/errors";

export interface SafeDownloadTarget {
  origin: string;
  downloadPath: string;
}

export function validateDownloadUrl(
  configuredBaseUrl: string,
  releaseUrl: string
): SafeDownloadTarget {
  const base = new URL(configuredBaseUrl);
  const target = new URL(releaseUrl, base);
  if (!["http:", "https:"].includes(target.protocol)) {
    throw validationError("Download URL must use HTTP or HTTPS");
  }
  if (target.username || target.password || target.hash) {
    throw validationError("Download URL contains forbidden credentials or fragment");
  }
  if (target.origin !== base.origin) {
    throw validationError("Download URL leaves the configured indexer origin");
  }
  target.searchParams.delete("apikey");
  target.searchParams.delete("api_key");
  target.searchParams.delete("key");
  return {
    origin: target.origin,
    downloadPath: `${target.pathname}${target.search}`
  };
}
