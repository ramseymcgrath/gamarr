/** @vitest-environment jsdom */

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LibraryDetailScreen } from "@/features/library/library-detail";
import { LibraryScreen } from "@/features/library/library-screen";
import type { LibraryDetail } from "@/features/library/models";

vi.mock("next/navigation", () => ({ useSearchParams: () => null }));

const detail: LibraryDetail = {
  id: "entry-1",
  gameId: 1,
  gameTitle: "Guitar Practice",
  coverUrl: null,
  platformId: 8,
  platformName: "PlayStation 2",
  createdAt: 1,
  updatedAt: 1,
  attempts: []
};

beforeEach(() => {
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LibraryScreen", () => {
  it("opens a record in a sheet and removes it in place", async () => {
    const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "DELETE") return Response.json({});
      if (String(input) === "/api/library/entry-1") return Response.json(detail);
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    vi.stubGlobal("fetch", request);
    const user = userEvent.setup();
    render(<LibraryScreen entries={[{ ...detail, latestAttempt: null }]} />);

    await user.click(screen.getByRole("link", { name: /Guitar Practice/ }));
    const sheet = await screen.findByRole("dialog");
    expect(new URLSearchParams(location.search).get("entry")).toBe("entry-1");
    expect(await within(sheet).findByText("PlayStation 2")).toBeVisible();

    await user.click(within(sheet).getByRole("button", { name: /Remove from library/ }));
    const remove = within(sheet).getByRole("button", { name: "Remove" });
    expect(remove).toBeDisabled();
    await user.type(within(sheet).getByRole("textbox"), "Guitar Practice");
    await user.click(remove);

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByRole("link", { name: /Guitar Practice/ })).toBeNull();
    expect(request).toHaveBeenCalledWith("/api/library/entry-1", expect.objectContaining({
      method: "DELETE",
      body: JSON.stringify({ confirmation: "Guitar Practice" })
    }));
  });
});

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
