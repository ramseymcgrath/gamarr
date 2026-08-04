import { describe, expect, it } from "vitest";

import { selectCandidateFiles } from "@/features/release-search/file-selection";
import type { InternetArchiveFile } from "@/features/release-search/models";

describe("selectCandidateFiles", () => {
  it("lists original uploads largest-first and hides bookkeeping files", () => {
    const selected = selectCandidateFiles([
      { name: "small.zip", size: 10, format: "ZIP", source: "original" },
      { name: "big.zip", size: 20, format: "ZIP", source: "original" },
      { name: "unknown.bin", size: null, format: "Binary", source: "original" },
      { name: "item_files.xml", size: 1, format: "Metadata", source: "metadata" },
      { name: "thumb.jpg", size: 5, format: "JPEG", source: "derivative" }
    ]);

    // An unknown size sorts last, not first.
    expect(selected).toEqual([
      { name: "big.zip", size: 20, format: "ZIP" },
      { name: "small.zip", size: 10, format: "ZIP" },
      { name: "unknown.bin", size: null, format: "Binary" }
    ]);
  });

  it("projects away the upstream source field", () => {
    const selected = selectCandidateFiles([
      { name: "game.zip", size: 10, format: "ZIP", source: "original" }
    ]);

    // `source` is the discriminator this module filters on; it is internal
    // Internet Archive bookkeeping and must not reach the client.
    expect(Object.keys(selected[0]!)).toEqual(["name", "size", "format"]);
  });

  it("falls back to non-metadata files when an item has no originals", () => {
    expect(selectCandidateFiles([
      { name: "only.bin", size: 3, format: "Binary", source: null },
      { name: "item_meta.sqlite", size: 9, format: "Metadata", source: "metadata" }
    ])).toEqual([{ name: "only.bin", size: 3, format: "Binary" }]);
  });

  it("selects nothing from an item that is entirely bookkeeping", () => {
    expect(selectCandidateFiles([
      { name: "item_files.xml", size: 1, format: "Metadata", source: "metadata" },
      { name: "item_meta.sqlite", size: 9, format: "Metadata", source: "metadata" }
    ])).toEqual([]);
  });

  it("drops file names that would be unsafe to write to disk", () => {
    expect(selectCandidateFiles([
      { name: "../evil.zip", size: 1, format: "ZIP", source: "original" },
      { name: "fine.zip", size: 2, format: "ZIP", source: "original" }
    ])).toEqual([{ name: "fine.zip", size: 2, format: "ZIP" }]);
  });

  it("returns names verbatim, including surrounding whitespace", () => {
    // The name is simultaneously a URL path segment and the on-disk name, so
    // " Game.zip" is a different file from "Game.zip". Trimming here would
    // hand the client a name that matches neither.
    expect(selectCandidateFiles([
      { name: " Game.zip", size: 2, format: "ZIP", source: "original" },
      { name: "Game.zip ", size: 1, format: "ZIP", source: "original" }
    ])).toEqual([
      { name: " Game.zip", size: 2, format: "ZIP" },
      { name: "Game.zip ", size: 1, format: "ZIP" }
    ]);
  });

  it("caps the list at 100 files after sorting, not before", () => {
    // Fed smallest-first on purpose: if the cap ran before the sort it would
    // keep the 100 *smallest* files and both assertions below would fail.
    const files: InternetArchiveFile[] = Array.from(
      { length: 150 },
      (_unused, index) => ({
        name: `file-${index}.zip`,
        size: index + 1,
        format: "ZIP",
        source: "original"
      })
    );

    const selected = selectCandidateFiles(files);

    expect(selected).toHaveLength(100);
    expect(selected[0]).toEqual({
      name: "file-149.zip",
      size: 150,
      format: "ZIP"
    });
    expect(selected[99]).toEqual({
      name: "file-50.zip",
      size: 51,
      format: "ZIP"
    });
  });
});
