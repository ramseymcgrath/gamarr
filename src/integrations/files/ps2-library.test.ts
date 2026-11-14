import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { NodePs2Library, resolveInside } from "@/integrations/files/ps2-library";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function share(): string {
  const root = mkdtempSync(path.join(tmpdir(), "gamarr-ps2-"));
  mkdirSync(path.join(root, "DVD"));
  mkdirSync(path.join(root, "CD"));
  roots.push(root);
  return root;
}

describe("NodePs2Library", () => {
  it("writes to a hidden temp file and moves it into place on commit", async () => {
    const root = share();
    const write = await new NodePs2Library(root).begin();
    await write.write(new TextEncoder().encode("disc "));
    await write.write(new TextEncoder().encode("image"));
    expect(readdirSync(path.join(root, "DVD"))).toEqual([]);
    await expect(write.commit("DVD/Game (USA).iso")).resolves.toBe("created");
    expect(readFileSync(path.join(root, "DVD", "Game (USA).iso"), "utf8")).toBe("disc image");
    expect(readdirSync(root).sort()).toEqual(["CD", "DVD"]);
  });

  it("never replaces an existing file", async () => {
    const root = share();
    writeFileSync(path.join(root, "DVD", "Game (USA).iso"), "original");
    const write = await new NodePs2Library(root).begin();
    await write.write(new TextEncoder().encode("new"));
    await expect(write.commit("DVD/Game (USA).iso")).resolves.toBe("exists");
    expect(readFileSync(path.join(root, "DVD", "Game (USA).iso"), "utf8")).toBe("original");
    expect(readdirSync(root).sort()).toEqual(["CD", "DVD"]);
  });

  it("removes the temp file on discard", async () => {
    const root = share();
    const write = await new NodePs2Library(root).begin();
    await write.write(new Uint8Array(10));
    await write.discard();
    expect(readdirSync(root).sort()).toEqual(["CD", "DVD"]);
  });

  it("reports free space", async () => {
    await expect(new NodePs2Library(share()).freeBytes()).resolves.toBeGreaterThan(0);
  });

  it("refuses paths outside the share", () => {
    expect(() => resolveInside("/ps2", "../etc/passwd")).toThrow("outside the PS2 library");
    expect(resolveInside("/ps2", "DVD/x.iso")).toBe("/ps2/DVD/x.iso");
  });
});
