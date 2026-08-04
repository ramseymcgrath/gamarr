import { randomUUID } from "node:crypto";

import type { CatalogRepository } from "@/features/catalog/ports";
import {
  selectCandidateFiles,
  selectItemTorrent,
  type SelectableFile
} from "@/features/release-search/file-selection";
import {
  deduplicateReleases,
  rankRelease
} from "@/features/release-search/matcher";
import {
  INTERNET_ARCHIVE_INDEXER_ID,
  INTERNET_ARCHIVE_INDEXER_NAME,
  type ItemTorrent,
  type RankedRelease,
  type Release,
  type ReleaseSourceType
} from "@/features/release-search/models";
import { planPrimaryQuery } from "@/features/release-search/query-planner";
import type {
  CandidateRepository,
  InternetArchiveSearchPort,
  ListReleaseIndexersPort,
  NewznabClientFactory,
  TorrentClientConfiguredPort
} from "@/features/release-search/ports";
import { AppError, validationError } from "@/lib/errors";
import {
  DownloadUrlPolicyError,
  validateDownloadUrl,
  type DownloadUrlRejectionReason
} from "@/integrations/newznab/url-policy";

const rejectionLabels: Array<[DownloadUrlRejectionReason, string]> = [
  ["malformed", "malformed"],
  ["unsupportedProtocol", "non-HTTP(S) scheme"],
  ["credentialsOrFragment", "credentials or fragment"],
  ["differentOrigin", "different origin"]
];

/**
 * Built only from counts and fixed labels — never from the rejected URL or the
 * caught message — so an indexer API key cannot reach a user-facing warning.
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

interface ReleaseSearchDependencies {
  catalog: CatalogRepository;
  listIndexers: ListReleaseIndexersPort;
  candidates: CandidateRepository;
  clientFactory: NewznabClientFactory;
  internetArchive?: InternetArchiveSearchPort;
  torrentClientConfigured: TorrentClientConfiguredPort;
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
  source: ReleaseSourceType;
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
}

export interface CandidateFilesResponse {
  files: SelectableFile[];
  /** Null when the item has not been derived and has no torrent. */
  torrent: ItemTorrent | null;
  /** Reported separately so an available torrent is not hidden when disabled. */
  torrentClientConfigured: boolean;
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

    const conflictingAliases = this.dependencies.catalog.listPlatforms()
      .filter((candidate) => candidate.id !== platform.id)
      .flatMap((candidate) => candidate.aliases);
    const indexers = this.dependencies.listIndexers()
      .filter((indexer) => indexer.enabled && indexer.deletedAt === null);
    const ranked: RankedRelease[] = [];
    const warnings: ReleaseSearchResponse["warnings"] = [];
    const controller = new AbortController();
    const overallTimeoutMs = this.dependencies.overallTimeoutMs ??
      Math.min(60_000, Math.max(20_000, 5_000 + indexers.length * 2_500));
    const timeout = setTimeout(
      () => controller.abort(new Error("Release search timed out")),
      overallTimeoutMs
    );
    try {
      const indexerFanOut = this.forEachConcurrent(
        indexers,
        this.dependencies.concurrency ?? 4,
        async (indexer) => {
          const categories = [...new Set([
            ...(platform.categoryIds ?? []),
            ...indexer.categoryIds
          ])];
          const queries = [planPrimaryQuery({
            title: game.name,
            releaseYear: game.releaseYear,
            titleIsAmbiguous: false,
            categoryIds: categories
          })];
          try {
            const client = this.dependencies.clientFactory(indexer);
            for (const query of queries) {
              const result = await client.search(query, controller.signal);
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
                categoryIds: categories
              })));
            }
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
      await Promise.all([
        indexerFanOut,
        this.searchInternetArchive(game.name, game.alternativeNames, {
          releaseYear: game.releaseYear,
          selectedAliases: platform.aliases,
          conflictingAliases,
          signal: controller.signal,
          ranked,
          warnings
        })
      ]);
    } finally {
      clearTimeout(timeout);
    }

    const timestamp = this.now();
    // Reasons are counted per indexer so one unusable enclosure costs only that
    // release, not every result from every indexer.
    const rejectedSources = new Map<
      string,
      Map<DownloadUrlRejectionReason, number>
    >();
    const releases = deduplicateReleases(ranked).flatMap((release) => {
      const sources = release.sources.flatMap((source): PublicReleaseSource[] => {
        if (source.source === "internet-archive") {
          // IA items need no download-URL policy: the candidate carries only
          // the validated item identifier, and the download URL is rebuilt
          // server-side from operator configuration at submission time.
          const candidateId = this.id();
          this.dependencies.candidates.save({
            id: candidateId,
            expiresAt: timestamp + 30 * 60 * 1000,
            source: "internet-archive",
            indexerId: null,
            indexerConfigRevision: 0,
            guid: source.guid,
            title: source.title,
            size: source.size,
            downloadPath: `/details/${source.guid}`,
            category: null,
            sourceSnapshot: JSON.stringify({
              indexerName: INTERNET_ARCHIVE_INDEXER_NAME,
              identifier: source.guid,
              origin: new URL(source.downloadUrl).origin
            }),
            createdAt: timestamp
          });
          return [{
            candidateId,
            indexerName: INTERNET_ARCHIVE_INDEXER_NAME,
            source: "internet-archive" as const
          }];
        }
        const indexer = indexers.find((candidate) => candidate.id === source.indexerId);
        if (!indexer) {
          throw validationError("Indexer changed during release search");
        }
        let safe;
        try {
          safe = validateDownloadUrl(indexer.baseUrl, source.downloadUrl);
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
          source: "newznab",
          indexerId: indexer.id,
          indexerConfigRevision: indexer.configRevision,
          guid: source.guid,
          title: source.title,
          size: source.size,
          downloadPath: safe.downloadPath,
          category: source.category,
          sourceSnapshot: JSON.stringify({
            indexerName: indexer.name,
            origin: safe.origin
          }),
          createdAt: timestamp
        });
        return [{
          candidateId,
          indexerName: indexer.name,
          source: "newznab" as const
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
      const indexer = indexers.find((candidate) => candidate.id === indexerId);
      warnings.push({
        indexerId,
        indexerName: indexer?.name ?? indexerId,
        message: unsafeDownloadUrlWarning(byReason)
      });
    }
    return { releases, warnings };
  }

  /**
   * Lists the files of the Internet Archive item behind a live candidate, so
   * the user can pick which one to download. Read-only: the opaque candidate
   * ID means a caller cannot aim this at anything the server did not already
   * mint during a search.
   */
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
    if (candidate.source !== "internet-archive") {
      throw validationError("Candidate is not an Internet Archive item");
    }
    const internetArchive = this.dependencies.internetArchive;
    if (!internetArchive) {
      // Unreachable in a normal composition root — an IA candidate can only
      // exist if a search ran with the port wired in — but a misconfigured
      // deployment must fail loudly rather than report an empty item.
      throw new AppError(
        "UNAVAILABLE",
        503,
        "Internet Archive source is not configured"
      );
    }
    // The item is addressed by the candidate's guid: the candidate ID is a
    // server-minted handle and means nothing upstream.
    const files = await internetArchive.listFiles(candidate.guid);
    return {
      files: selectCandidateFiles(files),
      torrent: selectItemTorrent(files),
      torrentClientConfigured: this.dependencies.torrentClientConfigured()
    };
  }

  /**
   * Queries the Internet Archive as one more bounded source inside the same
   * overall deadline. Items become ordinary ranked releases with no category
   * evidence; a failure here only produces a warning, like any indexer.
   */
  private async searchInternetArchive(
    title: string,
    alternativeNames: string[],
    context: {
      releaseYear: number | null;
      selectedAliases: string[];
      conflictingAliases: string[];
      signal: AbortSignal;
      ranked: RankedRelease[];
      warnings: ReleaseSearchResponse["warnings"];
    }
  ): Promise<void> {
    const internetArchive = this.dependencies.internetArchive;
    if (!internetArchive) return;
    try {
      const result = await internetArchive.search(
        { title },
        context.signal
      );
      context.warnings.push(...result.warnings.map((message) => ({
        indexerId: INTERNET_ARCHIVE_INDEXER_ID,
        indexerName: INTERNET_ARCHIVE_INDEXER_NAME,
        message
      })));
      for (const item of result.items) {
        const release: Release = {
          guid: item.identifier,
          title: item.title,
          source: "internet-archive",
          indexerId: INTERNET_ARCHIVE_INDEXER_ID,
          indexerName: INTERNET_ARCHIVE_INDEXER_NAME,
          downloadUrl: item.detailsUrl,
          size: item.size,
          category: null,
          publishedAt: item.publishedAt
        };
        context.ranked.push(rankRelease({
          release,
          canonicalTitle: title,
          alternativeNames,
          selectedAliases: context.selectedAliases,
          conflictingAliases: context.conflictingAliases,
          releaseYear: context.releaseYear,
          categoryIds: []
        }));
      }
    } catch {
      context.warnings.push({
        indexerId: INTERNET_ARCHIVE_INDEXER_ID,
        indexerName: INTERNET_ARCHIVE_INDEXER_NAME,
        message: context.signal.aborted
          ? "Internet Archive search timed out"
          : "Internet Archive search failed"
      });
    }
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
