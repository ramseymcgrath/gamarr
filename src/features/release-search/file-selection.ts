/**
 * Pure selection policy for the files of an Internet Archive item: it turns an
 * item's raw upstream manifest into the list a user may choose a download
 * from. No I/O — feature modules and the service may call it freely, and it is
 * the single owner of "what counts as a selectable release payload" so a
 * second consumer never has to re-derive the rule.
 *
 * File names pass through verbatim. A name is simultaneously a URL path
 * segment and an on-disk name, so " Game.zip" is a different file from
 * "Game.zip" — nothing here trims or normalises.
 */

import type { InternetArchiveFile } from "@/features/release-search/models";
import { isSafeInternetArchiveFileName } from "@/integrations/internet-archive/path-policy";

/**
 * Bounds a pathological manifest to a list a person can actually scan. Applied
 * after the sort, so it keeps the largest files rather than an arbitrary
 * prefix of the upstream ordering.
 */
export const MAX_SELECTABLE_FILES = 100;

/**
 * The public shape of one selectable file. The upstream `source` field is
 * deliberately absent: it is internal Internet Archive bookkeeping that drives
 * the filter below and must not reach the client.
 */
export interface SelectableFile {
  name: string;
  size: number | null;
  format: string | null;
}

export function selectCandidateFiles(
  files: InternetArchiveFile[]
): SelectableFile[] {
  // Original uploads are the item's actual payload; derivatives and IA
  // bookkeeping files only surface when an item has no originals at all.
  const originals = files.filter((file) => file.source === "original");
  const pool = originals.length > 0
    ? originals
    : files.filter((file) => file.source !== "metadata");
  return pool
    .filter((file) => isSafeInternetArchiveFileName(file.name))
    // An unknown size sorts last rather than first.
    .sort((left, right) => (right.size ?? 0) - (left.size ?? 0))
    .slice(0, MAX_SELECTABLE_FILES)
    .map(({ name, size, format }) => ({ name, size, format }));
}
