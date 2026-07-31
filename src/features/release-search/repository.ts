import { and, eq, gt } from "drizzle-orm";

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

  save(value: ReleaseCandidateRecord): void {
    this.database
      .insert(releaseCandidates)
      .values(value)
      .onConflictDoUpdate({
        target: releaseCandidates.id,
        set: value
      })
      .run();
  }

  get(id: string): ReleaseCandidateRecord | null {
    return this.database
      .select()
      .from(releaseCandidates)
      .where(and(
        eq(releaseCandidates.id, id),
        gt(releaseCandidates.expiresAt, this.now())
      ))
      .get() ?? null;
  }
}
