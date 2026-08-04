import "server-only";

import { getDatabase } from "@/db/client";
import { SqliteCatalogRepository } from "@/features/catalog/repository";
import { SqliteCandidateRepository } from "@/features/release-search/repository";
import { ReleaseSearchService } from "@/features/release-search/service";
import { SqliteSettingsRepository } from "@/features/settings/repository";
import { InternetArchiveClient } from "@/integrations/internet-archive/client";
import { NewznabClient } from "@/integrations/newznab/client";
import { byteLimitFromEnv } from "@/lib/env";
import { parseOriginPolicy } from "@/lib/trusted-mutation";

export function releaseSearchDependencies() {
  const database = getDatabase();
  return {
    // Both release routes go through the service: candidate lookup and file
    // selection are domain policy, so no repository or integration client is
    // handed to a handler directly.
    service: new ReleaseSearchService({
      catalog: new SqliteCatalogRepository(database),
      settings: new SqliteSettingsRepository(database),
      candidates: new SqliteCandidateRepository(database),
      clientFactory: (indexer) => new NewznabClient({
        id: indexer.id,
        name: indexer.name,
        baseUrl: indexer.baseUrl,
        apiKey: indexer.apiKey,
        timeoutMs: Math.min(indexer.timeoutMs, 10_000)
      }),
      internetArchive: new InternetArchiveClient({
        baseUrl: process.env.GAMARR_IA_BASE_URL,
        maxMetadataBytes: byteLimitFromEnv(
          process.env.GAMARR_IA_METADATA_MAX_BYTES
        )
      })
    }),
    policy: parseOriginPolicy(process.env.GAMARR_ALLOWED_ORIGINS ?? "", {
      trustedProxy: process.env.GAMARR_TRUST_PROXY === "true",
      automationToken: process.env.GAMARR_API_TOKEN
    })
  };
}
