/**
 * Open PS2 Loader conventions for the share gamarr exports to. OPL on a real
 * console plays plain 2048-byte-sector `.iso` images from `DVD/` and `CD/`;
 * it does not read CHD, CSO-on-SMB or raw `.bin`/`.cue`.
 *
 * Pure: naming and sector conversion only.
 */

import type { RedumpRom } from "@/features/verification/redump";

export type OplFolder = "DVD" | "CD";

/** Redump stores PS2 DVDs as `.iso` and PS2 CDs as `.bin` (+ `.cue`). */
export function oplFolder(rom: RedumpRom): OplFolder {
  return rom.romName.toLowerCase().endsWith(".iso") ? "DVD" : "CD";
}

/**
 * The Redump game name, which is what the share already uses
 * (`Burnout 3 - Takedown (USA, Canada).iso`), with characters SMB and FAT
 * can't hold replaced.
 */
export function oplFileName(rom: RedumpRom): string {
  const safe = rom.gameName
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_")
    .replace(/[. ]+$/, "")
    .trim();
  return `${safe || "Untitled"}.iso`;
}

export function oplPath(rom: RedumpRom): string {
  return `${oplFolder(rom)}/${oplFileName(rom)}`;
}

/**
 * Audio tracks of a mixed-mode CD (`(Track 2).bin` …). OPL boots the data
 * track and can't play CD audio, so only Track 1 is exported.
 */
export function isExtraTrack(name: string): boolean {
  const track = /\(Track (\d+)\)/i.exec(name);
  return track !== null && Number(track[1]) !== 1;
}

export const RAW_SECTOR = 2352;
const SYNC = [0x00, ...Array<number>(10).fill(0xff), 0x00];

/**
 * Where the 2048 user-data bytes sit in a raw 2352-byte sector: after the
 * 16-byte sync+header for Mode 1, after the 8-byte subheader too for Mode 2
 * Form 1 (what PlayStation CDs use). `null` for a non-raw (2048) image.
 */
export function rawDataOffset(head: Uint8Array): 16 | 24 | null {
  if (head.length < 16) return null;
  for (let index = 0; index < SYNC.length; index += 1) {
    if (head[index] !== SYNC[index]) return null;
  }
  return head[15] === 1 ? 16 : 24;
}

/**
 * Re-chunks a raw `.bin` stream into its 2048-byte user data: the `.iso`
 * OPL plays. A trailing partial sector (a truncated dump) is dropped.
 */
export async function* rawToIso(
  chunks: AsyncIterable<Uint8Array>,
  dataOffset: 16 | 24
): AsyncGenerator<Uint8Array> {
  let carry = new Uint8Array(0);
  for await (const chunk of chunks) {
    const buffer = carry.length === 0 ? chunk : concat(carry, chunk);
    const sectors = Math.floor(buffer.length / RAW_SECTOR);
    if (sectors > 0) {
      const out = new Uint8Array(sectors * 2048);
      for (let sector = 0; sector < sectors; sector += 1) {
        const start = sector * RAW_SECTOR + dataOffset;
        out.set(buffer.subarray(start, start + 2048), sector * 2048);
      }
      yield out;
    }
    carry = buffer.slice(sectors * RAW_SECTOR);
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
