import type {
  DownloadAttempt,
  SubmissionClaimInput
} from "@/features/downloads/models";
import { and, desc, eq, lt } from "drizzle-orm";

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
  update(id: string, patch: Partial<DownloadAttempt>): DownloadAttempt;
  get(id: string): DownloadAttempt | null;
  list(): DownloadAttempt[];
  recoverStaleSubmitting(before: number, updatedAt: number): void;
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
    releaseTitle: row.releaseTitle,
    indexerId: row.indexerId,
    indexerNameSnapshot: row.indexerNameSnapshot,
    indexerUrlSnapshot: row.indexerUrlSnapshot,
    newznabGuid: row.newznabGuid,
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

  update(id: string, patch: Partial<DownloadAttempt>): DownloadAttempt {
    this.database.update(downloadAttempts)
      .set(patch)
      .where(eq(downloadAttempts.id, id))
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
}
