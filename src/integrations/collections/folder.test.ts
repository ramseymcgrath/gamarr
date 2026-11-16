import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FolderCollections } from "@/integrations/collections/folder";
import { collectionIndexerId } from "@/features/release-search/models";
import { torrentInfoHash } from "@/integrations/prowlarr/metainfo";

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function multi(root: string, files: Array<[string, number]>): Uint8Array {
  const entries = files
    .map(([name, size]) => `d6:lengthi${size}e4:pathl${name.length}:${name}ee`)
    .join("");
  return bytes(`d4:infod5:filesl${entries}e4:name${root.length}:${root}ee`);
}

const maxBytes = 1024 * 1024;
let dir: string;

function put(platform: string, file: string, content: Uint8Array): string {
  const folder = path.join(dir, platform);
  fs.mkdirSync(folder, { recursive: true });
  const target = path.join(folder, file);
  fs.writeFileSync(target, content);
  return target;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "collections-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("FolderCollections", () => {
  it("lists collections for the platform folder only", () => {
    put("8", "a.torrent", multi("Root8", [["one.7z", 5]]));
    put("9", "b.torrent", multi("Root9", [["two.7z", 6]]));
    const { collections, warnings } = new FolderCollections({ dir, maxBytes }).list(8);
    expect(warnings).toEqual([]);
    expect(collections).toHaveLength(1);
    expect(collections[0]).toMatchObject({
      platformId: 8,
      name: "Root8",
      torrentFileName: "a.torrent"
    });
  });

  it("file names drop the torrent root", () => {
    const bytesIn = multi("Root", [["007 - Nightfire (USA).7z", 42]]);
    put("8", "a.torrent", bytesIn);
    const { collections } = new FolderCollections({ dir, maxBytes }).list(8);
    expect(collections[0]!.id).toBe(torrentInfoHash(bytesIn).hash);
    expect(collections[0]!.files).toEqual([
      { index: 0, name: "007 - Nightfire (USA).7z", size: 42 }
    ]);
  });

  it("warns and skips unusable entries", () => {
    put("8", "ok.torrent", multi("Ok", [["a", 1]]));
    fs.writeFileSync(path.join(dir, "top.torrent"), multi("Top", [["a", 1]]));
    const real = put("8", "real.torrent", multi("Real", [["b", 2]]));
    fs.symlinkSync(real, path.join(dir, "8", "link.torrent"));
    put("8", "big.torrent", new Uint8Array(maxBytes + 1));
    put("8", "bad.torrent", bytes("not bencode"));
    put("8", "v2.torrent", bytes("d4:infod9:file treede4:name2:v2ee"));
    const { collections, warnings } = new FolderCollections({ dir, maxBytes }).list(8);
    expect(collections.map((c) => c.name).sort()).toEqual(["Ok", "Real"]);
    for (const name of ["top.torrent", "link.torrent", "big.torrent", "bad.torrent", "v2.torrent"]) {
      expect(warnings.filter((w) => w.includes(name))).toHaveLength(1);
    }
    expect(warnings).toHaveLength(5);
  });

  it("dedupes by hash, first name wins", () => {
    const content = multi("Same", [["a", 1]]);
    put("8", "b.torrent", content);
    put("8", "a.torrent", content);
    const { collections } = new FolderCollections({ dir, maxBytes }).list(8);
    expect(collections).toHaveLength(1);
    expect(collections[0]!.torrentFileName).toBe("a.torrent");
  });

  it("caches by mtime and size", () => {
    const target = put("8", "a.torrent", multi("Root", [["a", 1]]));
    const reads = vi.spyOn(fs, "readFileSync");
    const adapter = new FolderCollections({ dir, maxBytes });
    adapter.list(8);
    adapter.list(8);
    expect(reads).toHaveBeenCalledTimes(1);
    fs.writeFileSync(target, multi("Root", [["a", 1]]));
    const later = new Date(Date.now() + 10_000);
    fs.utimesSync(target, later, later);
    adapter.list(8);
    expect(reads).toHaveBeenCalledTimes(2);
  });

  it("read returns bytes by id, null for unknown", () => {
    const content = multi("Root", [["a", 1]]);
    put("8", "a.torrent", content);
    const adapter = new FolderCollections({ dir, maxBytes });
    const [collection] = adapter.list(8).collections;
    const found = adapter.read(collection!.id);
    expect(found?.collection.id).toBe(collection!.id);
    expect(Array.from(found!.bytes)).toEqual(Array.from(content));
    expect(adapter.read("0".repeat(40))).toBeNull();
    expect(collectionIndexerId(collection!.id)).toBe(`collection:${collection!.id}`);
  });
});
