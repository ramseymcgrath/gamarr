import type {
  RankedRelease,
  Release
} from "@/features/release-search/models";
import type { DiscSerials } from "@/features/release-search/ports";
import {
  displaySerial,
  extractSerials,
  normalizeSerial
} from "@/lib/disc-serial";

export interface RankInput {
  release: Release;
  canonicalTitle: string;
  alternativeNames: string[];
  selectedAliases: string[];
  conflictingAliases: string[];
  releaseYear: number | null;
  categoryIds: string[];
  /**
   * Names a source whose results are preferred over indexer releases (Internet
   * Archive: verified dumps, no grab limits). Only boosts a release whose title
   * already matched, so it reorders good results without promoting junk.
   */
  preferredSource?: string;
  /** The game's Redump serials; a serial in a release title is decisive. */
  serials?: DiscSerials | null;
}

/**
 * Sized so a title-only preferred match (50 + 50 = 100) outranks the best an
 * indexer release can score (title 50 + platform 30 + category 10 + year 5 =
 * 95). A preferred release labelled for another platform (50 - 80 + 50 = 20)
 * still sinks below any clean title match.
 */
export const PREFERRED_SOURCE_BONUS = 50;

/**
 * A serial names one disc exactly, so it outweighs the platform (30) and year
 * (5) on top of a title match, and alone still lands a release among the
 * title matches.
 */
export const SERIAL_BONUS = 60;

export function normalizeReleaseTitle(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function containsPhrase(haystack: string, needle: string): boolean {
  const normalized = normalizeReleaseTitle(needle);
  if (!normalized) return false;
  return ` ${haystack} `.includes(` ${normalized} `);
}

export function rankRelease(input: RankInput): RankedRelease {
  const normalizedTitle = normalizeReleaseTitle(input.release.title);
  const supportingReasons: string[] = [];
  const conflictingReasons: string[] = [];
  let score = 0;

  const matchedTitle = [input.canonicalTitle, ...input.alternativeNames]
    .find((title) => containsPhrase(normalizedTitle, title));
  if (matchedTitle) {
    supportingReasons.push(`Title matches ${matchedTitle}`);
    score += 50;
  }

  const matchedAlias = input.selectedAliases
    .find((alias) => containsPhrase(normalizedTitle, alias));
  if (matchedAlias) {
    supportingReasons.push(`Platform matches ${matchedAlias.toLowerCase()}`);
    score += 30;
  }

  const selectedInTitle = input.selectedAliases
    .filter((alias) => containsPhrase(normalizedTitle, alias));
  const gameTitles = [input.canonicalTitle, ...input.alternativeNames];
  // Longest first, so "Xbox 360" is reported as xbox 360, not xbox.
  const conflict = [...input.conflictingAliases]
    .sort((left, right) => right.length - left.length)
    .find((alias) =>
    containsPhrase(normalizedTitle, alias)
    // "wii" inside a matched "wii u", "xbox" inside "xbox 360": the release
    // names the selected platform, not another one.
    && !selectedInTitle.some((selected) => containsPhrase(normalizeReleaseTitle(selected), alias))
    // A word of the game's own name ("Bait and Switch") isn't a platform.
    && !gameTitles.some((title) => containsPhrase(normalizeReleaseTitle(title), alias)));
  if (conflict) {
    conflictingReasons.push(`Conflicting platform: ${conflict.toLowerCase()}`);
    score -= 80;
  }

  // Only serials the Redump list knows count: a serial-shaped token that
  // isn't one ("ABCD-12345") is ignored rather than held against a release.
  const titleSerials = input.serials ? extractSerials(input.release.title) : [];
  const ownSerials = new Set((input.serials?.serials ?? []).map(normalizeSerial));
  const matchedSerial = titleSerials.find((serial) => ownSerials.has(serial));
  let serialConflict = false;
  if (matchedSerial) {
    supportingReasons.push(`Serial ${displaySerial(matchedSerial)} matches`);
    score += SERIAL_BONUS;
  } else {
    const foreign = titleSerials
      .map((serial) => ({ serial, game: input.serials?.gameFor(serial) ?? null }))
      .find((entry) => entry.game !== null);
    if (foreign) {
      conflictingReasons.push(
        `Serial ${displaySerial(foreign.serial)} is ${foreign.game}`
      );
      score -= 80;
      serialConflict = true;
    }
  }

  if (
    input.release.category &&
    input.categoryIds.includes(input.release.category)
  ) {
    supportingReasons.push(`Category ${input.release.category} matches`);
    score += 10;
  }

  if (
    input.releaseYear &&
    containsPhrase(normalizedTitle, String(input.releaseYear))
  ) {
    supportingReasons.push(`Release year matches ${input.releaseYear}`);
    score += 5;
  }

  if (input.preferredSource && (matchedTitle || matchedSerial)) {
    supportingReasons.push(`Preferred source: ${input.preferredSource}`);
    score += PREFERRED_SOURCE_BONUS;
  }

  const match = conflict || serialConflict
    ? "Conflicting"
    : (matchedTitle && matchedAlias) || matchedSerial
      ? "Strong"
      : "Possible";

  return {
    ...input.release,
    match,
    score,
    supportingReasons,
    conflictingReasons,
    sources: [input.release]
  };
}

export function deduplicateReleases(
  releases: RankedRelease[],
  priorityOf: (indexerId: string) => number
): RankedRelease[] {
  const grouped = new Map<string, RankedRelease>();
  for (const release of releases) {
    const key = `${normalizeReleaseTitle(release.title)}:${release.size ?? "unknown"}`;
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, { ...release, sources: [...release.sources] });
      continue;
    }
    for (const source of release.sources) {
      if (!existing.sources.some((candidate) =>
        candidate.indexerId === source.indexerId &&
        candidate.guid === source.guid
      )) {
        existing.sources.push(source);
      }
    }
    if (release.score > existing.score) {
      existing.score = release.score;
      existing.match = release.match;
      existing.supportingReasons = release.supportingReasons;
      existing.conflictingReasons = release.conflictingReasons;
    }
  }
  const output = [...grouped.values()];
  for (const release of output) {
    release.sources.sort((left, right) =>
      (right.seeders ?? Number.MIN_SAFE_INTEGER) -
        (left.seeders ?? Number.MIN_SAFE_INTEGER) ||
      priorityOf(left.indexerId) - priorityOf(right.indexerId) ||
      (right.publishedAt ?? Number.MIN_SAFE_INTEGER) -
        (left.publishedAt ?? Number.MIN_SAFE_INTEGER)
    );
  }
  // MIN_SAFE_INTEGER, not -Infinity: `-Infinity - -Infinity` is NaN, which
  // makes the comparator non-transitive when two undated releases meet.
  // Unknowns still sink.
  return output.sort((left, right) =>
    right.score - left.score ||
    (right.publishedAt ?? Number.MIN_SAFE_INTEGER) -
      (left.publishedAt ?? Number.MIN_SAFE_INTEGER) ||
    (left.size ?? Number.MAX_SAFE_INTEGER) - (right.size ?? Number.MAX_SAFE_INTEGER) ||
    normalizeReleaseTitle(left.title).localeCompare(normalizeReleaseTitle(right.title)) ||
    left.indexerId.localeCompare(right.indexerId)
  );
}
