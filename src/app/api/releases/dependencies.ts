import "server-only";

import { getDatabase } from "@/db/client";
import { SqliteCatalogRepository } from "@/features/catalog/repository";
import { SqliteCandidateRepository } from "@/features/release-search/repository";
import { ReleaseSearchService } from "@/features/release-search/service";
import { SqliteSettingsRepository } from "@/features/settings/repository";
import { ProwlarrClient } from "@/integrations/prowlarr/client";
import { ProwlarrFetcher } from "@/integrations/prowlarr/fetch";
import { byteLimitFromEnv } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { parseOriginPolicy } from "@/lib/trusted-mutation";

export function releaseSearchDependencies() {
  const database = getDatabase();
  const settings = new SqliteSettingsRepository(database);
  const prowlarr = settings.getProwlarr();
  const prowlarrBaseUrl = process.env.GAMARR_PROWLARR_BASE_URL
    ?? prowlarr?.baseUrl
    ?? "http://prowlarr.invalid";
  const maxTorrentBytes = byteLimitFromEnv(
    process.env.GAMARR_PROWLARR_MAX_TORRENT_BYTES
  ) ?? 8 * 1024 * 1024;
  return {
    // Both release routes go through the service: candidate lookup and file
    // selection are domain policy, so no repository or integration client is
    // handed to a handler directly.
    service: new ReleaseSearchService({
      catalog: new SqliteCatalogRepository(database),
      candidates: new SqliteCandidateRepository(database),
      prowlarr: prowlarr === null ? null : new ProwlarrClient({
        baseUrl: prowlarrBaseUrl,
        apiKey: prowlarr.apiKey,
        timeoutMs: Math.min(prowlarr.timeoutMs, 10_000)
      }),
      prowlarrBaseUrl,
      prowlarrConfigRevision: prowlarr?.configRevision ?? 0,
      fetcher: prowlarr === null
        ? {
            fetch: async () => {
              throw new AppError(
                "UNAVAILABLE",
                503,
                "Prowlarr is not configured"
              );
            }
          }
        : new ProwlarrFetcher({
            baseUrl: prowlarrBaseUrl,
            apiKey: prowlarr.apiKey,
            timeoutMs: prowlarr.timeoutMs
          }),
      maxTorrentBytes,
      usenetClientConfigured: () => Boolean(settings.getSabnzbd()?.apiKey),
      torrentClientConfigured: () => Boolean(settings.getQbittorrent()?.password)
    }),
    policy: parseOriginPolicy(process.env.GAMARR_ALLOWED_ORIGINS ?? "", {
      trustedProxy: process.env.GAMARR_TRUST_PROXY === "true",
      automationToken: process.env.GAMARR_API_TOKEN
    })
  };
}
