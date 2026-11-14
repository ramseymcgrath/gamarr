import { toPublicAttempt } from "@/app/api/downloads/handlers";
import { getDatabase } from "@/db/client";
import { SqliteDownloadRepository } from "@/features/downloads/repository";
import { SqliteVerificationRepository } from "@/features/verification/repository";
import {
  ActivityScreen,
  type ActivityItem
} from "@/features/library/activity-screen";

export const dynamic = "force-dynamic";

export default function ActivityPage() {
  const database = getDatabase();
  const verifications = new Map(
    new SqliteVerificationRepository(database).list()
      .map((entry) => [entry.attemptId, entry])
  );
  const attempts = new SqliteDownloadRepository(database)
    .list()
    .map((attempt) => toPublicAttempt(
      attempt,
      verifications.get(attempt.id)
    )) as ActivityItem[];
  return <ActivityScreen initial={attempts} />;
}
