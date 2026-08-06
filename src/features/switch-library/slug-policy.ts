/**
 * Pure naming rules for the DBI library index. No I/O — handlers and the
 * service may import this directly, the same way release-search imports
 * `newznab/url-policy`.
 */

const INSTALLABLE_EXTENSIONS = [".nsp", ".nsz", ".xci", ".xcz"] as const;

/**
 * Permissive but bounded. `sab_marker` is `gamarr-{attemptId}` and attempt ids
 * are generated uuids today, but the column is plain text, so this matches the
 * shape rather than asserting a uuid.
 */
const markerPattern = /^gamarr-[A-Za-z0-9._-]{1,64}$/;

export interface NamedCandidate {
  absolutePath: string;
  preferredName: string;
}

export function isInstallableFileName(name: string): boolean {
  const lower = name.toLowerCase();
  return INSTALLABLE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

export function isExcludedFileName(name: string): boolean {
  if (name.startsWith(".")) return true;
  return name.toLowerCase().endsWith(".part");
}

export function markerFromDirName(dirName: string): string | null {
  return markerPattern.test(dirName) ? dirName : null;
}

export function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot <= 0 ? "" : fileName.slice(dot);
}

/**
 * Maps absolute path -> unique display name. Entries sharing a name are
 * ordered by absolute path and numbered from the second onward, because
 * `readdir` order is not stable and a file's number must not move between
 * scans.
 */
export function resolveDisplayNames(
  candidates: NamedCandidate[]
): Map<string, string> {
  const groups = new Map<string, NamedCandidate[]>();
  for (const candidate of candidates) {
    const key = candidate.preferredName.toLowerCase();
    const group = groups.get(key) ?? [];
    group.push(candidate);
    groups.set(key, group);
  }

  const names = new Map<string, string>();
  for (const group of groups.values()) {
    const ordered = [...group].sort((a, b) =>
      a.absolutePath < b.absolutePath ? -1 : a.absolutePath > b.absolutePath ? 1 : 0
    );
    ordered.forEach((candidate, index) => {
      names.set(
        candidate.absolutePath,
        index === 0
          ? candidate.preferredName
          : suffixed(candidate.preferredName, index + 1)
      );
    });
  }
  return names;
}

function suffixed(name: string, ordinal: number): string {
  const extension = extensionOf(name);
  const stem = extension === "" ? name : name.slice(0, -extension.length);
  return `${stem} (${ordinal})${extension}`;
}
