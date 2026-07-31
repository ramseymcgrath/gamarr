import { notFound } from "next/navigation";

import { getDatabase } from "@/db/client";
import { LibraryDetailScreen } from "@/features/library/library-detail";
import { SqliteLibraryRepository } from "@/features/library/repository";

export const dynamic = "force-dynamic";

export default async function LibraryDetailPage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const detail = new SqliteLibraryRepository(getDatabase())
    .get((await params).id);
  if (!detail) notFound();
  return <LibraryDetailScreen detail={detail} />;
}
