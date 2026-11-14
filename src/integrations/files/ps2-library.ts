import { randomUUID } from "node:crypto";
import { link, open, statfs, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";

import type { Ps2LibraryPort, Ps2LibraryWrite } from "@/features/verification/ports";
import { AppError } from "@/lib/errors";

/**
 * Writes verified images into the Open PS2 Loader share. A file is written to
 * a hidden temp name at the share root (same filesystem, so the final move is
 * atomic) and only appears under `DVD/`/`CD/` once complete. Existing files
 * are never replaced: `link` + `unlink` fails on an existing target, where
 * `rename` would silently overwrite it.
 */
export class NodePs2Library implements Ps2LibraryPort {
  constructor(private readonly root: string) {}

  async freeBytes(): Promise<number> {
    const stats = await statfs(this.root);
    return stats.bavail * stats.bsize;
  }

  async begin(): Promise<Ps2LibraryWrite> {
    const temp = path.join(this.root, `.gamarr-${randomUUID()}.part`);
    let handle: FileHandle | null = await open(temp, "wx", 0o644);
    const root = this.root;
    const close = async () => {
      if (handle) {
        const current = handle;
        handle = null;
        await current.close();
      }
    };
    return {
      async write(chunk) {
        if (!handle) throw new Error("write after close");
        let offset = 0;
        while (offset < chunk.length) {
          const { bytesWritten } = await handle.write(chunk, offset);
          offset += bytesWritten;
        }
      },
      async commit(relativePath) {
        await handle?.sync();
        await close();
        const target = resolveInside(root, relativePath);
        try {
          await link(temp, target);
        } catch (error) {
          await unlink(temp).catch(() => undefined);
          if ((error as NodeJS.ErrnoException).code === "EEXIST") return "exists";
          throw new AppError("UNAVAILABLE", 502, "Couldn't write to the PS2 library folder");
        }
        await unlink(temp);
        return "created";
      },
      async discard() {
        await close().catch(() => undefined);
        await unlink(temp).catch(() => undefined);
      }
    };
  }
}

/** Joins a share-relative path, refusing anything that escapes the share. */
export function resolveInside(root: string, relativePath: string): string {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, relativePath);
  if (!target.startsWith(resolvedRoot + path.sep)) {
    throw new AppError("VALIDATION", 400, "Export path is outside the PS2 library");
  }
  return target;
}
