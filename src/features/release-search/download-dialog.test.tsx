/** @vitest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DownloadDialog } from "@/features/release-search/download-dialog";

const baseProps = {
  open: true,
  onOpenChange: () => undefined,
  gameId: 1,
  platformId: 130,
  candidateId: "candidate-ia",
  title: "Game Name (USA)",
  indexerName: "Internet Archive",
  source: "internet-archive" as const
};

const fetchFiles = (files: unknown, ok = true) =>
  Promise.resolve(Response.json(ok ? { files } : { error: { message: "nope" } }, { status: ok ? 200 : 500 }));

describe("DownloadDialog Internet Archive flow", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/releases/files")) {
        return fetchFiles([
          { name: "big.zip", size: 2048, format: "ZIP" },
          { name: "small.zip", size: 512, format: "ZIP" }
        ]);
      }
      if (url === "/api/downloads" && init?.method === "POST") {
        return Response.json({ status: "Downloading", failureDetail: null }, { status: 201 });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads item files, preselects the largest, and submits the chosen file", async () => {
    render(<DownloadDialog {...baseProps} />);

    const radios = await screen.findAllByRole("radio");
    expect(radios).toHaveLength(2);
    expect(screen.getByLabelText(/big\.zip/)).toBeChecked();
    expect(screen.getByText("ZIP · 2 KB")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText(/small\.zip/));
    fireEvent.click(screen.getByRole("button", { name: /Download file/ }));

    await screen.findByText("Download started");
    const postCall = vi.mocked(fetch).mock.calls
      .find(([url]) => String(url) === "/api/downloads");
    expect(JSON.parse(String(postCall?.[1]?.body))).toMatchObject({
      candidateId: "candidate-ia",
      fileName: "small.zip"
    });
  });

  it("offers a retry when the file listing fails", async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).startsWith("/api/releases/files")) {
        return fetchFiles([], false);
      }
      throw new Error("unexpected");
    });
    render(<DownloadDialog {...baseProps} />);

    expect(await screen.findByText("Could not load files")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Download file/ }))
      .not.toBeInTheDocument();

    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).startsWith("/api/releases/files")) {
        return fetchFiles([{ name: "game.zip", size: 100, format: "ZIP" }]);
      }
      throw new Error("unexpected");
    });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => {
      expect(screen.getByLabelText(/game\.zip/)).toBeChecked();
    });
  });
});

describe("DownloadDialog Newznab flow", () => {
  it("keeps the SABnzbd confirmation without loading files", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("no requests expected");
    }));
    render(<DownloadDialog
      {...baseProps}
      source="newznab"
      indexerName="Indexer"
    />);

    expect(await screen.findByText("Send to SABnzbd?")).toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });
});
