/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DownloadDialog } from "@/features/release-search/download-dialog";

const baseProps = {
  open: true,
  onOpenChange: () => undefined,
  gameId: 1,
  platformId: 130,
  candidateId: "candidate-torrent",
  title: "Game Name",
  indexerName: "Torrent Tracker",
  protocol: "torrent" as const,
  clientConfigured: true
};

describe("DownloadDialog", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).startsWith("/api/releases/files")) {
        return Response.json({
          files: [
            { index: 0, name: "Game/Disc 1.iso", size: 1024 },
            { index: 1, name: "Game/Disc 2.iso", size: 2048 }
          ],
          metadataPending: false
        });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    }));
  });

  afterEach(() => vi.unstubAllGlobals());

  it("lists torrent files when metainfo is available", async () => {
    render(<DownloadDialog {...baseProps} />);

    expect(await screen.findByText("Game/Disc 1.iso")).toBeVisible();
    expect(screen.getByText("Game/Disc 2.iso")).toBeVisible();
    expect(screen.getByRole("checkbox", { name: /Game\/Disc 1\.iso/i })).not.toBeChecked();
  });

  it("explains that a magnet has no file list yet", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({
      files: [],
      metadataPending: true
    }));
    render(<DownloadDialog {...baseProps} />);

    expect(await screen.findByText(/file list is not known until metadata arrives/i))
      .toBeVisible();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("disables submission when the matching client is unconfigured", async () => {
    render(<DownloadDialog {...baseProps} clientConfigured={false} />);

    expect(await screen.findByRole("button", { name: /send to qbittorrent/i }))
      .toBeDisabled();
  });

  it("states why submission is disabled", async () => {
    render(<DownloadDialog {...baseProps} clientConfigured={false} />);

    expect(await screen.findByText("qBittorrent is not configured"))
      .toBeVisible();
  });
});
