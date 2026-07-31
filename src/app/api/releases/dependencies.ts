import "server-only";

import { getDatabase } from "@/db/client";
import { SqliteCatalogRepository } from "@/features/catalog/repository";
import { SqliteCandidateRepository } from "@/features/release-search/repository";
import { ReleaseSearchService } from "@/features/release-search/service";
import { SqliteSettingsRepository } from "@/features/settings/repository";
import { NewznabClient } from "@/integrations/newznab/client";
import { parseOriginPolicy } from "@/lib/trusted-mutation";

export function releaseSearchDependencies() {
  const database = getDatabase();
  return {
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
      })
    }),
    policy: parseOriginPolicy(process.env.GAMARR_ALLOWED_ORIGINS ?? "", {
      trustedProxy: process.env.GAMARR_TRUST_PROXY === "true",
      automationToken: process.env.GAMARR_API_TOKEN
    })
  };
}
