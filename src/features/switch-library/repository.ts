import { eq, inArray } from "drizzle-orm";

import type { Database } from "@/db/client";
import { downloadAttempts, games, libraryEntries } from "@/db/schema";
import type { SwitchLibraryTitleReader } from "@/features/switch-library/ports";

/**
 * Resolves on-disk directory names to real game titles.
 *
 * `download_attempts.sab_marker` is written as `gamarr-{attemptId}` for every
 * attempt regardless of source and carries a UNIQUE index, so matching a
 * directory name against it is exact rather than heuristic.
 */
export class SqliteSwitchLibraryRepository implements SwitchLibraryTitleReader {
  constructor(private readonly database: Database) {}

  titlesByMarker(markers: string[]): Map<string, string> {
    if (markers.length === 0) return new Map();
    const rows = this.database
      .select({ marker: downloadAttempts.sabMarker, title: games.title })
      .from(downloadAttempts)
      .innerJoin(
        libraryEntries,
        eq(downloadAttempts.libraryEntryId, libraryEntries.id)
      )
      .innerJoin(games, eq(libraryEntries.gameId, games.id))
      .where(inArray(downloadAttempts.sabMarker, markers))
      .all();
    return new Map(rows.map((row) => [row.marker, row.title]));
  }
}
