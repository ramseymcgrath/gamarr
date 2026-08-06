import { describe, expect, it } from "vitest";

import type { LibraryRepository } from "@/features/library/repository";
import { LibraryService } from "@/features/library/service";

const detail = {
  id: "library-1-130",
  gameId: 1,
  gameTitle: "Game Name",
  coverUrl: null,
  platformId: 130,
  platformName: "Nintendo Switch",
  createdAt: 1,
  updatedAt: 2,
  attempts: [{
    id: "newer-failure",
    status: "Failed" as const,
    releaseTitle: "Bad Release",
    progress: 0,
    createdAt: 4,
    updatedAt: 4,
    completedAt: null,
    failureDetail: "Failed"
  }, {
    id: "completed",
    status: "Completed" as const,
    releaseTitle: "Game.Name.NSW",
    progress: 100,
    createdAt: 2,
    updatedAt: 3,
    completedAt: 3,
    failureDetail: null
  }]
};

class MemoryLibrary implements LibraryRepository {
  entries = [detail];
  list = () => this.entries;
  get = (id: string) => this.entries.find((entry) => entry.id === id) ?? null;
  delete = (id: string) => {
    this.entries = this.entries.filter((entry) => entry.id !== id);
  };
  gameIdsOnPlatform = (platformId: number) => this.entries
    .filter((entry) => entry.platformId === platformId)
    .map((entry) => entry.gameId);
}

describe("LibraryService", () => {
  it("derives the latest attempt for each saved game", () => {
    const service = new LibraryService(new MemoryLibrary());

    expect(service.list()).toEqual([expect.objectContaining({
      id: "library-1-130",
      gameTitle: "Game Name",
      latestAttempt: expect.objectContaining({ id: "completed" })
    })]);
    expect(service.get("library-1-130").attempts).toHaveLength(2);
  });

  it("requires an exact title confirmation before removing Gamarr records", () => {
    const repository = new MemoryLibrary();
    const service = new LibraryService(repository);

    expect(() => service.delete("library-1-130", "wrong"))
      .toThrowError(/confirmation/i);
    service.delete("library-1-130", "Game Name");

    expect(repository.entries).toEqual([]);
  });
});
