import { describe, expect, it } from "vitest";

import { decodeTorrentFiles } from "@/integrations/prowlarr/metainfo";

function bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

/**
 * Bencode string lengths are byte counts and must be exact — `a.xci` is 5
 * bytes, so it is `5:a.xci`. A decoder that accepts a wrong count is broken.
 */
const singleFile = bytes("d4:infod6:lengthi1024e4:name8:Game.xciee");

const multiFile = bytes(
  "d4:infod5:filesld6:lengthi10e4:pathl5:a.xciee"
  + "d6:lengthi20e4:pathl3:sub5:b.xcieee"
  + "4:name10:Collectionee"
);

describe("decodeTorrentFiles", () => {
  it("returns one entry for a single-file torrent", () => {
    expect(decodeTorrentFiles(singleFile)).toEqual([
      { index: 0, name: "Game.xci", size: 1024 }
    ]);
  });

  it("returns declaration-ordered entries for a multi-file torrent", () => {
    expect(decodeTorrentFiles(multiFile)).toEqual([
      { index: 0, name: "Collection/a.xci", size: 10 },
      { index: 1, name: "Collection/sub/b.xci", size: 20 }
    ]);
  });

  it("rejects a non-dictionary root", () => {
    expect(() => decodeTorrentFiles(bytes("li1ee")))
      .toThrow(/malformed torrent/i);
  });

  it("rejects trailing garbage after the root dictionary", () => {
    const trailing = new Uint8Array([...singleFile, ...bytes("junk")]);
    expect(() => decodeTorrentFiles(trailing)).toThrow(/malformed torrent/i);
  });

  it("rejects truncated input", () => {
    expect(() => decodeTorrentFiles(singleFile.slice(0, 20)))
      .toThrow(/malformed torrent/i);
  });

  it("rejects a string whose declared length exceeds the buffer", () => {
    expect(() => decodeTorrentFiles(bytes("d4:infod4:name99:xee")))
      .toThrow(/malformed torrent/i);
  });

  it("rejects deeply nested input", () => {
    const depth = 64;
    const bomb = bytes("l".repeat(depth) + "e".repeat(depth));
    expect(() => decodeTorrentFiles(bomb)).toThrow(/malformed torrent/i);
  });

  it("rejects a torrent with no info dictionary", () => {
    expect(() => decodeTorrentFiles(bytes("d8:announce3:abce")))
      .toThrow(/malformed torrent/i);
  });

  it("rejects a negative file length", () => {
    expect(() => decodeTorrentFiles(bytes("d4:infod6:lengthi-1e4:name1:aee")))
      .toThrow(/malformed torrent/i);
  });

  it("rejects a path segment that would escape the torrent root", () => {
    const escaping = bytes(
      "d4:infod5:filesld6:lengthi10e4:pathl2:..5:a.xcieee4:name1:cee"
    );
    expect(() => decodeTorrentFiles(escaping)).toThrow(/malformed torrent/i);
  });

  it("reports a null size when length is absent", () => {
    const noLength = bytes("d4:infod5:filesld4:pathl5:a.xcieee4:name1:cee");
    expect(decodeTorrentFiles(noLength)).toEqual([
      { index: 0, name: "c/a.xci", size: null }
    ]);
  });
});
