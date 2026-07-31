/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LibraryDetailScreen } from "@/features/library/library-detail";

describe("LibraryDetailScreen", () => {
  it("features the latest successful attempt and retains older failures", () => {
    render(<LibraryDetailScreen detail={{
      id: "library",
      gameId: 1,
      gameTitle: "Game",
      coverUrl: null,
      platformId: 130,
      platformName: "Nintendo Switch",
      createdAt: 1,
      updatedAt: 3,
      attempts: [{
        id: "completed",
        status: "Completed",
        releaseTitle: "Game.NSW",
        progress: 100,
        createdAt: 3,
        updatedAt: 3,
        completedAt: 3,
        failureDetail: null
      }, {
        id: "failed",
        status: "Failed",
        releaseTitle: "Bad release",
        progress: 0,
        createdAt: 1,
        updatedAt: 1,
        completedAt: null,
        failureDetail: "incomplete archive"
      }]
    }} />);

    expect(screen.getByText("Completed")).toBeVisible();
    expect(screen.getByText("Previous attempts")).toBeVisible();
    expect(screen.getByText("Failed: incomplete archive")).toBeVisible();
  });
});
