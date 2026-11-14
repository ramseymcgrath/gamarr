/**
 * Pure validation for Internet Archive identifiers and file names. No I/O —
 * feature modules may import this the same way release-search imports
 * `newznab/url-policy`.
 *
 * An identifier becomes a URL path segment and a filesystem directory, and a
 * file name becomes a URL path segment and a file on disk. Both come from
 * upstream metadata, so they are validated before either use. The file name
 * length limit is measured in UTF-8 *bytes*, not characters — see
 * MAX_FILE_NAME_BYTES.
 */

import { Buffer } from "node:buffer";

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

/**
 * ext4 caps a single dirent at 255 BYTES; APFS caps a path component at 255
 * characters. Measuring bytes satisfies both, because a name of at most 255
 * UTF-8 bytes can never exceed 255 characters.
 */
const MAX_FILE_NAME_BYTES = 255;

export function isValidInternetArchiveIdentifier(value: string): boolean {
  return identifierPattern.test(value);
}

export function isSafeInternetArchiveFileName(value: string): boolean {
  // Cheap O(1) upper bound before the O(n) byte count: every UTF-16 code unit
  // costs at least one UTF-8 byte, so anything longer than the byte budget is
  // already over it. Upstream metadata is untrusted, so this bounds the scan.
  if (value.length > MAX_FILE_NAME_BYTES) return false;
  if (Buffer.byteLength(value, "utf8") > MAX_FILE_NAME_BYTES) return false;
  // Degenerate names only. Leading and trailing whitespace is otherwise
  // significant: the name is matched verbatim against Internet Archive
  // metadata and becomes both a URL path segment and the on-disk name, so
  // " Game.zip" and "Game.zip" are different files. Nothing else trims.
  const bare = value.trim();
  if (bare.length === 0 || bare === "." || bare === "..") return false;
  // Path separators and control characters are the only way a metadata file
  // name could escape the per-item download directory.
  return !/[\\/\x00-\x1f]/.test(value);
}
