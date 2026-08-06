import { desc, eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import {
  downloadAttempts,
  games,
  libraryEntries,
  platforms
} from "@/db/schema";
import type {
  LibraryAttempt,
  LibraryDetail
} from "@/features/library/models";

export interface LibraryRepository {
  list(): LibraryDetail[];
  get(id: string): LibraryDetail | null;
  delete(id: string): void;
  gameIdsOnPlatform(platformId: number): number[];
}

export class SqliteLibraryRepository implements LibraryRepository {
  constructor(private readonly database: Database) {}

  list(): LibraryDetail[] {
    return this.database.select().from(libraryEntries)
      .orderBy(desc(libraryEntries.updatedAt))
      .all()
      .map((entry) => this.hydrate(entry.id))
      .filter((entry): entry is LibraryDetail => entry !== null);
  }

  get(id: string): LibraryDetail | null {
    return this.hydrate(id);
  }

  delete(id: string): void {
    this.database.delete(libraryEntries)
      .where(eq(libraryEntries.id, id))
      .run();
  }

  gameIdsOnPlatform(platformId: number): number[] {
    // Covered by the library_game_platform_unique index on
    // (game_id, platform_id).
    return this.database
      .select({ gameId: libraryEntries.gameId })
      .from(libraryEntries)
      .where(eq(libraryEntries.platformId, platformId))
      .all()
      .map((row) => row.gameId);
  }

  private hydrate(id: string): LibraryDetail | null {
    const entry = this.database.select().from(libraryEntries)
      .where(eq(libraryEntries.id, id))
      .get();
    if (!entry) return null;
    const game = this.database.select().from(games)
      .where(eq(games.id, entry.gameId))
      .get();
    const platform = this.database.select().from(platforms)
      .where(eq(platforms.id, entry.platformId))
      .get();
    if (!game || !platform) return null;
    const attempts: LibraryAttempt[] = this.database
      .select({
        id: downloadAttempts.id,
        status: downloadAttempts.status,
        releaseTitle: downloadAttempts.releaseTitle,
        progress: downloadAttempts.progress,
        createdAt: downloadAttempts.createdAt,
        updatedAt: downloadAttempts.updatedAt,
        completedAt: downloadAttempts.completedAt,
        failureDetail: downloadAttempts.failureDetail
      })
      .from(downloadAttempts)
      .where(eq(downloadAttempts.libraryEntryId, id))
      .orderBy(desc(downloadAttempts.createdAt))
      .all()
      .map((attempt) => ({
        ...attempt,
        status: attempt.status as LibraryAttempt["status"]
      }));
    return {
      id: entry.id,
      gameId: game.id,
      gameTitle: game.title,
      coverUrl: game.coverId,
      platformId: platform.id,
      platformName: platform.name,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      attempts
    };
  }
}
