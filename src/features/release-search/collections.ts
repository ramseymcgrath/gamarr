import { titleKey } from "@/features/verification/redump";
import type {
  Collection,
  CollectionFile
} from "@/features/release-search/ports";

export const COLLECTION_FILE_LIMIT = 25;

/** A file's name without its last extension, so `(Disc 1).7z` keys cleanly. */
export function collectionFileTitle(fileName: string): string {
  const base = fileName.split("/").pop() ?? fileName;
  return base.replace(/\.[^.]+$/, "");
}

/**
 * The files whose name, once folded by `titleKey` (case, accents, `&`/`and`,
 * trailing ", The", region tags), equals the key of the game's title, an
 * alternative name or a Redump name. Equality, not containment: a sequel's
 * longer name never matches. File-index order, capped.
 */
export function matchCollectionFiles(
  collection: Collection,
  titles: string[],
  redumpNames: string[],
  limit = COLLECTION_FILE_LIMIT
): CollectionFile[] {
  const wanted = new Set(
    [...titles, ...redumpNames].map(titleKey).filter((key) => key !== "")
  );
  if (wanted.size === 0) return [];
  return collection.files
    .filter((file) => wanted.has(titleKey(collectionFileTitle(file.name))))
    .sort((a, b) => a.index - b.index)
    .slice(0, limit);
}
