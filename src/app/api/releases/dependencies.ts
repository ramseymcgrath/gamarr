import "server-only";

import { getDatabase } from "@/db/client";
import { SqliteCatalogRepository } from "@/features/catalog/repository";
import { SqliteCandidateRepository } from "@/features/release-search/repository";
import { ReleaseSearchService } from "@/features/release-search/service";
import { SqliteSettingsRepository } from "@/features/settings/repository";
import { CollectionTorrentFetcher } from "@/integrations/collections/fetch";
import { FolderCollections } from "@/integrations/collections/folder";
import { ProwlarrClient } from "@/integrations/prowlarr/client";
import {
  InternetArchiveTorrentFetcher,
  routeReleaseFetch
} from "@/integrations/internet-archive/fetch";
import { internetArchiveClientFromEnv } from "@/integrations/internet-archive/from-env";
import { ProwlarrFetcher } from "@/integrations/prowlarr/fetch";
import { RedumpSerialCatalog } from "@/integrations/redump/serial-catalog";
import { redumpSource } from "@/app/api/verification/dependencies";
import type { CollectionsPort } from "@/features/release-search/ports";
import { collectionsDir } from "@/lib/collections-dir";
import { byteLimitFromEnv } from "@/lib/env";
import { AppError } from "@/lib/errors";
import { parseOriginPolicy } from "@/lib/trusted-mutation";

const DEFAULT_MAX_TORRENT_BYTES = 8 * 1024 * 1024;

function torrentByteLimit(): number {
  return byteLimitFromEnv(process.env.GAMARR_PROWLARR_MAX_TORRENT_BYTES)
    ?? DEFAULT_MAX_TORRENT_BYTES;
}

let sharedCollections: CollectionsPort | null = null;

/** One folder adapter per process so its parse cache is shared. */
export function collectionsPort(): CollectionsPort {
  sharedCollections ??= new FolderCollections({
    dir: collectionsDir(),
    maxBytes: torrentByteLimit()
  });
  return sharedCollections;
}

export function releaseSearchDependencies() {
  const database = getDatabase();
  const settings = new SqliteSettingsRepository(database);
  const prowlarr = settings.getProwlarr();
  const prowlarrBaseUrl = process.env.GAMARR_PROWLARR_BASE_URL
    ?? prowlarr?.baseUrl
    ?? "http://prowlarr.invalid";
  const maxTorrentBytes = torrentByteLimit();
  const internetArchive = internetArchiveClientFromEnv();
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
      internetArchive,
      serialCatalog: process.env.GAMARR_SERIAL_SEARCH === "false"
        ? null
        : new RedumpSerialCatalog(redumpSource()),
      prowlarrBaseUrl,
      prowlarrConfigRevision: prowlarr?.configRevision ?? 0,
      fetcher: routeReleaseFetch({
        prowlarr: prowlarr === null
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
        internetArchive: internetArchive === null
          ? null
          : new InternetArchiveTorrentFetcher(internetArchive),
        collections: new CollectionTorrentFetcher(collectionsPort())
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
