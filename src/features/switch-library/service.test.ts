import { describe, expect, it } from "vitest";

import type { SwitchLibraryFile } from "@/features/switch-library/models";
import type {
  SwitchLibraryScanner,
  SwitchLibraryTitleReader
} from "@/features/switch-library/ports";
import { SwitchLibraryService } from "@/features/switch-library/service";

function file(overrides: Partial<SwitchLibraryFile> = {}): SwitchLibraryFile {
  return {
    absolutePath: "/library/gamarr-abc/gamarr-abc.xci",
    fileName: "gamarr-abc.xci",
    parentDirName: "gamarr-abc",
    sizeBytes: 1000,
    sourceRoot: "/library",
    ...overrides
  };
}

function scannerOf(files: SwitchLibraryFile[]): SwitchLibraryScanner {
  return { scan: async () => files };
}

function titlesOf(entries: Record<string, string>): SwitchLibraryTitleReader {
  return { titlesByMarker: () => new Map(Object.entries(entries)) };
}

describe("SwitchLibraryService", () => {
  it("is disabled with no roots and scans nothing", async () => {
    let scanned = false;
    const service = new SwitchLibraryService(
      { scan: async () => { scanned = true; return []; } },
      titlesOf({}),
      []
    );

    expect(service.isEnabled()).toBe(false);
    expect(await service.index()).toEqual([]);
    expect(scanned).toBe(false);
  });

  it("names an entry after its game title when the marker resolves", async () => {
    const service = new SwitchLibraryService(
      scannerOf([file()]),
      titlesOf({ "gamarr-abc": "Metroid Prime 4" }),
      ["/library"]
    );

    const entries = await service.index();

    expect(entries).toEqual([{
      name: "Metroid Prime 4.xci",
      absolutePath: "/library/gamarr-abc/gamarr-abc.xci",
      sizeBytes: 1000
    }]);
  });

  it("falls back to the on-disk name when the marker does not resolve", async () => {
    const service = new SwitchLibraryService(
      scannerOf([file()]),
      titlesOf({}),
      ["/library"]
    );

    expect((await service.index())[0].name).toBe("gamarr-abc.xci");
  });

  it("falls back when the directory is not an attempt marker at all", async () => {
    const service = new SwitchLibraryService(
      scannerOf([file({
        absolutePath: "/library/games/Zelda.xci",
        fileName: "Zelda.xci",
        parentDirName: "games"
      })]),
      titlesOf({}),
      ["/library"]
    );

    expect((await service.index())[0].name).toBe("Zelda.xci");
  });

  it("numbers two files that resolve to the same title", async () => {
    const service = new SwitchLibraryService(
      scannerOf([
        file({ absolutePath: "/library/gamarr-b/x.xci", parentDirName: "gamarr-b" }),
        file({ absolutePath: "/library/gamarr-a/x.xci", parentDirName: "gamarr-a" })
      ]),
      titlesOf({ "gamarr-a": "Same Game", "gamarr-b": "Same Game" }),
      ["/library"]
    );

    expect((await service.index()).map((entry) => entry.name))
      .toEqual(["Same Game (2).xci", "Same Game.xci"]);
  });

  it("sorts the finished list by name", async () => {
    const service = new SwitchLibraryService(
      scannerOf([
        file({ absolutePath: "/library/g1/z.xci", parentDirName: "g1", fileName: "z.xci" }),
        file({ absolutePath: "/library/g2/a.xci", parentDirName: "g2", fileName: "a.xci" })
      ]),
      titlesOf({}),
      ["/library"]
    );

    expect((await service.index()).map((entry) => entry.name)).toEqual(["a.xci", "z.xci"]);
  });

  it("resolves a name back to its entry", async () => {
    const service = new SwitchLibraryService(
      scannerOf([file()]),
      titlesOf({ "gamarr-abc": "Metroid Prime 4" }),
      ["/library"]
    );

    expect(await service.resolve("Metroid Prime 4.xci"))
      .toMatchObject({ absolutePath: "/library/gamarr-abc/gamarr-abc.xci" });
  });

  it("returns null for an unknown name", async () => {
    const service = new SwitchLibraryService(
      scannerOf([file()]),
      titlesOf({}),
      ["/library"]
    );

    expect(await service.resolve("../../etc/passwd")).toBeNull();
    expect(await service.resolve("Nothing.xci")).toBeNull();
  });

  it("asks for each marker only once", async () => {
    const asked: string[][] = [];
    const service = new SwitchLibraryService(
      scannerOf([
        file({ absolutePath: "/library/gamarr-abc/one.xci" }),
        file({ absolutePath: "/library/gamarr-abc/two.xci" })
      ]),
      { titlesByMarker: (markers) => { asked.push(markers); return new Map(); } },
      ["/library"]
    );

    await service.index();

    expect(asked).toEqual([["gamarr-abc"]]);
  });
});
