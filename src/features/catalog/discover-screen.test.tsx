/** @vitest-environment jsdom */

import { act, render, screen, waitFor, within } from "@testing-library/react";
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

vi.mock("next/navigation", () => ({ useSearchParams: () => null }));

beforeEach(() => {
  stubFetch();
  window.history.replaceState(null, "", "/discover");
  sessionStorage.clear();
});

/** What the browser's Back button does, as far as the screen can tell. */
async function goBack() {
  await act(async () => {
    window.history.back();
    await new Promise((resolve) => window.addEventListener("popstate", resolve, { once: true }));
  });
}

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

  it("keeps the search in the URL so Back returns to it", async () => {
    const user = userEvent.setup();
    render(<DiscoverScreen platforms={platforms} />);

    await user.click(screen.getByRole("button", { name: /Nintendo Switch/ }));
    await user.type(screen.getByRole("searchbox"), "Metroid");
    await user.click(screen.getByRole("button", { name: "Search games" }));
    expect(await screen.findByRole("link", { name: /Searched Title/ })).toBeVisible();
    expect(new URLSearchParams(location.search).get("q")).toBe("Metroid");
    expect(new URLSearchParams(location.search).get("platformId")).toBe("130");

    // Opening a game is a sheet over the results, not a new page.
    await user.click(screen.getByRole("link", { name: /Searched Title/ }));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).getByRole("heading", { name: "Searched Title" })).toBeVisible();
    expect(new URLSearchParams(location.search).get("game")).toBe("999");

    // Back closes the sheet and leaves the search exactly as it was.
    await goBack();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("searchbox")).toHaveValue("Metroid");
    expect(screen.getByRole("link", { name: /Searched Title/ })).toBeVisible();
  });

  it("restores a search from the URL without re-querying a cached one", async () => {
    sessionStorage.setItem(
      "gamarr:catalog-search:130:metroid",
      JSON.stringify([searchGame])
    );
    window.history.replaceState(null, "", "/discover?platformId=130&q=Metroid");
    render(<DiscoverScreen platforms={platforms} />);

    expect(await screen.findByRole("link", { name: /Searched Title/ })).toBeVisible();
    expect(screen.getByRole("searchbox")).toHaveValue("Metroid");
    expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url))
      .some((url) => url.includes("/api/catalog/search"))).toBe(false);
  });

  it("steps between results inside the sheet", async () => {
    stubFetch((url) => url.includes("/popular")
      ? [popularGame]
      : [searchGame, { ...searchGame, id: 1000, name: "Second Title" }]);
    window.history.replaceState(null, "", "/discover?platformId=130&q=Metroid&game=999");
    const user = userEvent.setup();
    render(<DiscoverScreen platforms={platforms} />);

    const sheet = await screen.findByRole("dialog");
    expect(await within(sheet).findByText("1 of 2")).toBeVisible();
    await user.click(within(sheet).getByRole("button", { name: "Next" }));
    expect(within(sheet).getByRole("heading", { name: "Second Title" })).toBeVisible();
    expect(new URLSearchParams(location.search).get("game")).toBe("1000");

    // Opened from a link, so closing drops the param rather than leaving Gamarr.
    await user.click(within(sheet).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(location.search).toBe("?platformId=130&q=Metroid");
  });
});
