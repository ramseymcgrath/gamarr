import { and, eq, gt, lte } from "drizzle-orm";

import type { Database } from "@/db/client";
import { releaseCandidates } from "@/db/schema";
import type {
  CandidateRepository,
  ReleaseCandidateRecord
} from "@/features/release-search/ports";

export class SqliteCandidateRepository implements CandidateRepository {
  constructor(
    private readonly database: Database,
    private readonly now: () => number = Date.now
  ) {}

  /**
   * Collects expired rows alongside the write that causes the growth. The app
   * has no scheduler, and read-time collection would never fire for users who
   * search without downloading. The delete predicate is the exact complement of
   * the one `get` accepts, so a candidate that is still claimable is never
   * removed.
   */
  save(value: ReleaseCandidateRecord): void {
    const timestamp = this.now();
    this.database.transaction((transaction) => {
      transaction
        .insert(releaseCandidates)
        .values(value)
        .onConflictDoUpdate({
          target: releaseCandidates.id,
          set: value
        })
        .run();
      transaction
        .delete(releaseCandidates)
        .where(lte(releaseCandidates.expiresAt, timestamp))
        .run();
    });
  }

  get(id: string): ReleaseCandidateRecord | null {
    const row = this.database
      .select()
      .from(releaseCandidates)
      .where(and(
        eq(releaseCandidates.id, id),
        gt(releaseCandidates.expiresAt, this.now())
      ))
      .get();
    return row
      ? {
          ...row,
          indexerId: row.indexerId as string,
          protocol: row.protocol as ReleaseCandidateRecord["protocol"]
        }
      : null;
  }
}
