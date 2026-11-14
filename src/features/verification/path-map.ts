import { posix } from "node:path";

/**
 * Download clients report paths inside *their* containers (qBittorrent:
 * `/downloads/<name>`, SABnzbd: `/downloads/games/<name>`); gamarr sees the
 * same files under its own mount. `GAMARR_DOWNLOAD_PATH_MAP` lists
 * `client=gamarr` prefix pairs, comma-separated; the longest matching client
 * prefix wins, and only whole path segments match.
 */
export interface PathMapping {
  from: string;
  to: string;
}

function clean(path: string): string {
  const normalized = posix.normalize(path.trim());
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

export function parsePathMap(value: string | undefined): PathMapping[] {
  if (!value) return [];
  return value
    .split(",")
    .map((pair) => pair.split("="))
    .filter((parts): parts is [string, string] =>
      parts.length === 2
      && parts[0]!.trim().startsWith("/")
      && parts[1]!.trim().startsWith("/"))
    .map(([from, to]) => ({ from: clean(from), to: clean(to) }))
    .sort((a, b) => b.from.length - a.from.length);
}

/**
 * `null` when no mapping covers the path or the mapped path would leave its
 * target root (e.g. via `..`): such a download is reported as unreachable,
 * never read.
 */
export function mapClientPath(
  clientPath: string,
  mappings: PathMapping[]
): string | null {
  if (!clientPath.startsWith("/")) return null;
  const path = clean(clientPath);
  for (const mapping of mappings) {
    const within = path === mapping.from
      || path.startsWith(`${mapping.from === "/" ? "" : mapping.from}/`);
    if (!within) continue;
    const mapped = clean(posix.join(mapping.to, path.slice(mapping.from.length)));
    if (mapped !== mapping.to && !mapped.startsWith(`${mapping.to}/`)) {
      return null;
    }
    return mapped;
  }
  return null;
}
