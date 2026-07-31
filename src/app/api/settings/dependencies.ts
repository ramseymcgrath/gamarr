import "server-only";

import { getDatabase } from "@/db/client";
import { SqliteSettingsRepository } from "@/features/settings/repository";
import { SettingsService } from "@/features/settings/service";
import { parseOriginPolicy } from "@/lib/trusted-mutation";

export function settingsDependencies() {
  return {
    service: new SettingsService(new SqliteSettingsRepository(getDatabase())),
    policy: parseOriginPolicy(process.env.GAMARR_ALLOWED_ORIGINS ?? "", {
      trustedProxy: process.env.GAMARR_TRUST_PROXY === "true",
      automationToken: process.env.GAMARR_API_TOKEN
    })
  };
}
