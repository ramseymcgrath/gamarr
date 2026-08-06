import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

import type { SwitchLibraryFile } from "@/features/switch-library/models";
import type { SwitchLibraryScanner } from "@/features/switch-library/ports";
import {
  isExcludedFileName,
  isInstallableFileName
} from "@/features/switch-library/slug-policy";

const MAX_DEPTH = 2;

/**
 * Walks operator-nominated roots for installable Switch files.
 *
 * Every candidate is resolved with `realpath` and re-checked against its root,
 * so a symlink planted in a read-only mount cannot reach outside it. A root
 * that is missing or unreadable is skipped rather than failing the scan —
 * a misconfigured second mount should not take the whole index down.
 */
export class FilesystemSwitchLibraryScanner implements SwitchLibraryScanner {
  async scan(roots: string[]): Promise<SwitchLibraryFile[]> {
    // Keyed by resolved path: a symlink and its target, or two overlapping
    // roots, must not yield two rows naming the same bytes. Display names are
    // keyed by absolute path downstream, so a duplicate would overwrite rather
    // than collide, and one row would silently take the other's name.
    const found = new Map<string, SwitchLibraryFile>();
    for (const root of roots) {
      const resolvedRoot = await resolveOrNull(root);
      if (resolvedRoot === null) continue;
      await this.collect(resolvedRoot, resolvedRoot, 1, found);
    }
    return [...found.values()];
  }

  private async collect(
    directory: string,
    root: string,
    depth: number,
    into: Map<string, SwitchLibraryFile>
  ): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH) {
          await this.collect(full, root, depth + 1, into);
        }
        continue;
      }

      if (!isInstallableFileName(entry.name)) continue;
      if (isExcludedFileName(entry.name)) continue;

      const resolved = await resolveOrNull(full);
      if (resolved === null || !isInside(resolved, root)) continue;

      let stats;
      try {
        stats = await stat(resolved);
      } catch {
        continue;
      }
      if (!stats.isFile()) continue;
      if (into.has(resolved)) continue;

      into.set(resolved, {
        absolutePath: resolved,
        fileName: entry.name,
        // Taken from the logical path, not the resolved one: the
        // `gamarr-{attemptId}` directory is where the file is linked from,
        // which is what identifies the attempt.
        parentDirName: path.basename(directory),
        sizeBytes: stats.size,
        sourceRoot: root
      });
    }
  }
}

async function resolveOrNull(target: string): Promise<string | null> {
  try {
    return await realpath(target);
  } catch {
    return null;
  }
}

/**
 * `path.relative` rather than a `startsWith` prefix test, which would accept
 * `/library-other` as being inside `/library`.
 */
function isInside(candidate: string, root: string): boolean {
  if (candidate === root) return false;
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}
