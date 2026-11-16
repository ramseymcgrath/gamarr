import { randomUUID } from "node:crypto";

import type { CatalogRepository } from "@/features/catalog/ports";
import {
  deduplicateReleases,
  rankRelease
} from "@/features/release-search/matcher";
import {
  collectionFileTitle,
  matchCollectionFiles
} from "@/features/release-search/collections";
import {
  COLLECTION_INDEXER_PREFIX,
  collectionIndexerId,
  INTERNET_ARCHIVE_INDEXER_ID,
  INTERNET_ARCHIVE_INDEXER_NAME,
  type PlannedQuery,
  type RankedRelease,
  type Release
} from "@/features/release-search/models";
import { platformAliases } from "@/features/release-search/platform-aliases";
import { planPrimaryQuery } from "@/features/release-search/query-planner";
import type {
  CandidateRepository,
  Collection,
  CollectionFile,
  CollectionsPort,
  DiscSerials,
  InternetArchivePort,
  ProwlarrIndexerSummary,
  ProwlarrPort,
  ReleaseCandidateRecord,
  SerialCatalogPort
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

const COLLECTIONS_WARNING_ID = "collections";
const COLLECTIONS_WARNING_NAME = "Collections";

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
  /** Searched alongside the Prowlarr indexers; `null` when disabled. */
  internetArchive?: InternetArchivePort | null;
  /** Multi-file collection torrents in the config folder; `null` when off. */
  collections?: CollectionsPort | null;
  /** Disc serials from Redump, for platforms that have a list. */
  serialCatalog?: SerialCatalogPort | null;
  /** How long a search waits for the serial lookup before going without. */
  serialLookupTimeoutMs?: number;
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
  /** The serial indexers were also searched by, when the game has one. */
  searchedSerial: string | null;
}

export interface CandidateFilesResponse {
  files: TorrentFile[];
  metadataPending: boolean;
  /** Set for a collection candidate: the one file Gamarr will turn on. */
  collection?: { name: string };
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
      .flatMap(platformAliases);
    const ranked: RankedRelease[] = [];
    const warnings: ReleaseSearchResponse["warnings"] = [];
    const controller = new AbortController();
    const startedAt = Date.now();
    let timeout = setTimeout(
      () => controller.abort(new Error("Release search timed out")),
      this.dependencies.overallTimeoutMs ?? 60_000
    );

    let indexers;
    let serials: DiscSerials | null = null;
    let collections: Collection[] = [];
    let searchedSerial: string | null = null;
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

      serials = await this.lookupSerials(
        input.platformId,
        [game.name, ...game.alternativeNames]
      );
      // One extra query per torrent indexer, by the preferred region's serial.
      // Ranking still checks every title against all of the game's serials.
      searchedSerial = serials?.serials[0] ?? null;
      const rankInput = {
        canonicalTitle: game.name,
        alternativeNames: game.alternativeNames,
        selectedAliases: platformAliases(platform),
        conflictingAliases,
        releaseYear: game.releaseYear,
        categoryIds: platform.categoryIds ?? [],
        serials
      };
      const collectionList = this.dependencies.collections
        ? this.dependencies.collections.list(input.platformId)
        : { collections: [], warnings: [] };
      collections = collectionList.collections;
      for (const message of collectionList.warnings) {
        warnings.push({
          indexerId: COLLECTIONS_WARNING_ID,
          indexerName: COLLECTIONS_WARNING_NAME,
          message
        });
      }
      const redumpNames = [...new Set(
        (serials?.serials ?? []).flatMap((serial) => {
          const name = serials?.gameFor(serial);
          return name ? [name] : [];
        })
      )];
      for (const collection of collections) {
        for (const file of matchCollectionFiles(
          collection,
          [game.name, ...game.alternativeNames],
          redumpNames
        )) {
          ranked.push(rankRelease({
            ...rankInput,
            release: {
              guid: `${collectionIndexerId(collection.id)}:${file.index}`,
              title: collectionFileTitle(file.name),
              protocol: "torrent",
              indexerId: collectionIndexerId(collection.id),
              indexerName: collection.name,
              downloadUrl: `${collectionIndexerId(collection.id)}/${file.index}`,
              magnetUrl: null,
              seeders: null,
              peers: null,
              size: file.size,
              category: null,
              publishedAt: null
            },
            preferredSource: collection.name
          }));
        }
      }
      await Promise.all([
        this.searchInternetArchive(
          game.name,
          controller.signal,
          (release) => ranked.push(rankRelease({
            ...rankInput,
            release,
            preferredSource: INTERNET_ARCHIVE_INDEXER_NAME
          })),
          (message) => warnings.push({
            indexerId: INTERNET_ARCHIVE_INDEXER_ID,
            indexerName: INTERNET_ARCHIVE_INDEXER_NAME,
            message
          })
        ),
        this.forEachConcurrent(
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
            // Torrent indexers only: usenet posts are obfuscated, so a
            // serial never finds anything there, and Prowlarr paces queries
            // one at a time, so each wasted one pushes later indexers past
            // their timeout.
            const serialQuery: PlannedQuery | null =
              searchedSerial && indexer.protocol === "torrent"
                ? { term: searchedSerial, categories, reason: "serial" }
                : null;
            const bySerial = serialQuery
              ? prowlarr.search(indexer, serialQuery, controller.signal)
                .then((result) => result.releases)
                // Supplementary: a failed serial query costs only its extras.
                .catch(() => [])
              : Promise.resolve([]);
            try {
              const [result, serialReleases] = await Promise.all([
                prowlarr.search(indexer, query, controller.signal),
                bySerial
              ]);
              ranked.push(...serialReleases.map((release) =>
                rankRelease({ ...rankInput, release })));
              warnings.push(...result.warnings.map((message) => ({
                indexerId: indexer.id,
                indexerName: indexer.name,
                message
              })));
              ranked.push(...result.releases.map((release) =>
                rankRelease({ ...rankInput, release })));
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
        )
      ]);
    } finally {
      clearTimeout(timeout);
    }

    const indexerById = new Map<string, ProwlarrIndexerSummary>(
      indexers.map((indexer) => [indexer.id, indexer])
    );
    if (this.dependencies.internetArchive) {
      // Priority 0 sorts it ahead of every Prowlarr indexer when one release
      // title is offered by several sources.
      indexerById.set(INTERNET_ARCHIVE_INDEXER_ID, {
        id: INTERNET_ARCHIVE_INDEXER_ID,
        name: INTERNET_ARCHIVE_INDEXER_NAME,
        protocol: "torrent",
        priority: 0,
        categoryIds: []
      });
    }
    for (const collection of collections) {
      indexerById.set(collectionIndexerId(collection.id), {
        id: collectionIndexerId(collection.id),
        name: collection.name,
        protocol: "torrent",
        priority: 0,
        categoryIds: []
      });
    }
    const collectionById = new Map(
      collections.map((collection) => [collectionIndexerId(collection.id), collection])
    );
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
        if (source.indexerId === INTERNET_ARCHIVE_INDEXER_ID) {
          return [this.saveInternetArchiveCandidate(source, timestamp)];
        }
        const collection = collectionById.get(source.indexerId);
        if (collection) {
          return [this.saveCollectionCandidate(source, collection, timestamp)];
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
      torrentClientConfigured: this.dependencies.torrentClientConfigured(),
      searchedSerial
    };
  }

  /**
   * Serials sharpen a search but never block one: a missing or slow Redump
   * list (first download) means searching by title alone.
   */
  private async lookupSerials(
    platformId: number,
    titles: string[]
  ): Promise<DiscSerials | null> {
    const catalog = this.dependencies.serialCatalog;
    if (!catalog) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        catalog.lookup(platformId, titles),
        new Promise<null>((resolve) => {
          timer = setTimeout(
            () => resolve(null),
            this.dependencies.serialLookupTimeoutMs ?? 5_000
          );
        })
      ]);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
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

    if (candidate.indexerId.startsWith(COLLECTION_INDEXER_PREFIX)) {
      return this.collectionCandidateFile(candidate);
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

  /**
   * A collection candidate is one file inside a shared torrent, so the file
   * list is that single file, read from the already-parsed collection rather
   * than the torrent bytes.
   */
  private collectionCandidateFile(
    candidate: ReleaseCandidateRecord
  ): CandidateFilesResponse {
    let snapshot: unknown;
    try {
      snapshot = JSON.parse(candidate.sourceSnapshot);
    } catch {
      snapshot = null;
    }
    const record = typeof snapshot === "object" && snapshot !== null
      ? snapshot as Record<string, unknown>
      : {};
    const found = typeof record.collectionId === "string"
      ? this.dependencies.collections?.read(record.collectionId)
      : null;
    const file: CollectionFile | undefined = found?.collection.files.find(
      (entry) => entry.index === record.fileIndex
        && entry.name === record.fileName
    );
    if (!found || !file) {
      throw new AppError(
        "NOT_FOUND",
        404,
        "That collection file is no longer available"
      );
    }
    return {
      files: [{ index: file.index, name: file.name, size: file.size }],
      metadataPending: false,
      collection: { name: found.collection.name }
    };
  }

  /**
   * Collection candidates never touch the Prowlarr URL policy: nothing is
   * fetched from a URL. The snapshot names the collection and file, and the
   * fetch step re-reads the `.torrent` from the config folder and re-checks them.
   */
  private saveCollectionCandidate(
    source: Release,
    collection: Collection,
    timestamp: number
  ): PublicReleaseSource {
    const fileIndex = Number(source.guid.slice(source.guid.lastIndexOf(":") + 1));
    const file = collection.files.find((entry) => entry.index === fileIndex);
    if (!file) throw validationError("Collection changed during release search");
    const candidateId = this.id();
    this.dependencies.candidates.save({
      id: candidateId,
      expiresAt: timestamp + 30 * 60 * 1000,
      protocol: "torrent",
      indexerId: collectionIndexerId(collection.id),
      indexerConfigRevision: this.dependencies.prowlarrConfigRevision,
      guid: source.guid,
      title: source.title,
      size: source.size,
      seeders: null,
      downloadPath: `/collection/${collection.id}/${file.index}`,
      category: null,
      sourceSnapshot: JSON.stringify({
        indexerName: collection.name,
        collectionId: collection.id,
        torrentFileName: collection.torrentFileName,
        fileIndex: file.index,
        fileName: file.name,
        origin: null,
        magnetUrl: null
      }),
      createdAt: timestamp
    });
    return {
      candidateId,
      indexerName: collection.name,
      protocol: "torrent",
      seeders: null
    };
  }

  /**
   * One archive.org search per release search, run beside the indexer fan-out.
   * Failure is isolated exactly like a single indexer failing: a warning, never
   * a failed search. Messages are fixed strings from the adapter's `AppError`s,
   * which never carry an upstream URL or body.
   */
  private async searchInternetArchive(
    title: string,
    signal: AbortSignal,
    onRelease: (release: Release) => void,
    onWarning: (message: string) => void
  ): Promise<void> {
    const internetArchive = this.dependencies.internetArchive;
    if (!internetArchive) return;
    let result;
    try {
      result = await internetArchive.search({ title }, signal);
    } catch (error) {
      onWarning(
        signal.aborted
          ? "Internet Archive search timed out"
          : error instanceof AppError
            ? error.message
            : "Internet Archive search failed"
      );
      return;
    }
    for (const message of result.warnings) onWarning(message);
    for (const item of result.items) {
      onRelease({
        guid: item.detailsUrl,
        title: item.title,
        protocol: "torrent",
        indexerId: INTERNET_ARCHIVE_INDEXER_ID,
        indexerName: INTERNET_ARCHIVE_INDEXER_NAME,
        downloadUrl: item.torrentUrl,
        magnetUrl: null,
        seeders: null,
        peers: null,
        size: item.size,
        category: null,
        publishedAt: item.publishedAt
      });
    }
  }

  /**
   * Internet Archive candidates bypass the Prowlarr URL policy: their URL is
   * built by the adapter from a validated identifier on the canonical
   * archive.org origin, never taken from a feed. The identifier is persisted so
   * the fetch adapter can rebuild the request without trusting a stored URL.
   */
  private saveInternetArchiveCandidate(
    source: Release,
    timestamp: number
  ): PublicReleaseSource {
    const url = new URL(source.downloadUrl);
    const identifier = decodeURIComponent(url.pathname.split("/")[2] ?? "");
    const candidateId = this.id();
    this.dependencies.candidates.save({
      id: candidateId,
      expiresAt: timestamp + 30 * 60 * 1000,
      protocol: "torrent",
      indexerId: INTERNET_ARCHIVE_INDEXER_ID,
      indexerConfigRevision: this.dependencies.prowlarrConfigRevision,
      guid: source.guid,
      title: source.title,
      size: source.size,
      seeders: null,
      downloadPath: url.pathname,
      category: null,
      sourceSnapshot: JSON.stringify({
        indexerName: INTERNET_ARCHIVE_INDEXER_NAME,
        origin: url.origin,
        identifier,
        magnetUrl: null
      }),
      createdAt: timestamp
    });
    return {
      candidateId,
      indexerName: INTERNET_ARCHIVE_INDEXER_NAME,
      protocol: "torrent",
      seeders: null
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
