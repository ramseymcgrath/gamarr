import { describe, expect, it } from "vitest";

import { extractSerials } from "@/lib/disc-serial";

describe("extractSerials", () => {
  it("finds serials in the forms release names use", () => {
    expect(extractSerials("Guitar Hero II [SLUS-21447]")).toEqual(["SLUS21447"]);
    expect(extractSerials("SLES_544.42.Guitar.Hero.II.PAL")).toEqual(["SLES54442"]);
    expect(extractSerials("scus 97101 / SCUS97101")).toEqual(["SCUS97101"]);
  });

  it("ignores digits glued to other text", () => {
    expect(extractSerials("XSLUS-21447 SLUS-214470 Game 2007")).toEqual([]);
  });
});
