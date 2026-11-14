/**
 * Redump checksum lists in clrmamepro text format, as mirrored by
 * libretro-database (`metadat/redump/<System>.dat`):
 *
 *   game (
 *     name "Guitar Hero II (USA)"
 *     region "USA"
 *     serial "SLUS-21447"
 *     rom ( name "Guitar Hero II (USA).iso" size 4… crc … md5 … sha1 … )
 *   )
 *
 * Pure: parsing and lookup only. Fetching and caching live in the adapter.
 */

import { displaySerial, normalizeSerial } from "@/lib/disc-serial";

export { displaySerial, normalizeSerial };

export interface RedumpRom {
  gameName: string;
  romName: string;
  region: string | null;
  serials: string[];
  size: number;
  sha1: string;
}

export interface RedumpIndex {
  version: string | null;
  romCount: number;
  /** Lowercase SHA-1 → every rom with that hash (serial variants repeat). */
  bySha1: Map<string, RedumpRom[]>;
  /** Exact byte sizes present in the list: the cheap pre-hash filter. */
  sizes: Set<number>;
  /** Normalized serial (`SLUS21447`) → the roms released under it. */
  bySerial: Map<string, RedumpRom[]>;
  /** `titleKey` of a retail game's name → its roms (demos and betas left out). */
  byTitle: Map<string, RedumpRom[]>;
}

const quoted = (field: string) => new RegExp(`\\b${field} "([^"]*)"`);
const numeric = (field: string) => new RegExp(`\\b${field} (\\d+)\\b`);
const hex = (field: string) => new RegExp(`\\b${field} ([0-9A-Fa-f]+)\\b`);

function splitSerials(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[,/]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function parseRedumpDat(text: string): RedumpIndex {
  const index: RedumpIndex = {
    version: quoted("version").exec(text.slice(0, 2_000))?.[1] ?? null,
    romCount: 0,
    bySha1: new Map(),
    sizes: new Set(),
    bySerial: new Map(),
    byTitle: new Map()
  };

  let game: {
    name: string | null;
    region: string | null;
    serials: string[];
  } | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("game (")) {
      game = { name: null, region: null, serials: [] };
      continue;
    }
    if (!game) continue;
    if (line === ")") {
      game = null;
      continue;
    }
    if (line.startsWith("rom (")) {
      const romName = quoted("name").exec(line)?.[1];
      const size = Number(numeric("size").exec(line)?.[1]);
      const sha1 = hex("sha1").exec(line)?.[1]?.toLowerCase();
      if (!romName || !Number.isSafeInteger(size) || !sha1 || sha1.length !== 40) {
        continue;
      }
      const serials = [
        ...game.serials,
        ...splitSerials(quoted("serial").exec(line)?.[1])
      ];
      const rom: RedumpRom = {
        gameName: game.name ?? romName,
        romName,
        region: game.region,
        // Kept as Redump writes them; lookups go through normalizeSerial.
        serials: [...new Set(serials)],
        size,
        sha1
      };
      index.romCount += 1;
      index.sizes.add(size);
      append(index.bySha1, sha1, rom);
      for (const serial of rom.serials) {
        append(index.bySerial, normalizeSerial(serial), rom);
      }
      if (!NON_RETAIL.test(rom.gameName)) {
        const key = titleKey(rom.gameName);
        if (key) append(index.byTitle, key, rom);
      }
      continue;
    }
    const name = quoted("name").exec(line);
    if (name && line.startsWith("name ")) {
      game.name = name[1]!;
      continue;
    }
    const region = quoted("region").exec(line);
    if (region && line.startsWith("region ")) {
      game.region = region[1]!;
      continue;
    }
    const serial = quoted("serial").exec(line);
    if (serial && line.startsWith("serial ")) {
      game.serials.push(...splitSerials(serial[1]));
    }
  }
  return index;
}

function append<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}

/** Redump tags for discs that aren't the retail game. */
const NON_RETAIL = /\((?:[^)]*\b)?(?:demo|beta|proto|prototype|kiosk|sample|preview|trial|taikenban|tentoumuke)\b[^)]*\)/i;

/**
 * A comparable title: Redump's `Guitar Hero III - Legends of Rock (USA)` and
 * IGDB's `Guitar Hero III: Legends of Rock` both become
 * `guitar hero iii legends of rock`. Redump's trailing articles
 * (`Sims, The - Bustin' Out`) move back to the front of their segment.
 */
export function titleKey(name: string): string {
  return name
    .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
    .split(/\s+-\s+/)
    .map((segment) => segment.trim().replace(/^(.*), (The|A|An)$/i, "$2 $1"))
    .join(" ")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function regionRank(region: string | null): number {
  if (!region) return 4;
  if (/\bUSA\b/.test(region)) return 0;
  if (/\bWorld\b/.test(region)) return 1;
  if (/\bEurope\b/.test(region)) return 2;
  return 3;
}

/**
 * Every serial the retail releases of a game were published under, in
 * display form, USA releases first. Empty when no title matches exactly.
 */
export function serialsForTitles(index: RedumpIndex, titles: string[]): string[] {
  const roms = new Set<RedumpRom>();
  for (const title of titles) {
    for (const rom of index.byTitle.get(titleKey(title)) ?? []) roms.add(rom);
  }
  const ordered = [...roms].sort((left, right) =>
    regionRank(left.region) - regionRank(right.region));
  return [...new Set(ordered.flatMap((rom) => rom.serials.flatMap((serial) => {
    // Redump marks reprints and bundles with suffixes (`SLUS-21050GH`,
    // `SLES-52541/ANZ`, `SLES-525413`); the disc itself carries the base.
    const base = /^[A-Z]{4}\d{5}/.exec(normalizeSerial(serial))?.[0];
    return base ? [displaySerial(base)] : [];
  })))];
}
