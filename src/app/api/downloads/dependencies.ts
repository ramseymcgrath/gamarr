import "server-only";

import { getDatabase } from "@/db/client";
import { SqliteDownloadRepository } from "@/features/downloads/repository";
import { DownloadService } from "@/features/downloads/service";
import { SqliteCandidateRepository } from "@/features/release-search/repository";
import { SqliteSettingsRepository } from "@/features/settings/repository";
import { ProwlarrFetcher } from "@/integrations/prowlarr/fetch";
import { QbittorrentClient } from "@/integrations/qbittorrent/client";
import { SabnzbdClient } from "@/integrations/sabnzbd/client";
import { byteLimitFromEnv } from "@/lib/env";
import { validationError } from "@/lib/errors";
import { parseOriginPolicy } from "@/lib/trusted-mutation";

const DEFAULT_PROWLARR_TORRENT_MAX_BYTES = 8 * 1024 * 1024;

function maxTorrentBytes(): number {
  return byteLimitFromEnv(process.env.GAMARR_PROWLARR_MAX_TORRENT_BYTES)
    ?? DEFAULT_PROWLARR_TORRENT_MAX_BYTES;
}

function buildDownloadService() {
  const database = getDatabase();
  const repository = new SqliteDownloadRepository(database);
  const settings = new SqliteSettingsRepository(database);
  const service = new DownloadService({
    repository,
    candidates: new SqliteCandidateRepository(database),
    settings,
    // Lazy so startup recovery still tolerates a database opened before its
    // migrations have created prowlarr_settings.
    releaseFetcher: {
      fetch: (input) => {
        const prowlarr = settings.getProwlarr();
        if (!prowlarr?.apiKey) {
          throw validationError("Prowlarr is not configured");
        }
        return new ProwlarrFetcher({
          baseUrl: process.env.GAMARR_PROWLARR_BASE_URL ?? prowlarr.baseUrl,
          apiKey: prowlarr.apiKey,
          timeoutMs: prowlarr.timeoutMs
        }).fetch(input);
      }
    },
    sabFactory: (settings) => new SabnzbdClient({
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      maxNzbBytes: settings.maxNzbBytes
    }),
    torrentClient: () => {
      const qbit = settings.getQbittorrent();
      if (!qbit?.password) return null;
      return new QbittorrentClient({
        baseUrl: qbit.baseUrl,
        username: qbit.username,
        password: qbit.password
      });
    },
    maxTorrentBytes: maxTorrentBytes()
  });
  return { service, repository };
}

/**
 * better-sqlite3 raises exactly this when a query names a table the schema
 * does not have. On a database that was opened — and, being absent, created —
 * before migrations ran, that is the expected state, not a fault: a fresh
 * checkout before `pnpm db:migrate`, or the e2e fixture, where Playwright
 * starts `webServer` before `globalSetup` migrates the file. Matched narrowly
 * so a genuine failure is still reported rather than swallowed.
 */
function isSchemaNotReady(error: unknown): boolean {
  return error instanceof Error
    && (error as { code?: unknown }).code === "SQLITE_ERROR"
    && /no such table/i.test(error.message);
}

/**
 * Whether the one-shot stale-download recovery pass has completed.
 *
 * Module-level state means dev HMR may reset it. Recovery remains safe to
 * repeat because the repository selects only stale, non-terminal attempts.
 */
let recovered = false;

/** Guards the request-path log so one persistent fault is reported once. */
let failureReported = false;

/**
 * Runs recovery at most once, and only once the schema can satisfy it. A
 * missing schema defers the pass; every other error propagates.
 */
function recoverOnce(service: DownloadService): boolean {
  if (recovered) return true;
  try {
    service.recoverStaleSubmissions();
    recovered = true;
    return true;
  } catch (error) {
    if (isSchemaNotReady(error)) return false;
    throw error;
  }
}

export function recoverDownloadsAtStartup(): boolean {
  return recoverOnce(buildDownloadService().service);
}

export function downloadDependencies() {
  const { service, repository } = buildDownloadService();
  // Fallback for environments where the schema was not ready at process
  // start. It disarms itself on first success, so this is not per-request work.
  if (!recovered) {
    try {
      recoverOnce(service);
    } catch (error) {
      // A request must not fail because a background repair pass did. Leave
      // recovery armed for a later transient success and report only once.
      if (!failureReported) {
        failureReported = true;
        console.error("Download recovery failed", error);
      }
    }
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
