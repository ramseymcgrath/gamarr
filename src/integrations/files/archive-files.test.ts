import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseListing, SevenZipArchives } from "@/integrations/files/archive-files";

/** The archive adapter's integration tests need a real 7-Zip binary. */
const binary = ["7z", "7zz"].find((name) =>
  spawnSync(name, ["i"], { stdio: "ignore" }).status === 0);

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function sha1Of(chunks: AsyncIterable<Uint8Array>): Promise<string> {
  const hash = createHash("sha1");
  for await (const chunk of chunks) hash.update(chunk);
  return hash.digest("hex");
}

describe("parseListing", () => {
  it("reads files and skips folders", () => {
    expect(parseListing([
      "Path = Game",
      "Folder = +",
      "Size = 0",
      "",
      "Path = Game/Game [!] (USA).iso",
      "Folder = -",
      "Size = 3801710592",
      ""
    ].join("\n"))).toEqual([{ path: "Game/Game [!] (USA).iso", size: 3_801_710_592 }]);
  });
});

describe.skipIf(!binary)("SevenZipArchives", () => {
  function archive(): { file: string; image: Buffer } {
    const directory = mkdtempSync(path.join(tmpdir(), "gamarr-7z-"));
    directories.push(directory);
    const image = Buffer.alloc(300_000);
    for (let index = 0; index < image.length; index += 1) image[index] = (index * 31) & 0xff;
    // Brackets and a wildcard-looking `*`-free name: -spd keeps them literal.
    writeFileSync(path.join(directory, "Game [!] (USA).iso"), image);
    const file = path.join(directory, "game.zip");
    execFileSync(binary!, ["a", "-tzip", "-spd", file, path.join(directory, "Game [!] (USA).iso")], {
      stdio: "ignore"
    });
    return { file, image };
  }

  it("lists and streams an entry without extracting it", async () => {
    const { file, image } = archive();
    const archives = new SevenZipArchives(binary);
    await expect(archives.list(file)).resolves.toEqual([
      { path: "Game [!] (USA).iso", size: image.length }
    ]);
    await expect(sha1Of(archives.open(file, "Game [!] (USA).iso")))
      .resolves.toBe(createHash("sha1").update(image).digest("hex"));
  });

  it("fails after the last chunk when the archive is damaged", async () => {
    const { file } = archive();
    const bytes = readFileSync(file);
    bytes[bytes.length / 2] ^= 0xff;
    writeFileSync(file, bytes);
    await expect(sha1Of(new SevenZipArchives(binary).open(file, "Game [!] (USA).iso")))
      .rejects.toThrow("damaged");
  });

  it("stops 7-Zip when the reader stops early", async () => {
    const { file } = archive();
    for await (const chunk of new SevenZipArchives(binary).open(file, "Game [!] (USA).iso")) {
      expect(chunk.length).toBeGreaterThan(0);
      break;
    }
  });

  it("explains a missing 7-Zip binary", async () => {
    await expect(new SevenZipArchives("gamarr-no-such-7z").list("/nope.zip"))
      .rejects.toThrow("7-Zip isn't installed");
  });
});
