/** @vitest-environment jsdom */

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ActivityScreen,
  type ActivityItem,
  type ActivityVerification
} from "@/features/library/activity-screen";

vi.mock("next/navigation", () => ({ useSearchParams: () => null }));

afterEach(() => {
  vi.unstubAllGlobals();
});

const verified: ActivityVerification = {
  status: "Verified",
  fileName: "gh2.rar › Guitar Hero II (USA).iso",
  serial: "SLUS-21447",
  redumpName: "Guitar Hero II (USA)",
  sha1: "abc",
  detail: "Matches Redump",
  checkedAt: 2,
  exportable: true,
  exportStatus: null,
  exportPath: null,
  exportDetail: null
};

const completed = (verification: ActivityVerification): ActivityItem => ({
  id: "attempt-1",
  libraryEntryId: "library-1",
  status: "Completed",
  releaseTitle: "Guitar Hero II",
  indexerName: "Indexer",
  size: 1,
  category: "games",
  progress: 100,
  failureDetail: null,
  createdAt: 1,
  updatedAt: 1,
  completedAt: 2,
  verification
});

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

  it("labels a collection attempt with its collection name as plain text", () => {
    render(<ActivityScreen initial={[{
      id: "attempt-collection",
      libraryEntryId: "library-1",
      status: "Queued",
      source: "collection-torrent",
      releaseTitle: "Doom II.zip",
      indexerName: "Redump Pack",
      fileName: null,
      size: 100,
      category: null,
      progress: 0,
      failureDetail: null,
      createdAt: 1,
      updatedAt: 1,
      completedAt: null
    }]} />);

    expect(screen.getByText("Redump Pack (collection)")).toBeInTheDocument();
    expect(screen.queryByText(/Default category/)).not.toBeInTheDocument();
  });

  it("offers a verified PS2 download for the PS2 library and shows where it went", async () => {
    const request = vi.fn(async () => Response.json({ ...verified, exportStatus: "Pending" }));
    vi.stubGlobal("fetch", request);
    const user = userEvent.setup();
    const { rerender } = render(<ActivityScreen initial={[completed(verified)]} />);

    await user.click(screen.getByRole("button", { name: "Add to PS2 library" }));
    expect(request).toHaveBeenCalledWith(
      "/api/downloads/attempt-1/ps2-library",
      expect.objectContaining({ method: "POST" })
    );
    expect(await screen.findByText("Queued to copy")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Add to PS2 library" })).toBeNull();

    rerender(<ActivityScreen key="done" initial={[completed({
      ...verified,
      exportStatus: "Done",
      exportPath: "DVD/Guitar Hero II (USA).iso",
      exportDetail: "Added to the PS2 library"
    })]} />);
    const entry = screen.getByText("In PS2 library").closest(".verification-bar") as HTMLElement;
    expect(within(entry).getByText("DVD/Guitar Hero II (USA).iso")).toBeVisible();
    expect(within(entry).queryByRole("button")).toBeNull();
  });

  it("doesn't offer the PS2 library for other platforms", () => {
    render(<ActivityScreen initial={[completed({ ...verified, exportable: false })]} />);
    expect(screen.queryByRole("button", { name: "Add to PS2 library" })).toBeNull();
  });
});
