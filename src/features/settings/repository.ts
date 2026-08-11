import { asc, eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import {
  igdbSettings,
  platformCategories,
  prowlarrSettings,
  qbittorrentSettings,
  sabnzbdSettings
} from "@/db/schema";
import type {
  IgdbSettingsRecord,
  ProwlarrSettingsRecord,
  QbittorrentSettingsRecord,
  SabnzbdSettingsRecord
} from "@/features/settings/models";
import type { SettingsRepository } from "@/features/settings/service";

export class SqliteSettingsRepository implements SettingsRepository {
  constructor(private readonly database: Database) {}

  getIgdb(): IgdbSettingsRecord | null {
    const row = this.database
      .select()
      .from(igdbSettings)
      .where(eq(igdbSettings.id, 1))
      .get();
    if (!row) return null;
    return {
      clientId: row.clientId,
      clientSecret: row.clientSecret,
      lastTestStatus: row.lastTestStatus,
      lastTestedAt: row.lastTestedAt,
      configRevision: row.configRevision,
      updatedAt: row.updatedAt
    };
  }

  saveIgdb(value: IgdbSettingsRecord): void {
    this.database
      .insert(igdbSettings)
      .values({ id: 1, ...value })
      .onConflictDoUpdate({
        target: igdbSettings.id,
        set: value
      })
      .run();
  }

  recordIgdbTest(status: string, testedAt: number): void {
    this.database.update(igdbSettings)
      .set({ lastTestStatus: status, lastTestedAt: testedAt })
      .where(eq(igdbSettings.id, 1))
      .run();
  }

  getSabnzbd(): SabnzbdSettingsRecord | null {
    const row = this.database
      .select()
      .from(sabnzbdSettings)
      .where(eq(sabnzbdSettings.id, 1))
      .get();
    if (!row) return null;
    return {
      baseUrl: row.baseUrl,
      apiKey: row.apiKey,
      defaultCategory: row.defaultCategory,
      maxNzbBytes: row.maxNzbBytes,
      lastTestStatus: row.lastTestStatus,
      lastTestedAt: row.lastTestedAt,
      configRevision: row.configRevision,
      updatedAt: row.updatedAt
    };
  }

  saveSabnzbd(value: SabnzbdSettingsRecord): void {
    this.database
      .insert(sabnzbdSettings)
      .values({ id: 1, ...value })
      .onConflictDoUpdate({
        target: sabnzbdSettings.id,
        set: value
      })
      .run();
  }

  recordSabnzbdTest(status: string, testedAt: number): void {
    this.database.update(sabnzbdSettings)
      .set({ lastTestStatus: status, lastTestedAt: testedAt })
      .where(eq(sabnzbdSettings.id, 1))
      .run();
  }

  getQbittorrent(): QbittorrentSettingsRecord | null {
    const row = this.database
      .select()
      .from(qbittorrentSettings)
      .where(eq(qbittorrentSettings.id, 1))
      .get();
    if (!row) return null;
    return {
      baseUrl: row.baseUrl,
      username: row.username,
      password: row.password,
      defaultCategory: row.defaultCategory,
      lastTestStatus: row.lastTestStatus,
      lastTestedAt: row.lastTestedAt,
      configRevision: row.configRevision,
      updatedAt: row.updatedAt
    };
  }

  saveQbittorrent(value: QbittorrentSettingsRecord): void {
    this.database
      .insert(qbittorrentSettings)
      .values({ id: 1, ...value })
      .onConflictDoUpdate({
        target: qbittorrentSettings.id,
        set: value
      })
      .run();
  }

  recordQbittorrentTest(status: string, testedAt: number): void {
    this.database.update(qbittorrentSettings)
      .set({ lastTestStatus: status, lastTestedAt: testedAt })
      .where(eq(qbittorrentSettings.id, 1))
      .run();
  }

  getProwlarr(): ProwlarrSettingsRecord | null {
    const row = this.database
      .select()
      .from(prowlarrSettings)
      .where(eq(prowlarrSettings.id, 1))
      .get();
    if (!row) return null;
    return {
      baseUrl: row.baseUrl,
      apiKey: row.apiKey,
      timeoutMs: row.timeoutMs,
      lastTestStatus: row.lastTestStatus,
      lastTestedAt: row.lastTestedAt,
      configRevision: row.configRevision,
      updatedAt: row.updatedAt
    };
  }

  saveProwlarr(value: ProwlarrSettingsRecord): void {
    this.database
      .insert(prowlarrSettings)
      .values({ id: 1, ...value })
      .onConflictDoUpdate({
        target: prowlarrSettings.id,
        set: value
      })
      .run();
  }

  recordProwlarrTest(status: string, testedAt: number): void {
    this.database.update(prowlarrSettings)
      .set({ lastTestStatus: status, lastTestedAt: testedAt })
      .where(eq(prowlarrSettings.id, 1))
      .run();
  }

  listPlatformCategories(platformId: number): string[] {
    return this.database
      .select({ categoryId: platformCategories.categoryId })
      .from(platformCategories)
      .where(eq(platformCategories.platformId, platformId))
      .orderBy(asc(platformCategories.categoryId))
      .all()
      .map((row) => row.categoryId);
  }

  savePlatformCategories(platformId: number, categoryIds: string[]): void {
    this.database.transaction((transaction) => {
      transaction
        .delete(platformCategories)
        .where(eq(platformCategories.platformId, platformId))
        .run();
      const uniqueCategoryIds = [...new Set(categoryIds)];
      if (uniqueCategoryIds.length === 0) return;
      transaction
        .insert(platformCategories)
        .values(uniqueCategoryIds.map((categoryId) => ({
          platformId,
          categoryId
        })))
        .run();
    });
  }
}
