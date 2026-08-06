/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { PublicRelease } from "@/features/release-search/service";
import { ReleaseResults } from "@/features/release-search/release-results";

const release = (overrides: Partial<PublicRelease>): PublicRelease => ({
  title: "Game Name",
  size: 100,
  category: "Console",
  publishedAt: Date.UTC(2020, 0, 1),
  match: "Possible",
  score: 10,
  supportingReasons: [],
  conflictingReasons: [],
  sources: [{
    candidateId: "candidate",
    indexerName: "Indexer",
    source: "newznab" as const
  }],
  ...overrides
});

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
        sources: [{ candidateId: "candidate", indexerName: "Indexer", source: "newznab" as const }]
      }]}
    />);

    expect(screen.getByText("Game.Name.PS5-GROUP")).toBeVisible();
    expect(screen.getByText("Conflicting platform: ps5")).toBeVisible();
    expect(screen.getByText("Conflicting")).toBeVisible();
  });

  it("labels an undated release instead of rendering the epoch", () => {
    render(<ReleaseResults
      gameId={1}
      platformId={130}
      releases={[release({ publishedAt: null })]}
    />);

    expect(screen.getByText("DATE UNKNOWN")).toBeVisible();
    expect(screen.queryByText("1/1/1970")).toBeNull();
    expect(screen.queryByText("12/31/1969")).toBeNull();
  });

  it("sorts undated releases below dated ones under Newest", async () => {
    render(<ReleaseResults
      gameId={1}
      platformId={130}
      releases={[
        release({
          title: "Undated Release",
          publishedAt: null,
          size: 100,
          sources: [{
            candidateId: "undated",
            indexerName: "Indexer",
            source: "newznab" as const
          }]
        }),
        release({
          title: "Dated Release",
          publishedAt: Date.UTC(2020, 0, 1),
          size: 200,
          sources: [{
            candidateId: "dated",
            indexerName: "Indexer",
            source: "newznab" as const
          }]
        })
      ]}
    />);

    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Sort releases" }),
      "newest"
    );

    const titles = screen.getAllByRole("heading", { level: 3 })
      .map((heading) => heading.textContent);
    expect(titles).toEqual(["Dated Release", "Undated Release"]);
  });
});
