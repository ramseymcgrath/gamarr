import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { NodeDiscFiles } from "@/integrations/files/disc-files";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function folder(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "gamarr-disc-"));
  directories.push(directory);
  return directory;
}

describe("NodeDiscFiles", () => {
  it("lists nested files with relative names and sizes", async () => {
    const root = folder();
    mkdirSync(path.join(root, "Disc"));
    writeFileSync(path.join(root, "Disc", "game.iso"), "abcd");
    writeFileSync(path.join(root, "readme.txt"), "x");
    const files = await new NodeDiscFiles().list(root);
    expect(files.map(({ name, size }) => ({ name, size }))).toEqual([
      { name: path.join("Disc", "game.iso"), size: 4 },
      { name: "readme.txt", size: 1 }
    ]);
  });

  it("lists a single-file download", async () => {
    const root = folder();
    const file = path.join(root, "game.iso");
    writeFileSync(file, "abc");
    await expect(new NodeDiscFiles().list(file))
      .resolves.toEqual([{ path: file, name: "game.iso", size: 3 }]);
  });

  it("does not follow symlinks out of the download", async () => {
    const root = folder();
    const outside = folder();
    writeFileSync(path.join(outside, "secret.iso"), "secret");
    symlinkSync(path.join(outside, "secret.iso"), path.join(root, "link.iso"));
    symlinkSync(outside, path.join(root, "linked-dir"));
    await expect(new NodeDiscFiles().list(root)).resolves.toEqual([]);
  });

  it("reports a missing download plainly", async () => {
    await expect(new NodeDiscFiles().list(path.join(folder(), "gone")))
      .rejects.toThrow("The downloaded files are no longer there");
  });

  it("hashes with SHA-1 and reads byte ranges", async () => {
    const root = folder();
    const file = path.join(root, "game.iso");
    writeFileSync(file, "hello world");
    const files = new NodeDiscFiles();
    await expect(files.sha1(file)).resolves.toBe(
      createHash("sha1").update("hello world").digest("hex")
    );
    const read = files.reader(file);
    expect(new TextDecoder().decode(await read(6, 5))).toBe("world");
    expect((await read(100, 5)).length).toBe(0);
  });
});
