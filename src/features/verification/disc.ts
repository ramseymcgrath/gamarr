/**
 * Reads a PlayStation disc's identity from `SYSTEM.CNF` in its ISO 9660
 * filesystem. PS2 discs name their boot executable with `BOOT2 =
 * cdrom0:\SLUS_214.47;1` (the game serial); PS1 discs use `BOOT =`.
 *
 * Works on 2048-byte-sector `.iso` images and raw 2352-byte-sector `.bin`
 * tracks (Mode 1 or Mode 2 Form 1). Pure: all I/O goes through `read`.
 */

export type DiscRead = (offset: number, length: number) => Promise<Uint8Array>;

export interface DiscIdentity {
  /** `ps2` from `BOOT2`, `ps1` from `BOOT`. */
  system: "ps2" | "ps1";
  /** Display form, e.g. `SLUS-21447`. `null` when the boot line has none. */
  serial: string | null;
}

interface SectorLayout {
  sectorSize: number;
  /** Byte offset of the 2048 user-data bytes within each raw sector. */
  dataOffset: number;
}

const LAYOUTS: SectorLayout[] = [
  { sectorSize: 2048, dataOffset: 0 },
  { sectorSize: 2352, dataOffset: 24 }, // Mode 2 Form 1 (PS1/PS2 CD)
  { sectorSize: 2352, dataOffset: 16 } // Mode 1
];

const PVD_SECTOR = 16;
const MAX_DIRECTORY_BYTES = 256 * 1024;
const MAX_SYSTEM_CNF_BYTES = 4 * 1024;

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]!
    | (bytes[offset + 1]! << 8)
    | (bytes[offset + 2]! << 16)
    | (bytes[offset + 3]! << 24)
  ) >>> 0;
}

function isPrimaryVolumeDescriptor(bytes: Uint8Array): boolean {
  return bytes.length >= 6
    && bytes[0] === 1
    && String.fromCharCode(...bytes.slice(1, 6)) === "CD001";
}

/** Reads `length` bytes of user data starting at logical sector `lba`. */
async function readUserData(
  read: DiscRead,
  layout: SectorLayout,
  lba: number,
  length: number
): Promise<Uint8Array> {
  if (layout.sectorSize === 2048) return read(lba * 2048, length);
  const out = new Uint8Array(length);
  let copied = 0;
  for (let sector = lba; copied < length; sector += 1) {
    const take = Math.min(2048, length - copied);
    const chunk = await read(
      sector * layout.sectorSize + layout.dataOffset,
      take
    );
    if (chunk.length < take) return out.slice(0, copied + chunk.length);
    out.set(chunk, copied);
    copied += take;
  }
  return out;
}

async function detectLayout(read: DiscRead): Promise<SectorLayout | null> {
  for (const layout of LAYOUTS) {
    const descriptor = await read(
      PVD_SECTOR * layout.sectorSize + layout.dataOffset,
      6
    );
    if (isPrimaryVolumeDescriptor(descriptor)) return layout;
  }
  return null;
}

/** `SLUS_214.47` → `SLUS-21447`. */
function serialFromBootPath(path: string): string | null {
  const match = /([A-Z]{4})[_-](\d{3})\.?(\d{2})/i.exec(path);
  return match
    ? `${match[1]!.toUpperCase()}-${match[2]}${match[3]}`
    : null;
}

export function parseSystemCnf(text: string): DiscIdentity | null {
  const boot2 = /^\s*BOOT2\s*=\s*(.+)$/im.exec(text);
  if (boot2) return { system: "ps2", serial: serialFromBootPath(boot2[1]!) };
  const boot = /^\s*BOOT\s*=\s*(.+)$/im.exec(text);
  if (boot) return { system: "ps1", serial: serialFromBootPath(boot[1]!) };
  return null;
}

/**
 * `null` when the image has no ISO 9660 volume or no `SYSTEM.CNF` in its root
 * directory — i.e. it is not a PlayStation disc this reader understands.
 */
export async function readDiscIdentity(
  read: DiscRead
): Promise<DiscIdentity | null> {
  const layout = await detectLayout(read);
  if (!layout) return null;

  const pvd = await readUserData(read, layout, PVD_SECTOR, 2048);
  // Root directory record: 34 bytes at offset 156 of the PVD.
  const rootLba = readUint32LE(pvd, 156 + 2);
  const rootSize = Math.min(readUint32LE(pvd, 156 + 10), MAX_DIRECTORY_BYTES);
  const directory = await readUserData(read, layout, rootLba, rootSize);

  let offset = 0;
  while (offset < directory.length) {
    const recordLength = directory[offset]!;
    if (recordLength === 0) {
      // Records never span sectors; zero padding means "next sector".
      offset = (Math.floor(offset / 2048) + 1) * 2048;
      continue;
    }
    if (offset + recordLength > directory.length) break;
    const nameLength = directory[offset + 32]!;
    const name = String.fromCharCode(
      ...directory.slice(offset + 33, offset + 33 + nameLength)
    ).toUpperCase();
    const isDirectory = (directory[offset + 25]! & 0x02) !== 0;
    if (!isDirectory && name.replace(/;\d+$/, "") === "SYSTEM.CNF") {
      const lba = readUint32LE(directory, offset + 2);
      const size = Math.min(
        readUint32LE(directory, offset + 10),
        MAX_SYSTEM_CNF_BYTES
      );
      const contents = await readUserData(read, layout, lba, size);
      return parseSystemCnf(new TextDecoder("latin1").decode(contents));
    }
    offset += recordLength;
  }
  return null;
}
