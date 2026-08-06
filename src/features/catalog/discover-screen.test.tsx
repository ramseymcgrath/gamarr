/** @vitest-environment jsdom */

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DiscoverScreen } from "@/features/catalog/discover-screen";

const platforms = [{
  id: 130,
  name: "Nintendo Switch",
  abbreviation: "Switch",
  visible: true,
  aliases: ["switch"],
  categoryIds: [],
  lastSyncedAt: 1
}];

const popularGame = {
  id: 7346,
  name: "Metroid Prime 4: Beyond",
  slug: "metroid-prime-4-beyond",
  summary: null,
  coverUrl: null,
  releaseYear: 2025,
  genres: [],
  alternativeNames: [],
  platformIds: [130],
  inLibrary: false
};

const ownedGame = { ...popularGame, id: 555, name: "Owned Title", inLibrary: true };

const searchGame = { ...popularGame, id: 999, name: "Searched Title" };

function stubFetch(
  handler: (url: string) => unknown = (url) =>
    url.includes("/popular") ? [popularGame] : [searchGame]
) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => ({
    ok: true,
    json: async () => handler(String(input))
  })));
}

beforeEach(() => {
  stubFetch();
});

// `restoreMocks` only restores spies. `vitest.config.ts` does not set
// `unstubGlobals`, so without this the fetch stub leaks into every later
// test file in the run.
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DiscoverScreen", () => {
  it("requires a platform before searching the catalog", async () => {
    const user = userEvent.setup();
    render(<DiscoverScreen platforms={platforms} />);

    await user.type(screen.getByRole("searchbox"), "Metroid");

    expect(screen.getByRole("button", { name: "Search games" })).toBeDisabled();
  });

  it("shows popular titles once a platform is chosen", async () => {
    const user = userEvent.setup();
    render(<DiscoverScreen platforms={platforms} />);

    expect(screen.queryByRole("heading", { name: /Popular on/ })).toBeNull();

    await user.click(screen.getByRole("button", { name: /Nintendo Switch/ }));

    expect(await screen.findByRole("heading", {
      name: "Popular on Nintendo Switch"
    })).toBeVisible();
    expect(screen.getByRole("link", { name: /Metroid Prime 4: Beyond/ }))
      .toBeVisible();
  });

  it("keeps the popular shelf out of the results live region", async () => {
    const user = userEvent.setup();
    const { container } = render(<DiscoverScreen platforms={platforms} />);

    await user.click(screen.getByRole("button", { name: /Nintendo Switch/ }));
    await screen.findByRole("heading", { name: "Popular on Nintendo Switch" });

    // 24 cards announced on every platform click would be unusable with a
    // screen reader, so the shelf must sit outside aria-live.
    const live = container.querySelector("[aria-live]");
    expect(live).not.toBeNull();
    expect(live!.textContent).not.toContain("Metroid Prime 4: Beyond");
  });

  it("hides the shelf after a search and restores it when the query clears", async () => {
    const user = userEvent.setup();
    render(<DiscoverScreen platforms={platforms} />);

    await user.click(screen.getByRole("button", { name: /Nintendo Switch/ }));
    await screen.findByRole("heading", { name: "Popular on Nintendo Switch" });

    await user.type(screen.getByRole("searchbox"), "Metroid");
    await user.click(screen.getByRole("button", { name: "Search games" }));

    expect(await screen.findByRole("link", { name: /Searched Title/ }))
      .toBeVisible();
    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: /Popular on/ })).toBeNull();
    });

    await user.clear(screen.getByRole("searchbox"));

    expect(await screen.findByRole("heading", {
      name: "Popular on Nintendo Switch"
    })).toBeVisible();
  });

  it("badges only the shelf games already in the library", async () => {
    stubFetch((url) =>
      url.includes("/popular") ? [popularGame, ownedGame] : []);
    const user = userEvent.setup();
    render(<DiscoverScreen platforms={platforms} />);

    await user.click(screen.getByRole("button", { name: /Nintendo Switch/ }));
    await screen.findByRole("heading", { name: "Popular on Nintendo Switch" });

    // The badge carries text, not just a tick, so it is findable the same way
    // a screen reader would encounter it.
    const badges = await screen.findAllByText("In library");
    expect(badges).toHaveLength(1);
    expect(screen.getByRole("link", { name: /Owned Title/ }))
      .toHaveTextContent("In library");
    expect(screen.getByRole("link", { name: /Metroid Prime 4: Beyond/ }))
      .not.toHaveTextContent("In library");
  });

  it("reports a failed popular fetch without breaking search", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      json: async () => ({})
    })));
    const user = userEvent.setup();
    render(<DiscoverScreen platforms={platforms} />);

    await user.click(screen.getByRole("button", { name: /Nintendo Switch/ }));

    expect(await screen.findByText("Couldn't load popular titles."))
      .toBeVisible();
    await user.type(screen.getByRole("searchbox"), "Metroid");
    expect(screen.getByRole("button", { name: "Search games" }))
      .toBeEnabled();
  });
});
