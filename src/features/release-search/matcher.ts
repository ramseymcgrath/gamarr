import type {
  RankedRelease,
  Release
} from "@/features/release-search/models";

export interface RankInput {
  release: Release;
  canonicalTitle: string;
  alternativeNames: string[];
  selectedAliases: string[];
  conflictingAliases: string[];
  releaseYear: number | null;
  categoryIds: string[];
}

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

  const conflict = input.conflictingAliases
    .find((alias) => containsPhrase(normalizedTitle, alias));
  if (conflict) {
    conflictingReasons.push(`Conflicting platform: ${conflict.toLowerCase()}`);
    score -= 80;
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

  const match = conflict
    ? "Conflicting"
    : matchedTitle && matchedAlias
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
  releases: RankedRelease[]
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
  return [...grouped.values()].sort((left, right) =>
    right.score - left.score ||
    right.publishedAt - left.publishedAt ||
    (left.size ?? Number.MAX_SAFE_INTEGER) - (right.size ?? Number.MAX_SAFE_INTEGER) ||
    normalizeReleaseTitle(left.title).localeCompare(normalizeReleaseTitle(right.title)) ||
    left.indexerId.localeCompare(right.indexerId)
  );
}
