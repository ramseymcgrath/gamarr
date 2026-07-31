/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

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
});
