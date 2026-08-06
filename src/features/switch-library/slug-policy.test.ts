import { describe, expect, it } from "vitest";

import {
  extensionOf,
  isExcludedFileName,
  isInstallableFileName,
  markerFromDirName,
  resolveDisplayNames
} from "@/features/switch-library/slug-policy";

describe("isInstallableFileName", () => {
  it("accepts the four Switch container extensions regardless of case", () => {
    expect(isInstallableFileName("Game.nsp")).toBe(true);
    expect(isInstallableFileName("Game.NSZ")).toBe(true);
    expect(isInstallableFileName("Game.xci")).toBe(true);
    expect(isInstallableFileName("Game.XcZ")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isInstallableFileName("Game.3ds")).toBe(false);
    expect(isInstallableFileName("readme.txt")).toBe(false);
    expect(isInstallableFileName("Game")).toBe(false);
  });
});

describe("isExcludedFileName", () => {
  it("excludes dotfiles and in-progress part files", () => {
    // The downloader writes `.gamarr-{attemptId}.part` beside the eventual
    // file. Serving one would hand DBI a truncated NSP that fails hash
    // verification partway through an install.
    expect(isExcludedFileName(".gamarr-abc.part")).toBe(true);
    expect(isExcludedFileName(".DS_Store")).toBe(true);
    expect(isExcludedFileName("Game.xci.part")).toBe(true);
  });

  it("does not exclude ordinary names", () => {
    expect(isExcludedFileName("Game.xci")).toBe(false);
  });
});

describe("markerFromDirName", () => {
  it("returns the directory name when it is an attempt marker", () => {
    // sab_marker is written as `gamarr-{attemptId}` for every attempt
    // regardless of source, and carries a UNIQUE index.
    expect(markerFromDirName("gamarr-998e730a-7029-4541-bf4d-9e743e5ba848"))
      .toBe("gamarr-998e730a-7029-4541-bf4d-9e743e5ba848");
  });

  it("returns null for anything else", () => {
    expect(markerFromDirName("games")).toBeNull();
    expect(markerFromDirName("gamarr-")).toBeNull();
    expect(markerFromDirName("gamarr-has spaces")).toBeNull();
  });
});

describe("extensionOf", () => {
  it("returns the trailing extension including the dot", () => {
    expect(extensionOf("Game.xci")).toBe(".xci");
    expect(extensionOf("Game.part.nsp")).toBe(".nsp");
  });

  it("returns empty string when there is no extension", () => {
    expect(extensionOf("Game")).toBe("");
    expect(extensionOf(".hidden")).toBe("");
  });
});

describe("resolveDisplayNames", () => {
  it("leaves a unique name untouched", () => {
    const names = resolveDisplayNames([
      { absolutePath: "/a/Game.xci", preferredName: "Game.xci" }
    ]);
    expect(names.get("/a/Game.xci")).toBe("Game.xci");
  });

  it("numbers collisions by absolute path, inserting before the extension", () => {
    // readdir order is not guaranteed, so numbering must key off the path.
    const names = resolveDisplayNames([
      { absolutePath: "/z/Game.xci", preferredName: "Game.xci" },
      { absolutePath: "/a/Game.xci", preferredName: "Game.xci" }
    ]);
    expect(names.get("/a/Game.xci")).toBe("Game.xci");
    expect(names.get("/z/Game.xci")).toBe("Game (2).xci");
  });

  it("produces the same numbering regardless of input order", () => {
    const forward = resolveDisplayNames([
      { absolutePath: "/a/G.xci", preferredName: "G.xci" },
      { absolutePath: "/b/G.xci", preferredName: "G.xci" },
      { absolutePath: "/c/G.xci", preferredName: "G.xci" }
    ]);
    const reversed = resolveDisplayNames([
      { absolutePath: "/c/G.xci", preferredName: "G.xci" },
      { absolutePath: "/b/G.xci", preferredName: "G.xci" },
      { absolutePath: "/a/G.xci", preferredName: "G.xci" }
    ]);
    expect([...forward.entries()].sort()).toEqual([...reversed.entries()].sort());
    expect(forward.get("/c/G.xci")).toBe("G (3).xci");
  });

  it("treats names differing only by case as colliding", () => {
    const names = resolveDisplayNames([
      { absolutePath: "/a/game.xci", preferredName: "game.xci" },
      { absolutePath: "/b/GAME.xci", preferredName: "GAME.xci" }
    ]);
    expect(names.get("/b/GAME.xci")).toBe("GAME (2).xci");
  });
});
