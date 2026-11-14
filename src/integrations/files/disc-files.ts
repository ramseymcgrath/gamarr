import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { basename, join, relative } from "node:path";

import type { DiscRead } from "@/features/verification/disc";
import type { DiscFileEntry, DiscFilesPort } from "@/features/verification/ports";
import { AppError } from "@/lib/errors";

const MAX_DEPTH = 4;
const MAX_FILES = 2_000;
/** Large reads keep hashing a multi-gigabyte image disk-bound, not syscall-bound. */
const HASH_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * Read-only access to completed downloads under gamarr's library mount.
 * Symlinks are never followed, so a download can't point the verifier at
 * files outside the mount.
 */
export class NodeDiscFiles implements DiscFilesPort {
  async list(path: string): Promise<DiscFileEntry[]> {
    let info;
    try {
      info = await lstat(path);
    } catch {
      throw new AppError("NOT_FOUND", 404, "The downloaded files are no longer there");
    }
    if (info.isFile()) return [{ path, name: basename(path), size: info.size }];
    if (!info.isDirectory()) return [];

    const entries: DiscFileEntry[] = [];
    const walk = async (directory: string, depth: number): Promise<void> => {
      if (depth > MAX_DEPTH || entries.length >= MAX_FILES) return;
      const children = await readdir(directory, { withFileTypes: true });
      children.sort((a, b) => a.name.localeCompare(b.name));
      for (const child of children) {
        if (entries.length >= MAX_FILES) return;
        const childPath = join(directory, child.name);
        if (child.isDirectory()) {
          await walk(childPath, depth + 1);
        } else if (child.isFile()) {
          const childInfo = await lstat(childPath);
          entries.push({
            path: childPath,
            name: relative(path, childPath),
            size: childInfo.size
          });
        }
      }
    };
    await walk(path, 0);
    return entries;
  }

  sha1(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = createHash("sha1");
      createReadStream(path, { highWaterMark: HASH_CHUNK_BYTES })
        .on("data", (chunk) => hash.update(chunk))
        .on("error", () =>
          reject(new AppError("UNAVAILABLE", 502, "Couldn't read the disc image")))
        .on("end", () => resolve(hash.digest("hex")));
    });
  }

  async *stream(path: string): AsyncGenerator<Uint8Array> {
    try {
      for await (const chunk of createReadStream(path, { highWaterMark: HASH_CHUNK_BYTES })) {
        yield chunk as Uint8Array;
      }
    } catch {
      throw new AppError("UNAVAILABLE", 502, "Couldn't read the disc image");
    }
  }

  reader(path: string): DiscRead {
    return async (offset, length) => {
      const handle = await open(path, "r");
      try {
        const buffer = new Uint8Array(length);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        return buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    };
  }
}
