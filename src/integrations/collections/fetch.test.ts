import { describe, expect, it, vi } from "vitest";

import type {
  Collection,
  CollectionsPort,
  ReleaseCandidateRecord
} from "@/features/release-search/ports";
import { CollectionTorrentFetcher } from "@/integrations/collections/fetch";

const collection: Collection = {
  id: "abc123",
  platformId: 8,
  name: "Set",
  torrentFileName: "set.torrent",
  files: [
    { index: 0, name: "a.iso", size: 1 },
    { index: 1, name: "b.iso", size: 2 }
  ]
};

function candidate(
  snapshot: Record<string, unknown> = {}
): ReleaseCandidateRecord {
  return {
    id: "c",
    expiresAt: 10,
    protocol: "torrent",
    indexerId: "collection:abc123",
    indexerConfigRevision: 1,
    guid: "collection:abc123:1",
    title: "b.iso",
    size: 2,
    seeders: null,
    downloadPath: "",
    category: null,
    sourceSnapshot: JSON.stringify({
      indexerName: "Collections",
      collectionId: "abc123",
      torrentFileName: "set.torrent",
      fileIndex: 1,
      fileName: "b.iso",
      origin: null,
      magnetUrl: null,
      ...snapshot
    }),
    createdAt: 1
  };
}

function port(
  read: CollectionsPort["read"]
): CollectionsPort {
  return { list: vi.fn(), read } as unknown as CollectionsPort;
}

describe("CollectionTorrentFetcher", () => {
  it("returns the torrent bytes for the snapshot collection", async () => {
    const bytes = new Uint8Array([1, 2]);
    const read = vi.fn(() => ({ collection, bytes }));
    await expect(new CollectionTorrentFetcher(port(read)).fetch({
      candidate: candidate(),
      magnetUrl: null,
      maxBytes: 10
    })).resolves.toEqual({ kind: "torrent", bytes });
    expect(read).toHaveBeenCalledWith("abc123");
  });

  it("fails when the collection is gone", async () => {
    await expect(new CollectionTorrentFetcher(port(() => null)).fetch({
      candidate: candidate(),
      magnetUrl: null,
      maxBytes: 10
    })).rejects.toThrow("Collection torrent changed; search again");
  });

  it("fails when the file at the index changed", async () => {
    const read = () => ({ collection, bytes: new Uint8Array([1]) });
    await expect(new CollectionTorrentFetcher(port(read)).fetch({
      candidate: candidate({ fileName: "other.iso" }),
      magnetUrl: null,
      maxBytes: 10
    })).rejects.toThrow("Collection torrent changed; search again");
    await expect(new CollectionTorrentFetcher(port(read)).fetch({
      candidate: candidate({ fileIndex: 9 }),
      magnetUrl: null,
      maxBytes: 10
    })).rejects.toThrow("Collection torrent changed; search again");
  });

  it("fails when the snapshot has no collection id", async () => {
    await expect(new CollectionTorrentFetcher(port(() => null)).fetch({
      candidate: candidate({ collectionId: undefined }),
      magnetUrl: null,
      maxBytes: 10
    })).rejects.toThrow("Collection torrent changed; search again");
  });
});
