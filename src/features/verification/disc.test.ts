import { describe, expect, it } from "vitest";

import {
  parseSystemCnf,
  readDiscIdentity,
  type DiscRead
} from "@/features/verification/disc";

function writeUint32LE(target: Uint8Array, offset: number, value: number) {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
  target[offset + 2] = (value >>> 16) & 0xff;
  target[offset + 3] = (value >>> 24) & 0xff;
}

function directoryRecord(
  name: string,
  lba: number,
  size: number,
  directory = false
): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const length = 33 + nameBytes.length + (nameBytes.length % 2 === 0 ? 1 : 0);
  const record = new Uint8Array(length);
  record[0] = length;
  writeUint32LE(record, 2, lba);
  writeUint32LE(record, 10, size);
  record[25] = directory ? 0x02 : 0;
  record[32] = nameBytes.length;
  record.set(nameBytes, 33);
  return record;
}

/** A minimal 2048-byte-sector ISO 9660 image with a root `SYSTEM.CNF`. */
function isoImage(systemCnf: string | null, padRoot = false): Uint8Array {
  const sectors = 24;
  const image = new Uint8Array(sectors * 2048);
  const pvd = 16 * 2048;
  image[pvd] = 1;
  image.set(new TextEncoder().encode("CD001"), pvd + 1);
  const rootSize = padRoot ? 4096 : 2048;
  image.set(directoryRecord("\u0000", 20, rootSize, true), pvd + 156);

  let offset = 20 * 2048;
  for (const record of [
    directoryRecord("\u0000", 20, rootSize, true),
    directoryRecord("\u0001", 20, rootSize, true),
    directoryRecord("SLUS_214.47;1", 23, 10)
  ]) {
    image.set(record, offset);
    offset += record.length;
  }
  if (systemCnf !== null) {
    const contents = new TextEncoder().encode(systemCnf);
    // With padRoot the entry sits in the second directory sector, after
    // zero padding — exercising the "records never span sectors" rule.
    const entryOffset = padRoot ? 21 * 2048 : offset;
    image.set(directoryRecord("SYSTEM.CNF;1", 22, contents.length), entryOffset);
    image.set(contents, 22 * 2048);
  }
  return image;
}

/** Re-lays a 2048-byte-sector image as raw 2352-byte Mode 2 Form 1 sectors. */
function toRawBin(iso: Uint8Array): Uint8Array {
  const sectors = iso.length / 2048;
  const raw = new Uint8Array(sectors * 2352);
  for (let sector = 0; sector < sectors; sector += 1) {
    raw.set(iso.slice(sector * 2048, (sector + 1) * 2048), sector * 2352 + 24);
  }
  return raw;
}

function reader(image: Uint8Array): DiscRead {
  return async (offset, length) => image.slice(offset, offset + length);
}

const ps2Cnf = "BOOT2 = cdrom0:\\SLUS_214.47;1\r\nVER = 1.00\r\nVMODE = NTSC\r\n";

describe("readDiscIdentity", () => {
  it("reads a PS2 serial from an .iso image", async () => {
    await expect(readDiscIdentity(reader(isoImage(ps2Cnf))))
      .resolves.toEqual({ system: "ps2", serial: "SLUS-21447" });
  });

  it("reads the same identity from a raw 2352-byte .bin track", async () => {
    await expect(readDiscIdentity(reader(toRawBin(isoImage(ps2Cnf)))))
      .resolves.toEqual({ system: "ps2", serial: "SLUS-21447" });
  });

  it("finds SYSTEM.CNF after sector padding in the root directory", async () => {
    await expect(readDiscIdentity(reader(isoImage(ps2Cnf, true))))
      .resolves.toEqual({ system: "ps2", serial: "SLUS-21447" });
  });

  it("identifies a PS1 disc", async () => {
    await expect(readDiscIdentity(reader(
      isoImage("BOOT = cdrom:\\SCUS_942.27;1\r\n")
    ))).resolves.toEqual({ system: "ps1", serial: "SCUS-94227" });
  });

  it("returns null without SYSTEM.CNF", async () => {
    await expect(readDiscIdentity(reader(isoImage(null)))).resolves.toBeNull();
  });

  it("returns null for data that is not ISO 9660", async () => {
    await expect(readDiscIdentity(reader(new Uint8Array(64 * 1024))))
      .resolves.toBeNull();
  });
});

describe("parseSystemCnf", () => {
  it("tolerates spacing and case in the boot line", () => {
    expect(parseSystemCnf("boot2=cdrom0:\\SLES_541.32;1"))
      .toEqual({ system: "ps2", serial: "SLES-54132" });
  });

  it("keeps the system when the boot path has no serial", () => {
    expect(parseSystemCnf("BOOT2 = cdrom0:\\MAIN.ELF;1"))
      .toEqual({ system: "ps2", serial: null });
  });
});
