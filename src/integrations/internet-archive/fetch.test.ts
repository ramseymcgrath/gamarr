import { describe, expect, it, vi } from "vitest";

import type { ReleaseCandidateRecord } from "@/features/release-search/ports";
import type { InternetArchiveClient } from "@/integrations/internet-archive/client";
import {
  InternetArchiveTorrentFetcher,
  routeReleaseFetch,
  type ReleaseFetcher
} from "@/integrations/internet-archive/fetch";

function candidate(
  overrides: Partial<ReleaseCandidateRecord> = {}
): ReleaseCandidateRecord {
  return {
    id: "candidate",
    expiresAt: 10,
    protocol: "torrent",
    indexerId: "internet-archive",
    indexerConfigRevision: 1,
    guid: "https://archive.org/details/game-item",
    title: "Game",
    size: 1,
    seeders: null,
    downloadPath: "/download/game-item/game-item_archive.torrent",
    category: null,
    sourceSnapshot: JSON.stringify({
      indexerName: "Internet Archive",
      origin: "https://archive.org",
      identifier: "game-item",
      magnetUrl: null
    }),
    createdAt: 1,
    ...overrides
  };
}

const torrent = { kind: "torrent" as const, bytes: new Uint8Array([7]) };

describe("routeReleaseFetch", () => {
  it("sends Internet Archive candidates to the archive fetcher", async () => {
    const prowlarr: ReleaseFetcher = { fetch: vi.fn() };
    const internetArchive: ReleaseFetcher = {
      fetch: vi.fn(async () => torrent)
    };
    const router = routeReleaseFetch({ prowlarr, internetArchive });
    await expect(router.fetch({
      candidate: candidate(),
      magnetUrl: null,
      maxBytes: 10
    })).resolves.toBe(torrent);
    expect(prowlarr.fetch).not.toHaveBeenCalled();
  });

  it("sends every other candidate to Prowlarr", async () => {
    const prowlarr: ReleaseFetcher = { fetch: vi.fn(async () => torrent) };
    const internetArchive: ReleaseFetcher = { fetch: vi.fn() };
    await routeReleaseFetch({ prowlarr, internetArchive }).fetch({
      candidate: candidate({ indexerId: "12" }),
      magnetUrl: null,
      maxBytes: 10
    });
    expect(internetArchive.fetch).not.toHaveBeenCalled();
  });

  it("fails an archive candidate cleanly when the source is disabled", async () => {
    const prowlarr: ReleaseFetcher = { fetch: vi.fn() };
    await expect(routeReleaseFetch({ prowlarr, internetArchive: null }).fetch({
      candidate: candidate(),
      magnetUrl: null,
      maxBytes: 10
    })).rejects.toThrow("Internet Archive is disabled");
    expect(prowlarr.fetch).not.toHaveBeenCalled();
  });
});

describe("InternetArchiveTorrentFetcher", () => {
  it("fetches the torrent for the snapshot identifier", async () => {
    const fetchTorrent = vi.fn(async () => new Uint8Array([7]));
    const fetcher = new InternetArchiveTorrentFetcher(
      { fetchTorrent } as unknown as InternetArchiveClient
    );
    await expect(fetcher.fetch({
      candidate: candidate(),
      magnetUrl: null,
      maxBytes: 99
    })).resolves.toEqual(torrent);
    expect(fetchTorrent).toHaveBeenCalledWith("game-item", 99);
  });

  it("refuses a candidate whose snapshot lacks a valid identifier", async () => {
    const fetchTorrent = vi.fn();
    const fetcher = new InternetArchiveTorrentFetcher(
      { fetchTorrent } as unknown as InternetArchiveClient
    );
    await expect(fetcher.fetch({
      candidate: candidate({
        sourceSnapshot: JSON.stringify({ identifier: "../../x" })
      }),
      magnetUrl: null,
      maxBytes: 99
    })).rejects.toThrow("Internet Archive release is missing its item identifier");
    expect(fetchTorrent).not.toHaveBeenCalled();
  });
});
