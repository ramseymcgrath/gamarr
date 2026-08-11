import "server-only";

import { getDatabase } from "@/db/client";
import { SqliteSettingsRepository } from "@/features/settings/repository";
import { SettingsService } from "@/features/settings/service";
import { ProwlarrClient } from "@/integrations/prowlarr/client";
import { QbittorrentClient } from "@/integrations/qbittorrent/client";
import { parseOriginPolicy } from "@/lib/trusted-mutation";

export function settingsDependencies() {
  const repository = new SqliteSettingsRepository(getDatabase());
  return {
    service: new SettingsService(repository),
    repository,
    policy: parseOriginPolicy(process.env.GAMARR_ALLOWED_ORIGINS ?? "", {
      trustedProxy: process.env.GAMARR_TRUST_PROXY === "true",
      automationToken: process.env.GAMARR_API_TOKEN
    })
  };
}

export function prowlarrTestDependencies() {
  const dependencies = settingsDependencies();
  return {
    policy: dependencies.policy,
    getSettings: () => dependencies.repository.getProwlarr(),
    clientFactory: (settings: NonNullable<
      ReturnType<typeof dependencies.repository.getProwlarr>
    >) => new ProwlarrClient({
      baseUrl: process.env.GAMARR_PROWLARR_BASE_URL ?? settings.baseUrl,
      apiKey: settings.apiKey,
      timeoutMs: Math.min(settings.timeoutMs, 10_000)
    }),
    recordResult: (status: string) =>
      dependencies.repository.recordProwlarrTest(status, Date.now())
  };
}

export function qbittorrentTestDependencies() {
  const dependencies = settingsDependencies();
  return {
    policy: dependencies.policy,
    getSettings: () => dependencies.repository.getQbittorrent(),
    clientFactory: (settings: NonNullable<
      ReturnType<typeof dependencies.repository.getQbittorrent>
    >) => new QbittorrentClient({
      baseUrl: settings.baseUrl,
      username: settings.username,
      password: settings.password
    }),
    recordResult: (status: string) =>
      dependencies.repository.recordQbittorrentTest(status, Date.now())
  };
}
