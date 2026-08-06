/** @vitest-environment jsdom */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

interface FilesResponse {
  files: Array<{ name: string; size: number | null; format: string | null }>;
  torrent: { name: string; size: number | null } | null;
  torrentClientConfigured: boolean;
}

const defaultFilesResponse: FilesResponse = {
  files: [
    { name: "doom2.zip", size: 2048, format: "ZIP" },
    { name: "small.zip", size: 512, format: "ZIP" }
  ],
  torrent: null,
  torrentClientConfigured: false
};

let filesResponse = defaultFilesResponse;

const fetchFiles = (body: unknown, ok = true) =>
  Promise.resolve(Response.json(
    ok ? body : { error: { message: "nope" } },
    { status: ok ? 200 : 500 }
  ));

function renderDialog(overrides: Partial<FilesResponse> = {}) {
  filesResponse = { ...defaultFilesResponse, ...overrides };
  render(<DownloadDialog {...baseProps} />);
  return vi.mocked(fetch);
}

describe("DownloadDialog Internet Archive flow", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/releases/files")) {
        return fetchFiles(filesResponse);
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

  it("keeps the largest file selected by default when a torrent is available", async () => {
    renderDialog({
      torrent: { name: "doom2_archive.torrent", size: 1_400_000_000 },
      torrentClientConfigured: true
    });

    const radios = await screen.findAllByRole("radio");
    expect(radios).toHaveLength(3);
    expect(screen.getByLabelText(/doom2\.zip/)).toBeChecked();
    expect(screen.getByRole("radio", { name: /entire item \(torrent\)/i }))
      .not.toBeChecked();
    expect(screen.getByText("ZIP · 2 KB")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText(/small\.zip/));
    fireEvent.click(screen.getByRole("button", { name: /Download file/ }));

    await screen.findByText("Download started");
    const postCall = vi.mocked(fetch).mock.calls
      .find(([url]) => String(url) === "/api/downloads");
    expect(JSON.parse(String(postCall?.[1]?.body))).toMatchObject({
      candidateId: "candidate-ia",
      delivery: "file",
      fileName: "small.zip"
    });
  });

  it("pins the torrent entry above a plain separator and the files", async () => {
    renderDialog({
      torrent: { name: "doom2_archive.torrent", size: 1_400_000_000 },
      torrentClientConfigured: true
    });

    const group = await screen.findByRole("group", {
      name: /select what to download/i
    });
    const options = await screen.findAllByRole("radio");
    const separator = screen.getByRole("separator");

    expect(options[0]).toHaveAccessibleName(/entire item \(torrent\)/i);
    expect(group).toContainElement(separator);
    expect(separator.tagName).toBe("HR");
    expect(options[0]?.compareDocumentPosition(separator))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(separator.compareDocumentPosition(options[1]!))
      .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(screen.getByText("1.3 GB · via qBittorrent")).toBeInTheDocument();
  });

  it("switches the submit label when the torrent is selected", async () => {
    renderDialog({
      torrent: { name: "doom2_archive.torrent", size: 1 },
      torrentClientConfigured: true
    });

    expect(await screen.findByRole("button", { name: /download file/i }))
      .toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", {
      name: /entire item \(torrent\)/i
    }));
    expect(screen.getByRole("button", { name: /send to qbittorrent/i }))
      .toBeInTheDocument();
  });

  it("submits torrent delivery without a file name and shows its result", async () => {
    const fetchMock = renderDialog({
      torrent: { name: "doom2_archive.torrent", size: 1 },
      torrentClientConfigured: true
    });

    await userEvent.click(await screen.findByRole("radio", {
      name: /entire item \(torrent\)/i
    }));
    await userEvent.click(screen.getByRole("button", {
      name: /send to qbittorrent/i
    }));

    const body = JSON.parse(fetchMock.mock.calls.at(-1)![1]!.body as string);
    expect(body).toMatchObject({ delivery: "torrent" });
    expect(body.fileName).toBeUndefined();
    expect(await screen.findByText("Added to qBittorrent")).toBeInTheDocument();
    expect(screen.getByText(/queued in qBittorrent/i)).toBeInTheDocument();
  });

  it("submits file delivery with the selected file name", async () => {
    const fetchMock = renderDialog({
      torrent: null,
      torrentClientConfigured: false
    });

    await userEvent.click(await screen.findByRole("button", {
      name: /download file/i
    }));

    const body = JSON.parse(fetchMock.mock.calls.at(-1)![1]!.body as string);
    expect(body).toMatchObject({
      delivery: "file",
      fileName: "doom2.zip"
    });
  });

  it("disables the torrent entry with a reason when qBittorrent is unconfigured", async () => {
    renderDialog({
      torrent: { name: "doom2_archive.torrent", size: 1 },
      torrentClientConfigured: false
    });

    const option = await screen.findByRole("radio", {
      name: /entire item \(torrent\)/i
    });
    expect(option).toBeDisabled();
    expect(screen.getByText(/qbittorrent is not configured/i))
      .toBeInTheDocument();
  });

  it("omits the torrent entry when the item has none", async () => {
    renderDialog({ torrent: null, torrentClientConfigured: true });

    await screen.findByRole("radio", { name: /doom2\.zip/i });
    expect(screen.queryByRole("radio", { name: /entire item/i }))
      .not.toBeInTheDocument();
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
  });

  it("offers a retry when the file listing fails", async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).startsWith("/api/releases/files")) {
        return fetchFiles({}, false);
      }
      throw new Error("unexpected");
    });
    render(<DownloadDialog {...baseProps} />);

    expect(await screen.findByText("Could not load files")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Download file/ }))
      .not.toBeInTheDocument();

    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).startsWith("/api/releases/files")) {
        return fetchFiles({
          files: [{ name: "game.zip", size: 100, format: "ZIP" }],
          torrent: null,
          torrentClientConfigured: false
        });
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
