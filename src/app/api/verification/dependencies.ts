import "server-only";

import path from "node:path";

import { getDatabase } from "@/db/client";
import { SqliteSettingsRepository } from "@/features/settings/repository";
import { parsePathMap } from "@/features/verification/path-map";
import { SqliteVerificationRepository } from "@/features/verification/repository";
import {
  ClientDownloadLocator,
  VerificationService
} from "@/features/verification/service";
import { SevenZipArchives } from "@/integrations/files/archive-files";
import { NodeDiscFiles } from "@/integrations/files/disc-files";
import { NodePs2Library } from "@/integrations/files/ps2-library";
import { QbittorrentClient } from "@/integrations/qbittorrent/client";
import { RedumpDatSource } from "@/integrations/redump/source";
import { SabnzbdClient } from "@/integrations/sabnzbd/client";

/**
 * One service per process: the drain loop's single-flight guard and the
 * parsed Redump lists live on this instance, so every request must share it.
 */
let instance: VerificationService | null = null;

function build(): VerificationService {
  const database = getDatabase();
  const settings = new SqliteSettingsRepository(database);
  const databasePath = process.env.GAMARR_DATABASE_PATH ?? "/config/gamarr.db";
  return new VerificationService({
    repository: new SqliteVerificationRepository(database),
    locator: new ClientDownloadLocator({
      torrent: () => {
        const qbit = settings.getQbittorrent();
        if (!qbit?.password) return null;
        return new QbittorrentClient({
          baseUrl: qbit.baseUrl,
          username: qbit.username,
          password: qbit.password
        });
      },
      sabnzbd: () => {
        const sab = settings.getSabnzbd();
        if (!sab?.apiKey) return null;
        return new SabnzbdClient({
          baseUrl: sab.baseUrl,
          apiKey: sab.apiKey,
          maxNzbBytes: sab.maxNzbBytes
        });
      }
    }),
    files: new NodeDiscFiles(),
    redump: new RedumpDatSource({
      cacheDir: path.join(path.dirname(databasePath), "redump"),
      baseUrl: process.env.GAMARR_REDUMP_BASE_URL || undefined
    }),
    pathMappings: parsePathMap(process.env.GAMARR_DOWNLOAD_PATH_MAP),
    archives: process.env.GAMARR_ARCHIVES === "false" ? null : new SevenZipArchives(),
    ps2Library: ps2LibraryDir() ? new NodePs2Library(ps2LibraryDir()!) : null,
    // Verified PS2 games go straight to the share unless turned off.
    autoExport: process.env.GAMARR_PS2_AUTO_EXPORT !== "false",
    log: (message, error) => console.error(message, error)
  });
}

/** The Open PS2 Loader share inside the container, e.g. `/ps2`. */
export function ps2LibraryDir(): string | null {
  return process.env.GAMARR_PS2_LIBRARY_DIR?.trim() || null;
}

export function verificationRepository(): SqliteVerificationRepository {
  return new SqliteVerificationRepository(getDatabase());
}

export function verificationService(): VerificationService {
  instance ??= build();
  return instance;
}

/** Startup: requeue checks interrupted by a restart and resume the queue. */
export function resumeVerificationAtStartup(): void {
  verificationService().resume();
}
