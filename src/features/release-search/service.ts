import { randomUUID } from "node:crypto";

import type { CatalogRepository } from "@/features/catalog/ports";
import {
  deduplicateReleases,
  rankRelease
} from "@/features/release-search/matcher";
import type {
  RankedRelease
} from "@/features/release-search/models";
import { planPrimaryQuery } from "@/features/release-search/query-planner";
import type {
  CandidateRepository,
  ProwlarrPort,
  ReleaseCandidateRecord
} from "@/features/release-search/ports";
// Pure validation/decoding modules are the deliberate no-I/O exception to the
// feature/integration boundary documented in CLAUDE.md.
import {
  decodeTorrentFiles,
  type TorrentFile
} from "@/integrations/prowlarr/metainfo";
import {
  DownloadUrlPolicyError,
  validateDownloadUrl,
  type DownloadUrlRejectionReason
} from "@/integrations/prowlarr/url-policy";
import { AppError, validationError } from "@/lib/errors";

const rejectionLabels: Array<[DownloadUrlRejectionReason, string]> = [
  ["malformed", "malformed"],
  ["unsupportedProtocol", "non-HTTP(S) scheme"],
  ["credentialsOrFragment", "credentials or fragment"],
  ["differentOrigin", "different origin"]
];

/**
 * Built only from counts and fixed labels — never from the rejected URL or the
 * caught message — so a Prowlarr API key cannot reach a user-facing warning.
 */
function unsafeDownloadUrlWarning(
  byReason: Map<DownloadUrlRejectionReason, number>
): string {
  const total = [...byReason.values()].reduce((sum, count) => sum + count, 0);
  const detail = rejectionLabels
    .filter(([reason]) => (byReason.get(reason) ?? 0) > 0)
    .map(([reason, label]) => `${byReason.get(reason)} ${label}`)
    .join("; ");
  return total === 1
    ? `Ignored 1 release result: unsafe download URL (${detail}).`
    : `Ignored ${total} release results: unsafe download URLs (${detail}).`;
}

type FetchedRelease =
  | { kind: "nzb"; bytes: Uint8Array }
  | { kind: "torrent"; bytes: Uint8Array }
  | { kind: "magnet"; uri: string };

interface ReleaseFetcherPort {
  fetch(input: {
    candidate: ReleaseCandidateRecord;
    magnetUrl: string | null;
    maxBytes: number;
  }): Promise<FetchedRelease>;
}

interface ReleaseSearchDependencies {
  catalog: CatalogRepository;
  candidates: CandidateRepository;
  prowlarr: ProwlarrPort | null;
  /** Effective base URL, including any test-only origin override. */
  prowlarrBaseUrl: string;
  prowlarrConfigRevision: number;
  fetcher: ReleaseFetcherPort;
  maxTorrentBytes: number;
  usenetClientConfigured: () => boolean;
  torrentClientConfigured: () => boolean;
  now?: () => number;
  id?: () => string;
  overallTimeoutMs?: number;
  concurrency?: number;
}

export interface ReleaseSearchInput {
  gameId: number;
  platformId: number;
}

export interface PublicReleaseSource {
  candidateId: string;
  indexerName: string;
  protocol: "usenet" | "torrent";
  seeders: number | null;
}

export interface PublicRelease {
  title: string;
  size: number | null;
  category: string | null;
  publishedAt: number | null;
  match: "Strong" | "Possible" | "Conflicting";
  score: number;
  supportingReasons: string[];
  conflictingReasons: string[];
  sources: PublicReleaseSource[];
}

export interface ReleaseSearchResponse {
  releases: PublicRelease[];
  warnings: Array<{
    indexerId: string;
    indexerName: string;
    message: string;
  }>;
  usenetClientConfigured: boolean;
  torrentClientConfigured: boolean;
}

export interface CandidateFilesResponse {
  files: TorrentFile[];
  metadataPending: boolean;
}

/**
 * Newznab groups categories in thousand-blocks: an indexer advertising 1010 or
 * 1020 can serve a request for the 1000 block. Sending a category an indexer
 * does not support yields an empty result set rather than an error, so the
 * query carries only categories the indexer actually claims.
 */
export function intersectCategories(
  platformCategoryIds: string[],
  indexerCategoryIds: string[]
): string[] {
  const advertised = new Set(indexerCategoryIds);
  const blocks = new Set(
    indexerCategoryIds.map((id) => String(Math.floor(Number(id) / 1000) * 1000))
  );
  return platformCategoryIds.filter((id) => {
    if (advertised.has(id)) return true;
    const numeric = Number(id);
    if (!Number.isFinite(numeric)) return false;
    const block = String(Math.floor(numeric / 1000) * 1000);
    // A block root is satisfied by any member of its block; a member is
    // satisfied by the indexer advertising the block root itself.
    return (numeric % 1000 === 0 && blocks.has(id)) || advertised.has(block);
  });
}

function snapshotMagnetUrl(sourceSnapshot: string): string | null {
  try {
    const parsed: unknown = JSON.parse(sourceSnapshot);
    if (
      typeof parsed === "object"
      && parsed !== null
      && "magnetUrl" in parsed
      && typeof parsed.magnetUrl === "string"
    ) {
      return parsed.magnetUrl;
    }
  } catch {
    // Candidates minted before magnet snapshots existed still use the proxy.
  }
  return null;
}

export class ReleaseSearchService {
  private readonly now: () => number;
  private readonly id: () => string;

  constructor(private readonly dependencies: ReleaseSearchDependencies) {
    this.now = dependencies.now ?? Date.now;
    this.id = dependencies.id ?? randomUUID;
  }

  async search(input: ReleaseSearchInput): Promise<ReleaseSearchResponse> {
    const game = this.dependencies.catalog.getGame(input.gameId);
    const platform = this.dependencies.catalog.getPlatform(input.platformId);
    if (!game || !game.platformIds.includes(input.platformId)) {
      throw validationError("Game is not available for the selected platform");
    }
    if (!platform?.visible) {
      throw validationError("Selected platform is not visible");
    }
    const prowlarr = this.dependencies.prowlarr;
    if (prowlarr === null) {
      throw new AppError("UNAVAILABLE", 503, "Prowlarr is not configured");
    }

    const conflictingAliases = this.dependencies.catalog.listPlatforms()
      .filter((candidate) => candidate.id !== platform.id)
      .flatMap((candidate) => candidate.aliases);
    const ranked: RankedRelease[] = [];
    const warnings: ReleaseSearchResponse["warnings"] = [];
    const controller = new AbortController();
    const startedAt = Date.now();
    let timeout = setTimeout(
      () => controller.abort(new Error("Release search timed out")),
      this.dependencies.overallTimeoutMs ?? 60_000
    );

    let indexers;
    try {
      try {
        indexers = await prowlarr.listIndexers(controller.signal);
      } catch {
        throw new AppError("UNAVAILABLE", 502, "Prowlarr is unavailable");
      }

      const overallTimeoutMs = this.dependencies.overallTimeoutMs
        ?? Math.min(60_000, Math.max(20_000, 5_000 + indexers.length * 2_500));
      clearTimeout(timeout);
      timeout = setTimeout(
        () => controller.abort(new Error("Release search timed out")),
        Math.max(0, overallTimeoutMs - (Date.now() - startedAt))
      );

      await this.forEachConcurrent(
        indexers,
        this.dependencies.concurrency ?? 4,
        async (indexer) => {
          const categories = intersectCategories(
            platform.categoryIds ?? [],
            indexer.categoryIds
          );
          const query = planPrimaryQuery({
            title: game.name,
            releaseYear: game.releaseYear,
            titleIsAmbiguous: false,
            categoryIds: categories
          });
          try {
            const result = await prowlarr.search(indexer, query, controller.signal);
            warnings.push(...result.warnings.map((message) => ({
              indexerId: indexer.id,
              indexerName: indexer.name,
              message
            })));
            ranked.push(...result.releases.map((release) => rankRelease({
              release,
              canonicalTitle: game.name,
              alternativeNames: game.alternativeNames,
              selectedAliases: platform.aliases,
              conflictingAliases,
              releaseYear: game.releaseYear,
              categoryIds: platform.categoryIds ?? []
            })));
          } catch {
            warnings.push({
              indexerId: indexer.id,
              indexerName: indexer.name,
              message: controller.signal.aborted
                ? "Indexer search timed out"
                : "Indexer search failed"
            });
          }
        }
      );
    } finally {
      clearTimeout(timeout);
    }

    const indexerById = new Map(indexers.map((indexer) => [indexer.id, indexer]));
    const timestamp = this.now();
    // Reasons are counted per indexer so one unusable enclosure costs only that
    // release, not every result from every indexer.
    const rejectedSources = new Map<
      string,
      Map<DownloadUrlRejectionReason, number>
    >();
    const releases = deduplicateReleases(
      ranked,
      (indexerId) => indexerById.get(indexerId)?.priority ?? Number.MAX_SAFE_INTEGER
    ).flatMap((release) => {
      const sources = release.sources.flatMap((source): PublicReleaseSource[] => {
        const indexer = indexerById.get(source.indexerId);
        if (!indexer) {
          throw validationError("Indexer changed during release search");
        }
        let safe;
        try {
          const directMagnet = source.protocol === "torrent"
            && source.magnetUrl !== null
            && source.downloadUrl === source.magnetUrl;
          // Torznab may use the magnet itself as the enclosure. The fetcher
          // short-circuits on the snapshot magnet, so retain a sanitized,
          // unused Prowlarr path rather than persisting the untrusted URI.
          safe = directMagnet
            ? validateDownloadUrl(
                this.dependencies.prowlarrBaseUrl,
                this.dependencies.prowlarrBaseUrl
              )
            : validateDownloadUrl(
                this.dependencies.prowlarrBaseUrl,
                source.downloadUrl
              );
        } catch (error) {
          if (!(error instanceof DownloadUrlPolicyError)) throw error;
          const byReason = rejectedSources.get(indexer.id)
            ?? new Map<DownloadUrlRejectionReason, number>();
          byReason.set(error.reason, (byReason.get(error.reason) ?? 0) + 1);
          rejectedSources.set(indexer.id, byReason);
          return [];
        }

        const candidateId = this.id();
        this.dependencies.candidates.save({
          id: candidateId,
          expiresAt: timestamp + 30 * 60 * 1000,
          protocol: source.protocol,
          indexerId: indexer.id,
          indexerConfigRevision: this.dependencies.prowlarrConfigRevision,
          guid: source.guid,
          title: source.title,
          size: source.size,
          seeders: source.seeders,
          downloadPath: safe.downloadPath,
          category: source.category,
          sourceSnapshot: JSON.stringify(source.protocol === "torrent"
            ? {
                indexerName: indexer.name,
                origin: safe.origin,
                magnetUrl: source.magnetUrl
              }
            : { indexerName: indexer.name, origin: safe.origin }),
          createdAt: timestamp
        });
        return [{
          candidateId,
          indexerName: indexer.name,
          protocol: source.protocol,
          seeders: source.seeders
        }];
      });
      if (sources.length === 0) return [];
      return [{
        title: release.title,
        size: release.size,
        category: release.category,
        publishedAt: release.publishedAt,
        match: release.match,
        score: release.score,
        supportingReasons: release.supportingReasons,
        conflictingReasons: release.conflictingReasons,
        sources
      }];
    });
    for (const [indexerId, byReason] of rejectedSources) {
      const indexer = indexerById.get(indexerId);
      warnings.push({
        indexerId,
        indexerName: indexer?.name ?? indexerId,
        message: unsafeDownloadUrlWarning(byReason)
      });
    }
    return {
      releases,
      warnings,
      usenetClientConfigured: this.dependencies.usenetClientConfigured(),
      torrentClientConfigured: this.dependencies.torrentClientConfigured()
    };
  }

  async listCandidateFiles(
    candidateId: string
  ): Promise<CandidateFilesResponse> {
    const candidate = this.dependencies.candidates.get(candidateId);
    // Expiry and absence deliberately collapse into this single 404:
    // `SqliteCandidateRepository.get` filters on
    // `and(eq(id), gt(expiresAt, now()))` and returns null for both, so the
    // endpoint cannot be used as an existence oracle for candidate IDs.
    if (!candidate) {
      throw new AppError("NOT_FOUND", 404, "Release candidate has expired");
    }
    if (candidate.protocol !== "torrent") {
      throw validationError("Usenet candidates do not have selectable files");
    }

    const fetched = await this.dependencies.fetcher.fetch({
      candidate,
      magnetUrl: snapshotMagnetUrl(candidate.sourceSnapshot),
      maxBytes: this.dependencies.maxTorrentBytes
    });
    if (fetched.kind === "magnet") {
      return { files: [], metadataPending: true };
    }
    if (fetched.kind !== "torrent") {
      throw new AppError(
        "UNAVAILABLE",
        502,
        "Prowlarr returned an unexpected release payload"
      );
    }
    return {
      files: decodeTorrentFiles(fetched.bytes),
      metadataPending: false
    };
  }

  private async forEachConcurrent<T>(
    values: T[],
    concurrency: number,
    visit: (value: T) => Promise<void>
  ): Promise<void> {
    let next = 0;
    const workers = Array.from(
      { length: Math.min(Math.max(1, concurrency), values.length) },
      async () => {
        while (next < values.length) {
          const index = next;
          next += 1;
          await visit(values[index]!);
        }
      }
    );
    await Promise.all(workers);
  }
}
