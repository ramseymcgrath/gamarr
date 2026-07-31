import "server-only";

import { getDatabase } from "@/db/client";
import { SqliteDownloadRepository } from "@/features/downloads/repository";
import { DownloadService } from "@/features/downloads/service";
import { SqliteCandidateRepository } from "@/features/release-search/repository";
import { SqliteSettingsRepository } from "@/features/settings/repository";
import { NewznabNzbFetcher } from "@/integrations/newznab/download";
import { SabnzbdClient } from "@/integrations/sabnzbd/client";
import { parseOriginPolicy } from "@/lib/trusted-mutation";

let recovered = false;

export function downloadDependencies() {
  const database = getDatabase();
  const repository = new SqliteDownloadRepository(database);
  const service = new DownloadService({
    repository,
    candidates: new SqliteCandidateRepository(database),
    settings: new SqliteSettingsRepository(database),
    nzbFetcher: new NewznabNzbFetcher(),
    sabFactory: (settings) => new SabnzbdClient({
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      maxNzbBytes: settings.maxNzbBytes
    })
  });
  if (!recovered) {
    service.recoverStaleSubmissions();
    recovered = true;
  }
  return {
    service,
    repository,
    policy: parseOriginPolicy(process.env.GAMARR_ALLOWED_ORIGINS ?? "", {
      trustedProxy: process.env.GAMARR_TRUST_PROXY === "true",
      automationToken: process.env.GAMARR_API_TOKEN
    })
  };
}
