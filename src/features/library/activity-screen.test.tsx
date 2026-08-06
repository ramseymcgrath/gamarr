/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ActivityScreen } from "@/features/library/activity-screen";

describe("ActivityScreen", () => {
  it("labels Internet Archive torrent attempts explicitly", () => {
    render(<ActivityScreen initial={[{
      id: "attempt-torrent",
      libraryEntryId: "library-1",
      status: "Queued",
      source: "internet-archive-torrent",
      releaseTitle: "Doom II",
      indexerName: "Internet Archive",
      fileName: null,
      size: 1_400_000_000,
      category: null,
      progress: 0,
      failureDetail: null,
      createdAt: 1,
      updatedAt: 1,
      completedAt: null
    }]} />);

    expect(screen.getByText("Internet Archive (torrent)")).toBeInTheDocument();
    expect(screen.queryByText(/Default category/)).not.toBeInTheDocument();
  });
});
