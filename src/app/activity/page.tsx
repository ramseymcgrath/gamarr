import { toPublicAttempt } from "@/app/api/downloads/handlers";
import {
  verificationRepository,
  verificationService
} from "@/app/api/verification/dependencies";
import { getDatabase } from "@/db/client";
import { SqliteDownloadRepository } from "@/features/downloads/repository";
import {
  ActivityScreen,
  type ActivityItem
} from "@/features/library/activity-screen";

export const dynamic = "force-dynamic";

export default function ActivityPage() {
  const service = verificationService();
  const verifications = new Map(
    verificationRepository().list().map((entry) => [entry.attemptId, entry])
  );
  const attempts = new SqliteDownloadRepository(getDatabase())
    .list()
    .map((attempt) => {
      const verification = verifications.get(attempt.id);
      return toPublicAttempt(
        attempt,
        verification,
        verification?.status === "Verified" && service.canExport(attempt.id)
      );
    }) as ActivityItem[];
  return <ActivityScreen initial={attempts} />;
}
