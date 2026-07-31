import type {
  LibraryCard,
  LibraryDetail
} from "@/features/library/models";
import type { LibraryRepository } from "@/features/library/repository";
import { AppError, validationError } from "@/lib/errors";

export class LibraryService {
  constructor(private readonly repository: LibraryRepository) {}

  list(): LibraryCard[] {
    return this.repository.list().map(({ attempts, ...entry }) => ({
      ...entry,
      latestAttempt: attempts[0] ?? null
    }));
  }

  get(id: string): LibraryDetail {
    const entry = this.repository.get(id);
    if (!entry) throw new AppError("NOT_FOUND", 404, "Library entry not found");
    return entry;
  }

  delete(id: string, confirmation: string): void {
    const entry = this.get(id);
    if (confirmation !== entry.gameTitle) {
      throw validationError("Title confirmation does not match");
    }
    this.repository.delete(id);
  }
}
