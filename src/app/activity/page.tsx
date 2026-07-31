import { toPublicAttempt } from "@/app/api/downloads/handlers";
import { getDatabase } from "@/db/client";
import { SqliteDownloadRepository } from "@/features/downloads/repository";
import {
  ActivityScreen,
  type ActivityItem
} from "@/features/library/activity-screen";

export const dynamic = "force-dynamic";

export default function ActivityPage() {
  const attempts = new SqliteDownloadRepository(getDatabase())
    .list()
    .map(toPublicAttempt) as ActivityItem[];
  return <ActivityScreen initial={attempts} />;
}
