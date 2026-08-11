/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { PublicRelease } from "@/features/release-search/service";
import { ReleaseResults } from "@/features/release-search/release-results";

const release = (protocol: "usenet" | "torrent", seeders: number | null): PublicRelease => ({
  title: "Game Name",
  size: 100,
  category: "Console",
  publishedAt: Date.UTC(2020, 0, 1),
  match: "Possible",
  score: 10,
  supportingReasons: [],
  conflictingReasons: [],
  sources: [{
    candidateId: `${protocol}-candidate`,
    indexerName: `${protocol} indexer`,
    protocol,
    seeders
  }]
});

function renderResults(releases: PublicRelease[]) {
  render(<ReleaseResults
    gameId={1}
    platformId={130}
    releases={releases}
    usenetClientConfigured
    torrentClientConfigured
  />);
}

describe("ReleaseResults", () => {
  it("renders a protocol label as text, not colour alone", () => {
    renderResults([release("torrent", 12)]);

    expect(screen.getByText("Torrent")).toBeVisible();
    expect(screen.getByRole("button", { name: /torrent indexer/i }))
      .toHaveTextContent("Torrent");
  });

  it("shows the seeder count for a torrent source", () => {
    renderResults([release("torrent", 12)]);

    expect(screen.getByText("12 seeders")).toBeVisible();
  });

  it("shows no seeder count for a usenet source", () => {
    renderResults([release("usenet", 12)]);

    expect(screen.getByText("Usenet")).toBeVisible();
    expect(screen.queryByText(/seeders/i)).not.toBeInTheDocument();
  });
});
