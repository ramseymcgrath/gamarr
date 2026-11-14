import { getDatabase } from "@/db/client";
import { SqliteLibraryRepository } from "@/features/library/repository";
import { LibraryService } from "@/features/library/service";
import { LibraryScreen } from "@/features/library/library-screen";

export const dynamic = "force-dynamic";

export default async function HomePage({
  searchParams
}: {
  searchParams: Promise<{ entry?: string }>;
}) {
  const { entry } = await searchParams;
  const repository = new SqliteLibraryRepository(getDatabase());
  const entries = new LibraryService(repository).list();
  // A shared `/?entry=` link renders with its sheet already filled in.
  const initialDetail = entry ? repository.get(entry) : null;
  return <LibraryScreen entries={entries} initialDetail={initialDetail ?? null} />;
}
