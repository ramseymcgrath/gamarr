import { asc, eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import {
  games,
  platformSettings,
  platforms
} from "@/db/schema";
import type {
  GameSearchResult,
  Platform,
  PlatformView
} from "@/features/catalog/models";
import type { CatalogRepository } from "@/features/catalog/ports";

export class SqliteCatalogRepository implements CatalogRepository {
  constructor(private readonly database: Database) {}

  listPlatforms(): PlatformView[] {
    return this.database
      .select({
        platform: platforms,
        settings: platformSettings
      })
      .from(platforms)
      .leftJoin(
        platformSettings,
        eq(platformSettings.platformId, platforms.id)
      )
      .orderBy(asc(platforms.name))
      .all()
      .map(({ platform, settings }) => ({
        id: platform.id,
        name: platform.name,
        abbreviation: platform.abbreviation ?? undefined,
        generation: platform.generation ?? undefined,
        checksum: platform.providerChecksum ?? undefined,
        visible: settings?.visible ?? false,
        aliases: settings?.aliases ?? [],
        categoryIds: settings?.categoryIds ?? [],
        lastSyncedAt: platform.lastSyncedAt
      }));
  }

  getPlatform(id: number): PlatformView | null {
    return this.listPlatforms().find((platform) => platform.id === id) ?? null;
  }

  upsertPlatforms(values: Platform[], now: number): void {
    this.database.transaction((transaction) => {
      for (const value of values) {
        transaction
          .insert(platforms)
          .values({
            id: value.id,
            name: value.name,
            abbreviation: value.abbreviation,
            generation: value.generation,
            providerChecksum: value.checksum,
            lastSyncedAt: now
          })
          .onConflictDoUpdate({
            target: platforms.id,
            set: {
              name: value.name,
              abbreviation: value.abbreviation,
              generation: value.generation,
              providerChecksum: value.checksum,
              lastSyncedAt: now
            }
          })
          .run();
        transaction
          .insert(platformSettings)
          .values({ platformId: value.id })
          .onConflictDoNothing()
          .run();
      }
    });
  }

  setPlatformVisibility(
    id: number,
    visible: boolean,
    aliases: string[]
  ): void {
    this.database
      .insert(platformSettings)
      .values({ platformId: id, visible, aliases })
      .onConflictDoUpdate({
        target: platformSettings.platformId,
        set: { visible, aliases }
      })
      .run();
  }

  upsertGames(values: GameSearchResult[], now: number): void {
    this.database.transaction((transaction) => {
      for (const value of values) {
        const row = {
          id: value.id,
          title: value.name,
          slug: value.slug,
          summary: value.summary,
          coverId: value.coverUrl,
          releaseYear: value.releaseYear,
          genres: value.genres,
          alternateTitles: value.alternativeNames,
          platformIds: value.platformIds,
          cachedAt: now
        };
        transaction
          .insert(games)
          .values(row)
          .onConflictDoUpdate({ target: games.id, set: row })
          .run();
      }
    });
  }

  getGame(id: number): GameSearchResult | null {
    const row = this.database
      .select()
      .from(games)
      .where(eq(games.id, id))
      .get();
    if (!row) return null;
    return {
      id: row.id,
      name: row.title,
      slug: row.slug,
      summary: row.summary,
      coverUrl: row.coverId,
      releaseYear: row.releaseYear,
      genres: row.genres,
      alternativeNames: row.alternateTitles,
      platformIds: row.platformIds
    };
  }
}
