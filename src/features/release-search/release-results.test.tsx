/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ReleaseResults } from "@/features/release-search/release-results";

describe("ReleaseResults", () => {
  it("keeps conflicting releases visible with their evidence", () => {
    render(<ReleaseResults
      gameId={1}
      platformId={130}
      releases={[{
        title: "Game.Name.PS5-GROUP",
        size: 100,
        category: "Console",
        publishedAt: 1,
        match: "Conflicting",
        score: 10,
        supportingReasons: ["Title matches"],
        conflictingReasons: ["Conflicting platform: ps5"],
        sources: [{ candidateId: "candidate", indexerName: "Indexer" }]
      }]}
    />);

    expect(screen.getByText("Game.Name.PS5-GROUP")).toBeVisible();
    expect(screen.getByText("Conflicting platform: ps5")).toBeVisible();
    expect(screen.getByText("Conflicting")).toBeVisible();
  });
});
