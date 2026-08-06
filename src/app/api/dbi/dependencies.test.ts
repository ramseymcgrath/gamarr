import { describe, expect, it } from "vitest";

// Only the pure root parser is exercised here. Calling `dbiDependencies()`
// would construct the repository, which calls `getDatabase()` eagerly and
// opens a real SQLite file as a side effect. The wiring is covered by the
// manual verification steps instead.
import { parseLibraryRoots } from "@/app/api/dbi/dependencies";

describe("parseLibraryRoots", () => {
  it("returns no roots when unset or blank", () => {
    expect(parseLibraryRoots(undefined)).toEqual([]);
    expect(parseLibraryRoots("")).toEqual([]);
    expect(parseLibraryRoots("   ")).toEqual([]);
    expect(parseLibraryRoots(",,")).toEqual([]);
  });

  it("splits on commas and trims", () => {
    expect(parseLibraryRoots("/library, /config/downloads"))
      .toEqual(["/library", "/config/downloads"]);
  });

  it("drops relative paths, which cannot be confined", () => {
    expect(parseLibraryRoots("/library,relative/path")).toEqual(["/library"]);
  });

  it("de-duplicates repeated roots", () => {
    expect(parseLibraryRoots("/library,/library")).toEqual(["/library"]);
  });
});
