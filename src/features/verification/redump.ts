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
}

const quoted = (field: string) => new RegExp(`\\b${field} "([^"]*)"`);
const numeric = (field: string) => new RegExp(`\\b${field} (\\d+)\\b`);
const hex = (field: string) => new RegExp(`\\b${field} ([0-9A-Fa-f]+)\\b`);

/** `SLUS_214.47`, `SLUS-21447`, `slus 21447` all normalize to `SLUS21447`. */
export function normalizeSerial(serial: string): string {
  return serial.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** `SLUS21447` → `SLUS-21447`, the form Redump and box art use. */
export function displaySerial(serial: string): string {
  const normalized = normalizeSerial(serial);
  const match = /^([A-Z]{4})(\d+)$/.exec(normalized);
  return match ? `${match[1]}-${match[2]}` : normalized;
}

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
    bySerial: new Map()
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
