import "server-only";

import { getDatabase } from "@/db/client";
import { SqliteDownloadRepository } from "@/features/downloads/repository";
import { DownloadService } from "@/features/downloads/service";
import { selectItemTorrent } from "@/features/release-search/file-selection";
import { SqliteCandidateRepository } from "@/features/release-search/repository";
import { SqliteSettingsRepository } from "@/features/settings/repository";
import { InternetArchiveClient } from "@/integrations/internet-archive/client";
import { InternetArchiveDownloader } from "@/integrations/internet-archive/downloader";
import { NewznabNzbFetcher } from "@/integrations/newznab/download";
import { QbittorrentClient } from "@/integrations/qbittorrent/client";
import { SabnzbdClient } from "@/integrations/sabnzbd/client";
import { byteLimitFromEnv } from "@/lib/env";
import { parseOriginPolicy } from "@/lib/trusted-mutation";

const DEFAULT_IA_MAX_BYTES = 8 * 1024 * 1024 * 1024;
const DEFAULT_IA_TORRENT_MAX_BYTES = 8 * 1024 * 1024;

function internetArchiveMaxBytes(): number {
  return byteLimitFromEnv(process.env.GAMARR_IA_MAX_BYTES)
    ?? DEFAULT_IA_MAX_BYTES;
}

function internetArchiveTorrentMaxBytes(): number {
  return byteLimitFromEnv(process.env.GAMARR_IA_TORRENT_MAX_BYTES)
    ?? DEFAULT_IA_TORRENT_MAX_BYTES;
}

function buildDownloadService() {
  const database = getDatabase();
  const repository = new SqliteDownloadRepository(database);
  const settings = new SqliteSettingsRepository(database);
  const iaBaseUrl = process.env.GAMARR_IA_BASE_URL;
  // getFileInfo() delegates to listFiles(), so the submit path needs the same
  // metadata ceiling the file picker gets from the releases composition root.
  const iaClient = new InternetArchiveClient({
    baseUrl: iaBaseUrl,
    maxMetadataBytes: byteLimitFromEnv(process.env.GAMARR_IA_METADATA_MAX_BYTES)
  });
  const iaDownloader = new InternetArchiveDownloader({ baseUrl: iaBaseUrl });
  const service = new DownloadService({
    repository,
    candidates: new SqliteCandidateRepository(database),
    settings,
    nzbFetcher: new NewznabNzbFetcher(),
    sabFactory: (settings) => new SabnzbdClient({
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      maxNzbBytes: settings.maxNzbBytes
    }),
    internetArchive: {
      getFileInfo: ({ identifier, fileName }) =>
        iaClient.getFileInfo(identifier, fileName),
      download: (input) => iaDownloader.download(input),
      downloadDir: process.env.GAMARR_DOWNLOAD_DIRECTORY ?? "/config/downloads",
      maxBytes: internetArchiveMaxBytes()
    },
    internetArchiveTorrent: {
      findTorrent: async (identifier) =>
        selectItemTorrent(await iaClient.listFiles(identifier)),
      fetchTorrent: (identifier, fileName) =>
        iaClient.fetchTorrent(
          identifier,
          fileName,
          internetArchiveTorrentMaxBytes()
        ),
      client: () => {
        const qbit = settings.getQbittorrent();
        if (!qbit?.password) return null;
        return new QbittorrentClient({
          baseUrl: qbit.baseUrl,
          username: qbit.username,
          password: qbit.password
        });
      },
      // Lazy, like `client()` above: this function runs during startup
      // recovery, which must tolerate a database whose migrations have not run
      // yet. An eager read here queries `qbittorrent_settings` before it
      // exists and defeats `isSchemaNotReady`.
      defaultCategory: () => settings.getQbittorrent()?.defaultCategory ?? null
    }
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
 * Module-level state, so dev HMR resets it and recovery can run more than once
 * per process. That is safe ONLY because `recoverStaleSubmissions()` filters on
 * an age cutoff: an in-flight download stamps `updatedAt` every 5s against a
 * 60s stale window, so a repeat pass cannot touch a streaming attempt. That
 * predicate is load-bearing for more than the HMR case it was added for —
 * deleting it makes every re-entry here fail live downloads again.
 */
let recovered = false;

/** Guards the request-path log so one persistent fault is reported once. */
let failureReported = false;

/**
 * Runs recovery at most once, and only once the schema can actually satisfy
 * it. Returns true when the pass has completed (now or earlier) and false when
 * the database is not migrated yet and the pass is still owed. Anything that
 * is not a missing-schema condition propagates.
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

/**
 * Startup recovery, called from `src/instrumentation.ts` rather than from a
 * request. It deliberately does not go through `downloadDependencies()`:
 * `parseOriginPolicy` throws when `GAMARR_ALLOWED_ORIGINS` is empty, and that
 * misconfiguration must keep meaning "mutating requests are rejected", not
 * "the server refuses to boot".
 *
 * Process start is the right moment whenever the schema is ready — the
 * container entrypoint runs `migrate.mjs` before `node server.js` — but it is
 * not guaranteed to be, hence the `false` return and the fallback below.
 */
export function recoverDownloadsAtStartup(): boolean {
  return recoverOnce(buildDownloadService().service);
}

export function downloadDependencies() {
  const { service, repository } = buildDownloadService();
  // Fallback for the environments where the schema was not ready at process
  // start. It disarms itself on the first success, so this is a one-shot pass
  // and not per-request work.
  if (!recovered) {
    try {
      recoverOnce(service);
    } catch (error) {
      // A request must not fail because a background repair pass did. The pass
      // stays armed so a transient fault can still clear on a later request,
      // and is reported only once so a persistent one cannot flood the log.
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
