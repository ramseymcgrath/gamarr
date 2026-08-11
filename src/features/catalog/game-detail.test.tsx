/** @vitest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { GameDetail } from "@/features/catalog/game-detail";

describe("GameDetail", () => {
  it("restores platform, query, and return context on direct load", () => {
    render(<GameDetail
      game={{
        id: 1,
        name: "Metroid Prime 4: Beyond",
        slug: "metroid-prime-4",
        summary: "A new mission.",
        coverUrl: null,
        releaseYear: 2026,
        genres: ["Adventure"],
        alternativeNames: [],
        platformIds: [130]
      }}
      platformId={130}
      platformName="Nintendo Switch"
      query="Metroid"
      returnTo="/discover?platformId=130&q=Metroid"
    />);

    expect(screen.getByRole("button", { name: "Search releases" })).toBeEnabled();
    expect(screen.getByRole("link", { name: "Back to results" }))
      .toHaveAttribute("href", "/discover?platformId=130&q=Metroid");
  });

  it("threads client configuration from search results into release actions", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL) => {
        if (String(input) === "/api/releases/search") {
          return Response.json({
            releases: [{
              title: "Metroid Prime 4",
              size: 1,
              category: null,
              publishedAt: null,
              match: "Strong",
              score: 10,
              supportingReasons: [],
              conflictingReasons: [],
              sources: [{
                candidateId: "torrent-candidate",
                indexerName: "Torrent Tracker",
                protocol: "torrent",
                seeders: 4
              }]
            }],
            warnings: [],
            usenetClientConfigured: true,
            torrentClientConfigured: false
          });
        }
        if (String(input).startsWith("/api/releases/files")) {
          return Response.json({ files: [], metadataPending: true });
        }
        throw new Error(`Unexpected request: ${String(input)}`);
      }
    );
    render(<GameDetail
      game={{
        id: 1,
        name: "Metroid Prime 4: Beyond",
        slug: "metroid-prime-4",
        summary: "A new mission.",
        coverUrl: null,
        releaseYear: 2026,
        genres: ["Adventure"],
        alternativeNames: [],
        platformIds: [130]
      }}
      platformId={130}
      platformName="Nintendo Switch"
      query=""
      returnTo="/discover"
    />);

    fireEvent.click(screen.getByRole("button", { name: "Search releases" }));
    fireEvent.click(await screen.findByRole("button", { name: /torrent tracker/i }));

    expect(await screen.findByRole("button", { name: /send to qbittorrent/i }))
      .toBeDisabled();
    expect(fetchMock).toHaveBeenCalledWith("/api/releases/search", expect.anything());
  });
});
