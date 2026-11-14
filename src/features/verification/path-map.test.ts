import { describe, expect, it } from "vitest";

import { mapClientPath, parsePathMap } from "@/features/verification/path-map";

const mappings = parsePathMap("/downloads=/library, /downloads/games=/library");

describe("mapClientPath", () => {
  it("maps qBittorrent and SABnzbd paths onto gamarr's mount", () => {
    expect(mapClientPath("/downloads/Guitar Hero II (USA)", mappings))
      .toBe("/library/Guitar Hero II (USA)");
    expect(mapClientPath("/downloads/games/Guitar Hero II (USA)/", mappings))
      .toBe("/library/Guitar Hero II (USA)");
  });

  it("matches whole path segments only", () => {
    expect(mapClientPath("/downloadsX/game", mappings)).toBeNull();
  });

  it("refuses paths that escape the mapped root", () => {
    expect(mapClientPath("/downloads/../etc/passwd", mappings)).toBeNull();
    expect(mapClientPath("relative/path", mappings)).toBeNull();
  });

  it("returns null with no mapping configured", () => {
    expect(mapClientPath("/downloads/game", parsePathMap(undefined))).toBeNull();
  });

  it("ignores malformed pairs", () => {
    expect(parsePathMap("downloads=/library,/a=/b=/c,/x=/y"))
      .toEqual([{ from: "/x", to: "/y" }]);
  });
});
