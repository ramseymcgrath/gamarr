import { getDatabase } from "@/db/client";
import { SqliteLibraryRepository } from "@/features/library/repository";
import { LibraryService } from "@/features/library/service";
import { LibraryScreen } from "@/features/library/library-screen";

export const dynamic = "force-dynamic";

export default function HomePage() {
  const entries = new LibraryService(
    new SqliteLibraryRepository(getDatabase())
  ).list();
  return <LibraryScreen entries={entries} />;
}
