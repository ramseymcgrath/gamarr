import { describe, expect, it } from "vitest";

import {
  isExtraTrack,
  oplFileName,
  oplPath,
  rawDataOffset,
  rawToIso
} from "@/features/verification/opl";
import type { RedumpRom } from "@/features/verification/redump";

const rom = (gameName: string, romName: string): RedumpRom => ({
  gameName, romName, region: null, serials: [], size: 1, sha1: "0"
});

async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const chunk of chunks) parts.push(chunk);
  return Buffer.concat(parts);
}

async function* chunked(bytes: Uint8Array, size: number) {
  for (let offset = 0; offset < bytes.length; offset += size) {
    yield bytes.subarray(offset, offset + size);
  }
}

describe("OPL naming", () => {
  it("files DVD images under DVD/ and CD images under CD/ by Redump name", () => {
    expect(oplPath(rom("Burnout 3 - Takedown (USA, Canada)", "Burnout 3 - Takedown (USA, Canada).iso")))
      .toBe("DVD/Burnout 3 - Takedown (USA, Canada).iso");
    expect(oplPath(rom("Twisted Metal - Black (USA)", "Twisted Metal - Black (USA) (Track 1).bin")))
      .toBe("CD/Twisted Metal - Black (USA).iso");
  });

  it("replaces characters SMB and FAT can't hold, and never escapes the folder", () => {
    expect(oplFileName(rom("Who: What? / Why*", "x.iso"))).toBe("Who_ What_ _ Why_.iso");
    expect(oplFileName(rom("../..", "x.iso"))).toBe(".._.iso");
    expect(oplFileName(rom("  ", "x.iso"))).toBe("Untitled.iso");
  });

  it("treats only Track 2+ as extra audio tracks", () => {
    expect(isExtraTrack("Game (USA) (Track 1).bin")).toBe(false);
    expect(isExtraTrack("Game (USA) (Track 2).bin")).toBe(true);
    expect(isExtraTrack("Game (USA).iso")).toBe(false);
  });
});

describe("raw CD sectors", () => {
  const sync = [0x00, ...Array<number>(10).fill(0xff), 0x00];

  function rawImage(mode: 1 | 2, sectors: number): { raw: Uint8Array; iso: Uint8Array } {
    const offset = mode === 1 ? 16 : 24;
    const raw = new Uint8Array(sectors * 2352);
    const iso = new Uint8Array(sectors * 2048);
    for (let sector = 0; sector < sectors; sector += 1) {
      raw.set(sync, sector * 2352);
      raw[sector * 2352 + 15] = mode;
      for (let byte = 0; byte < 2048; byte += 1) {
        const value = (sector * 7 + byte) & 0xff;
        raw[sector * 2352 + offset + byte] = value;
        iso[sector * 2048 + byte] = value;
      }
      raw.fill(0xee, sector * 2352 + offset + 2048, (sector + 1) * 2352);
    }
    return { raw, iso };
  }

  it("detects Mode 1, Mode 2 and plain .iso images", () => {
    expect(rawDataOffset(rawImage(1, 1).raw)).toBe(16);
    expect(rawDataOffset(rawImage(2, 1).raw)).toBe(24);
    expect(rawDataOffset(new Uint8Array(2048))).toBeNull();
  });

  it.each([1, 2] as const)("unwraps Mode %i user data across uneven chunk boundaries", async (mode) => {
    const { raw, iso } = rawImage(mode, 5);
    const offset = rawDataOffset(raw)!;
    await expect(collect(rawToIso(chunked(raw, 1000), offset))).resolves.toEqual(Buffer.from(iso));
  });
});
