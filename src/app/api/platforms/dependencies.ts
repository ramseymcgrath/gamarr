import "server-only";

import { catalogService } from "@/app/api/catalog/dependencies";
import { getDatabase } from "@/db/client";
import { SqliteSettingsRepository } from "@/features/settings/repository";
import { parseOriginPolicy } from "@/lib/trusted-mutation";

export function platformDependencies() {
  return {
    catalog: catalogService(),
    settings: new SqliteSettingsRepository(getDatabase()),
    policy: parseOriginPolicy(process.env.GAMARR_ALLOWED_ORIGINS ?? "", {
      trustedProxy: process.env.GAMARR_TRUST_PROXY === "true",
      automationToken: process.env.GAMARR_API_TOKEN
    })
  };
}
