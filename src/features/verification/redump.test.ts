import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  displaySerial,
  normalizeSerial,
  parseRedumpDat
} from "@/features/verification/redump";

const sample = `clrmamepro (
\tname "Sony - PlayStation 2"
\tversion "2026.10.07"
)

game (
\tname "Guitar Hero II (USA)"
\tregion "USA"
\tserial "SLUS-21447"
\trom ( name "Guitar Hero II (USA).iso" size 4480335872 crc 0A1B2C3D md5 00112233445566778899AABBCCDDEEFF sha1 0123456789ABCDEF0123456789ABCDEF01234567 )
)
game (
\tname "Guitar Hero II (USA) (Alt)"
\tregion "USA"
\tserial "SLUS-21447, SLUS-21447GH"
\trom ( name "Guitar Hero II (USA) (Alt).iso" size 4480335872 crc 0A1B2C3D md5 00112233445566778899AABBCCDDEEFF sha1 0123456789ABCDEF0123456789ABCDEF01234567 )
)
game (
\tname "Some CD Game (Europe)"
\tregion "Europe"
\trom ( name "Some CD Game (Europe).bin" size 718702992 crc 21137E2D md5 5806748B5D260EB1AC5270B3ED4E7FC3 sha1 857FC05990546CBE1A9E83821809C7B7658D5CFA serial "SLES-12345" )
\trom ( name "Bad Line (Europe).bin" size abc sha1 nothex )
)
`;

describe("parseRedumpDat", () => {
  it("indexes roms by hash, size and serial", () => {
    const index = parseRedumpDat(sample);
    expect(index.version).toBe("2026.10.07");
    expect(index.romCount).toBe(3);
    expect(index.sizes.has(4480335872)).toBe(true);

    const matches = index.bySha1.get("0123456789abcdef0123456789abcdef01234567");
    expect(matches?.map((rom) => rom.gameName)).toEqual([
      "Guitar Hero II (USA)",
      "Guitar Hero II (USA) (Alt)"
    ]);
    expect(matches?.[0]).toMatchObject({
      romName: "Guitar Hero II (USA).iso",
      region: "USA",
      serials: ["SLUS-21447"],
      size: 4480335872
    });
    expect(matches?.[1]?.serials).toEqual(["SLUS-21447", "SLUS-21447GH"]);
    expect(index.bySerial.get("SLUS21447")).toHaveLength(2);
  });

  it("takes a serial from the rom line when the game has none", () => {
    const index = parseRedumpDat(sample);
    expect(index.bySerial.get("SLES12345")?.[0]?.gameName)
      .toBe("Some CD Game (Europe)");
  });

  it("skips malformed rom lines", () => {
    const index = parseRedumpDat(sample);
    expect([...index.bySha1.values()].flat().map((rom) => rom.romName))
      .not.toContain("Bad Line (Europe).bin");
  });

  // Exercised when the real list has been downloaded for local development.
  const realDat = process.env.GAMARR_TEST_REDUMP_PS2_DAT;
  it.skipIf(!realDat || !existsSync(realDat))(
    "parses the full libretro PS2 list",
    () => {
      const index = parseRedumpDat(readFileSync(realDat!, "utf8"));
      expect(index.romCount).toBeGreaterThan(10_000);
      expect(index.bySerial.get("SLUS21447")?.[0]?.gameName)
        .toBe("Guitar Hero II (USA)");
    }
  );
});

describe("serial helpers", () => {
  it("normalizes and displays serials", () => {
    expect(normalizeSerial("slus_214.47")).toBe("SLUS21447");
    expect(displaySerial("SLUS_214.47")).toBe("SLUS-21447");
    expect(displaySerial("SLUS-21447GH")).toBe("SLUS21447GH");
  });
});
