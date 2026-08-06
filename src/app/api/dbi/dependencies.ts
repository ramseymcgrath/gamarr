import "server-only";

import { open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

import { getDatabase } from "@/db/client";
import type { FileOpener } from "@/features/switch-library/ports";
import { SqliteSwitchLibraryRepository } from "@/features/switch-library/repository";
import { SwitchLibraryService } from "@/features/switch-library/service";
import { FilesystemSwitchLibraryScanner } from "@/integrations/filesystem/switch-library-scanner";

/**
 * Relative roots are dropped rather than resolved against the process cwd:
 * a root that moves with the working directory cannot be reasoned about for
 * confinement, and silently serving the wrong tree is worse than serving none.
 */
export function parseLibraryRoots(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  const roots = raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "" && path.isAbsolute(value));
  return [...new Set(roots)];
}

const fileOpener: FileOpener = {
  async open(absolutePath) {
    let handle: FileHandle | undefined;
    try {
      // Bound to a const as well so the closures below capture a handle
      // TypeScript can see is defined; `handle` exists only for the cleanup
      // path in the catch.
      const opened = await open(absolutePath, "r");
      handle = opened;
      const stats = await opened.stat();
      if (!stats.isFile()) {
        await opened.close();
        return null;
      }
      return {
        sizeBytes: stats.size,
        stream(start, end) {
          // The stream takes ownership of the handle and closes it when it
          // ends or is destroyed.
          return Readable.toWeb(
            opened.createReadStream({ start, end, autoClose: true })
          ) as ReadableStream<Uint8Array>;
        },
        close: () => opened.close()
      };
    } catch {
      if (handle !== undefined) await handle.close().catch(() => undefined);
      return null;
    }
  }
};

export function dbiDependencies() {
  return {
    service: new SwitchLibraryService(
      new FilesystemSwitchLibraryScanner(),
      new SqliteSwitchLibraryRepository(getDatabase()),
      parseLibraryRoots(process.env.GAMARR_SWITCH_LIBRARY_DIR)
    ),
    opener: fileOpener
  };
}
