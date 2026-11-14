import { asc, eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import {
  downloadAttempts,
  downloadVerifications,
  libraryEntries
} from "@/db/schema";
import { mapAttempt } from "@/features/downloads/repository";
import type {
  DownloadVerification,
  VerificationResult,
  VerificationStatus
} from "@/features/verification/models";
import type {
  VerificationRepository,
  VerificationTarget
} from "@/features/verification/ports";

function mapVerification(
  row: typeof downloadVerifications.$inferSelect
): DownloadVerification {
  return {
    attemptId: row.attemptId,
    status: row.status as VerificationStatus,
    fileName: row.fileName,
    sha1: row.sha1,
    serial: row.serial,
    redumpName: row.redumpName,
    detail: row.detail,
    requestedAt: row.requestedAt,
    checkedAt: row.checkedAt,
    updatedAt: row.updatedAt
  };
}

const cleared = {
  fileName: null,
  sha1: null,
  serial: null,
  redumpName: null,
  detail: null,
  checkedAt: null
};

export class SqliteVerificationRepository implements VerificationRepository {
  constructor(private readonly database: Database) {}

  get(attemptId: string): DownloadVerification | null {
    const row = this.database.select().from(downloadVerifications)
      .where(eq(downloadVerifications.attemptId, attemptId)).get();
    return row ? mapVerification(row) : null;
  }

  list(): DownloadVerification[] {
    return this.database.select().from(downloadVerifications).all()
      .map(mapVerification);
  }

  requestPending(attemptId: string, timestamp: number): DownloadVerification {
    this.database.insert(downloadVerifications)
      .values({
        attemptId,
        status: "Pending",
        ...cleared,
        requestedAt: timestamp,
        updatedAt: timestamp
      })
      .onConflictDoUpdate({
        target: downloadVerifications.attemptId,
        set: {
          status: "Pending",
          ...cleared,
          requestedAt: timestamp,
          updatedAt: timestamp
        }
      })
      .run();
    return this.get(attemptId)!;
  }

  claimNextPending(timestamp: number): DownloadVerification | null {
    return this.database.transaction((transaction) => {
      const next = transaction.select().from(downloadVerifications)
        .where(eq(downloadVerifications.status, "Pending"))
        .orderBy(asc(downloadVerifications.requestedAt))
        .limit(1)
        .get();
      if (!next) return null;
      transaction.update(downloadVerifications)
        .set({ status: "Running", updatedAt: timestamp })
        .where(eq(downloadVerifications.attemptId, next.attemptId))
        .run();
      return mapVerification({ ...next, status: "Running", updatedAt: timestamp });
    });
  }

  complete(
    attemptId: string,
    result: VerificationResult,
    timestamp: number
  ): DownloadVerification {
    this.database.update(downloadVerifications)
      .set({ ...result, checkedAt: timestamp, updatedAt: timestamp })
      .where(eq(downloadVerifications.attemptId, attemptId))
      .run();
    return this.get(attemptId)!;
  }

  resetRunning(timestamp: number): number {
    return this.database.update(downloadVerifications)
      .set({ status: "Pending", updatedAt: timestamp })
      .where(eq(downloadVerifications.status, "Running"))
      .run().changes;
  }

  target(attemptId: string): VerificationTarget | null {
    const row = this.database
      .select({
        attempt: downloadAttempts,
        platformId: libraryEntries.platformId
      })
      .from(downloadAttempts)
      .innerJoin(
        libraryEntries,
        eq(libraryEntries.id, downloadAttempts.libraryEntryId)
      )
      .where(eq(downloadAttempts.id, attemptId))
      .get();
    return row
      ? { attempt: mapAttempt(row.attempt), platformId: row.platformId }
      : null;
  }
}
