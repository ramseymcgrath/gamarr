import { eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import {
  igdbSettings,
  indexers,
  sabnzbdSettings
} from "@/db/schema";
import type {
  IgdbSettingsRecord,
  IndexerRecord,
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

  listIndexers(): IndexerRecord[] {
    return this.database.select().from(indexers).all().map((row) => ({
      id: row.id,
      name: row.name,
      baseUrl: row.baseUrl,
      apiKey: row.apiKey,
      enabled: row.enabled,
      categoryIds: row.categoryIds,
      timeoutMs: row.timeoutMs,
      configRevision: row.configRevision,
      lastTestStatus: row.lastTestStatus,
      lastTestedAt: row.lastTestedAt,
      deletedAt: row.deletedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    }));
  }

  saveIndexer(value: IndexerRecord): void {
    this.database
      .insert(indexers)
      .values(value)
      .onConflictDoUpdate({
        target: indexers.id,
        set: value
      })
      .run();
  }

  deleteIndexer(id: string, deletedAt: number): void {
    const existing = this.database
      .select()
      .from(indexers)
      .where(eq(indexers.id, id))
      .get();
    if (!existing) return;
    this.database
      .update(indexers)
      .set({
        enabled: false,
        deletedAt,
        updatedAt: deletedAt,
        configRevision: existing.configRevision + 1
      })
      .where(eq(indexers.id, id))
      .run();
  }

  recordIndexerTest(id: string, status: string, testedAt: number): void {
    this.database.update(indexers)
      .set({ lastTestStatus: status, lastTestedAt: testedAt })
      .where(eq(indexers.id, id))
      .run();
  }
}
