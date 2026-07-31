import { randomUUID } from "node:crypto";

import type { CatalogRepository } from "@/features/catalog/ports";
import type { SettingsRepository } from "@/features/settings/service";
import {
  deduplicateReleases,
  rankRelease
} from "@/features/release-search/matcher";
import type { RankedRelease } from "@/features/release-search/models";
import { planPrimaryQuery } from "@/features/release-search/query-planner";
import type {
  CandidateRepository,
  NewznabClientFactory
} from "@/features/release-search/ports";
import { validationError } from "@/lib/errors";
import { validateDownloadUrl } from "@/integrations/newznab/url-policy";

interface ReleaseSearchDependencies {
  catalog: CatalogRepository;
  settings: SettingsRepository;
  candidates: CandidateRepository;
  clientFactory: NewznabClientFactory;
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
}

export interface PublicRelease {
  title: string;
  size: number | null;
  category: string | null;
  publishedAt: number;
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
    const indexers = this.dependencies.settings.listIndexers()
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
      await this.forEachConcurrent(
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
    } finally {
      clearTimeout(timeout);
    }

    const timestamp = this.now();
    const releases = deduplicateReleases(ranked).map((release) => {
      const sources = release.sources.map((source) => {
        const indexer = indexers.find((candidate) => candidate.id === source.indexerId);
        if (!indexer) {
          throw validationError("Indexer changed during release search");
        }
        const safe = validateDownloadUrl(indexer.baseUrl, source.downloadUrl);
        const candidateId = this.id();
        this.dependencies.candidates.save({
          id: candidateId,
          expiresAt: timestamp + 30 * 60 * 1000,
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
        return { candidateId, indexerName: indexer.name };
      });
      return {
        title: release.title,
        size: release.size,
        category: release.category,
        publishedAt: release.publishedAt,
        match: release.match,
        score: release.score,
        supportingReasons: release.supportingReasons,
        conflictingReasons: release.conflictingReasons,
        sources
      };
    });
    return { releases, warnings };
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
