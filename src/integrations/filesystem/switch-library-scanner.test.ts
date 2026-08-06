import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { FilesystemSwitchLibraryScanner } from "@/integrations/filesystem/switch-library-scanner";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function root(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "gamarr-switch-"));
  directories.push(directory);
  return directory;
}

function write(base: string, relative: string, contents = "x"): string {
  const full = path.join(base, relative);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, contents);
  return full;
}

describe("FilesystemSwitchLibraryScanner", () => {
  it("finds installable files at depth one and depth two", async () => {
    const base = root();
    write(base, "Top.xci", "aa");
    write(base, "gamarr-abc/Nested.nsp", "bbb");

    const files = await new FilesystemSwitchLibraryScanner().scan([base]);

    expect(files.map((file) => file.fileName).sort()).toEqual(["Nested.nsp", "Top.xci"]);
    const nested = files.find((file) => file.fileName === "Nested.nsp");
    expect(nested?.parentDirName).toBe("gamarr-abc");
    expect(nested?.sizeBytes).toBe(3);
  });

  it("does not descend below depth two", async () => {
    const base = root();
    write(base, "a/b/Deep.xci");

    const files = await new FilesystemSwitchLibraryScanner().scan([base]);

    expect(files).toEqual([]);
  });

  it("skips non-installable extensions, dotfiles, and part files", async () => {
    const base = root();
    write(base, "Game.3ds");
    write(base, "notes.txt");
    write(base, ".hidden.xci");
    write(base, "dir/.gamarr-abc.part");

    const files = await new FilesystemSwitchLibraryScanner().scan([base]);

    expect(files).toEqual([]);
  });

  it("rejects a symlink escaping its root", async () => {
    const outside = root();
    const secret = write(outside, "Secret.xci");
    const base = root();
    symlinkSync(secret, path.join(base, "Link.xci"));

    const files = await new FilesystemSwitchLibraryScanner().scan([base]);

    expect(files).toEqual([]);
  });

  it("reports a symlink and its in-root target only once", async () => {
    // Both resolve to the same realpath. Emitting both would put two rows in
    // the index that name the same bytes, and since display names are keyed by
    // absolute path one would silently overwrite the other.
    const base = root();
    write(base, "real/Game.xci", "abcd");
    symlinkSync(path.join(base, "real/Game.xci"), path.join(base, "Alias.xci"));

    const files = await new FilesystemSwitchLibraryScanner().scan([base]);

    expect(files).toHaveLength(1);
    expect(files[0].absolutePath).toBe(path.join(await realpath(base), "real/Game.xci"));
  });

  it("reports a file reachable from two roots only once", async () => {
    const base = root();
    write(base, "nested/Game.xci");

    const files = await new FilesystemSwitchLibraryScanner()
      .scan([base, path.join(base, "nested")]);

    expect(files).toHaveLength(1);
  });

  it("skips a root that does not exist instead of throwing", async () => {
    const base = root();
    write(base, "Game.xci");

    const files = await new FilesystemSwitchLibraryScanner()
      .scan([path.join(base, "missing"), base]);

    expect(files.map((file) => file.fileName)).toEqual(["Game.xci"]);
  });

  it("returns nothing for an empty root list", async () => {
    expect(await new FilesystemSwitchLibraryScanner().scan([])).toEqual([]);
  });
});
