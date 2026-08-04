import {
  TERMINAL_DOWNLOAD_STATUSES,
  type DownloadAttempt,
  type SubmissionClaimInput
} from "@/features/downloads/models";
import { and, desc, eq, inArray, lt, notInArray } from "drizzle-orm";

import type { Database } from "@/db/client";
import {
  downloadAttempts,
  libraryEntries
} from "@/db/schema";

export interface DownloadRepository {
  findBySubmissionKey(key: string): DownloadAttempt | null;
  claimSubmission(input: SubmissionClaimInput): {
    attempt: DownloadAttempt;
    created: boolean;
  };
  /**
   * Applies `patch` only while the attempt is in a non-terminal status, and
   * returns the resulting row — the unchanged current row when the write was
   * refused. Throws only when the row does not exist.
   */
  update(id: string, patch: Partial<DownloadAttempt>): DownloadAttempt;
  get(id: string): DownloadAttempt | null;
  list(): DownloadAttempt[];
  recoverStaleSubmitting(before: number, updatedAt: number): void;
  recoverStaleInternetArchiveDownloads(before: number, updatedAt: number): void;
}

function mapAttempt(
  row: typeof downloadAttempts.$inferSelect
): DownloadAttempt {
  return {
    id: row.id,
    libraryEntryId: row.libraryEntryId,
    submissionKey: row.submissionKey,
    requestFingerprint: row.requestFingerprint,
    status: row.status as DownloadAttempt["status"],
    source: row.source as DownloadAttempt["source"],
    releaseTitle: row.releaseTitle,
    indexerId: row.indexerId,
    indexerNameSnapshot: row.indexerNameSnapshot,
    indexerUrlSnapshot: row.indexerUrlSnapshot,
    newznabGuid: row.newznabGuid,
    iaFileName: row.iaFileName,
    size: row.size,
    category: row.category,
    sabnzbdConfigRevision: row.sabnzbdConfigRevision,
    sabMarker: row.sabMarker,
    sabJobId: row.sabJobId,
    progress: row.progress,
    failureDetail: row.failureDetail,
    sabRequestStartedAt: row.sabRequestStartedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt
  };
}

export class SqliteDownloadRepository implements DownloadRepository {
  constructor(private readonly database: Database) {}

  findBySubmissionKey(key: string): DownloadAttempt | null {
    const row = this.database.select().from(downloadAttempts)
      .where(eq(downloadAttempts.submissionKey, key)).get();
    return row ? mapAttempt(row) : null;
  }

  claimSubmission(input: SubmissionClaimInput): {
    attempt: DownloadAttempt;
    created: boolean;
  } {
    return this.database.transaction((transaction) => {
      transaction.insert(libraryEntries)
        .values(input.library)
        .onConflictDoNothing()
        .run();
      const library = transaction.select().from(libraryEntries)
        .where(and(
          eq(libraryEntries.gameId, input.library.gameId),
          eq(libraryEntries.platformId, input.library.platformId)
        ))
        .get();
      if (!library) throw new Error("Failed to claim library entry");
      const result = transaction.insert(downloadAttempts)
        .values({ ...input.attempt, libraryEntryId: library.id })
        .onConflictDoNothing({
          target: downloadAttempts.submissionKey
        })
        .run();
      const winner = transaction.select().from(downloadAttempts)
        .where(eq(
          downloadAttempts.submissionKey,
          input.attempt.submissionKey
        ))
        .get();
      if (!winner) throw new Error("Failed to claim download submission");
      return {
        attempt: mapAttempt(winner),
        created: result.changes === 1
      };
    });
  }

  /**
   * Monotonic compare-and-set: the write only lands while the row is still in
   * a non-terminal status, so nothing can move an attempt out of `Completed`
   * or `Failed`. This is one statement rather than a read-then-write
   * transaction because SQLite evaluates the predicate and the write together
   * — a concurrent writer cannot slip a terminal status in between — and
   * because better-sqlite3 is synchronous, so a transaction here would buy
   * nothing but a longer lock.
   *
   * The guard is on the row's current status, not on the patch: a patch that
   * leaves `status` alone (the in-flight heartbeat, a progress tick) still
   * applies to a live row but is refused against a terminal one, so a late
   * callback cannot quietly revive a row recovery already failed.
   *
   * Returns the resulting row — which is the unchanged current row when the
   * write was refused. Callers treat `update` as best-effort (`tryUpdate`) and
   * read the returned attempt rather than assuming their patch applied. Still
   * throws when the row does not exist at all, since that is a lost race with
   * a cascading delete rather than a refused write.
   */
  update(id: string, patch: Partial<DownloadAttempt>): DownloadAttempt {
    this.database.update(downloadAttempts)
      .set(patch)
      .where(and(
        eq(downloadAttempts.id, id),
        notInArray(downloadAttempts.status, [...TERMINAL_DOWNLOAD_STATUSES])
      ))
      .run();
    const updated = this.get(id);
    if (!updated) throw new Error("Download attempt does not exist");
    return updated;
  }

  get(id: string): DownloadAttempt | null {
    const row = this.database.select().from(downloadAttempts)
      .where(eq(downloadAttempts.id, id)).get();
    return row ? mapAttempt(row) : null;
  }

  list(): DownloadAttempt[] {
    return this.database.select().from(downloadAttempts)
      .orderBy(desc(downloadAttempts.createdAt))
      .all()
      .map(mapAttempt);
  }

  recoverStaleSubmitting(before: number, updatedAt: number): void {
    this.database.update(downloadAttempts)
      .set({
        status: "Unknown",
        failureDetail: "Submission state was uncertain after restart",
        updatedAt
      })
      .where(and(
        eq(downloadAttempts.status, "Submitting"),
        lt(downloadAttempts.sabRequestStartedAt, before)
      ))
      .run();
  }

  /**
   * `before` is a cutoff on `updatedAt`, which an in-flight download stamps on
   * a timer: a row quiet for longer than that has no process behind it. Without
   * the cutoff this would fail whatever is streaming right now.
   */
  recoverStaleInternetArchiveDownloads(before: number, updatedAt: number): void {
    this.database.update(downloadAttempts)
      .set({
        status: "Failed",
        failureDetail: "Download was interrupted before completion",
        updatedAt
      })
      .where(and(
        eq(downloadAttempts.source, "internet-archive"),
        inArray(downloadAttempts.status, ["Pending", "Downloading"]),
        lt(downloadAttempts.updatedAt, before)
      ))
      .run();
  }
}
