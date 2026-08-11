import { AppError } from "@/lib/errors";

/** Deeper than any real torrent; shallow enough to stop a nesting bomb. */
const maxDepth = 32;

export interface TorrentFile {
  index: number;
  name: string;
  size: number | null;
}

type Bencode =
  | number
  | Uint8Array
  | Bencode[]
  | Map<string, Bencode>;

function malformed(): never {
  throw new AppError("UNAVAILABLE", 502, "Indexer returned a malformed torrent");
}

class Reader {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  get position(): number {
    return this.offset;
  }

  private byte(): number {
    if (this.offset >= this.bytes.length) malformed();
    return this.bytes[this.offset]!;
  }

  private expect(character: string): void {
    if (String.fromCharCode(this.byte()) !== character) malformed();
    this.offset += 1;
  }

  /** Reads decimal digits (with an optional leading `-`) up to `terminator`. */
  private readNumber(terminator: string): number {
    let text = "";
    for (;;) {
      const character = String.fromCharCode(this.byte());
      this.offset += 1;
      if (character === terminator) break;
      if (!/[-0-9]/.test(character) || text.length > 20) malformed();
      text += character;
    }
    if (text.length === 0) malformed();
    const value = Number(text);
    if (!Number.isSafeInteger(value)) malformed();
    return value;
  }

  read(depth = 0): Bencode {
    if (depth > maxDepth) malformed();
    const marker = String.fromCharCode(this.byte());

    if (marker === "i") {
      this.offset += 1;
      return this.readNumber("e");
    }

    if (marker === "l") {
      this.offset += 1;
      const items: Bencode[] = [];
      while (String.fromCharCode(this.byte()) !== "e") {
        items.push(this.read(depth + 1));
      }
      this.offset += 1;
      return items;
    }

    if (marker === "d") {
      this.offset += 1;
      const entries = new Map<string, Bencode>();
      while (String.fromCharCode(this.byte()) !== "e") {
        const key = this.read(depth + 1);
        if (!(key instanceof Uint8Array)) malformed();
        entries.set(new TextDecoder().decode(key), this.read(depth + 1));
      }
      this.offset += 1;
      return entries;
    }

    if (/[0-9]/.test(marker)) {
      const length = this.readNumber(":");
      if (length < 0 || this.offset + length > this.bytes.length) malformed();
      const slice = this.bytes.subarray(this.offset, this.offset + length);
      this.offset += length;
      return slice;
    }

    return malformed();
  }
}

function asMap(value: Bencode | undefined): Map<string, Bencode> {
  if (!(value instanceof Map)) malformed();
  return value;
}

function asText(value: Bencode | undefined): string {
  if (!(value instanceof Uint8Array)) malformed();
  return new TextDecoder().decode(value);
}

function asSize(value: Bencode | undefined): number | null {
  if (value === undefined) return null;
  if (typeof value !== "number" || value < 0) malformed();
  return value;
}

/**
 * A path segment that is empty, `.`, `..`, or contains a separator would let a
 * hostile torrent render a misleading name. Gamarr never writes these bytes
 * itself — qBittorrent does — but the name is shown to the user and is used to
 * verify the index before priorities are written, so it must be trustworthy.
 */
function assertSafeSegment(segment: string): void {
  if (
    segment.length === 0
    || segment === "."
    || segment === ".."
    || segment.includes("/")
    || segment.includes("\\")
  ) {
    malformed();
  }
}

export function decodeTorrentFiles(bytes: Uint8Array): TorrentFile[] {
  const reader = new Reader(bytes);
  const root = reader.read();
  if (!(root instanceof Map)) malformed();
  if (reader.position !== bytes.length) malformed();

  const info = asMap(root.get("info"));
  const name = asText(info.get("name"));
  assertSafeSegment(name);

  const files = info.get("files");
  if (files === undefined) {
    return [{ index: 0, name, size: asSize(info.get("length")) }];
  }

  if (!Array.isArray(files)) malformed();
  return files.map((entry, index) => {
    const file = asMap(entry);
    const path = file.get("path");
    if (!Array.isArray(path) || path.length === 0) malformed();
    const segments = path.map((segment) => {
      const text = asText(segment);
      assertSafeSegment(text);
      return text;
    });
    return {
      index,
      name: [name, ...segments].join("/"),
      size: asSize(file.get("length"))
    };
  });
}
