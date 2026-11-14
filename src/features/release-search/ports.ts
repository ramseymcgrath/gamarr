import type {
  PlannedQuery,
  Release
} from "@/features/release-search/models";

export interface ProwlarrIndexerSummary {
  id: string;
  name: string;
  protocol: "usenet" | "torrent";
  priority: number;
  categoryIds: string[];
}

export interface ProwlarrPort {
  listIndexers(signal: AbortSignal): Promise<ProwlarrIndexerSummary[]>;
  search(
    indexer: ProwlarrIndexerSummary,
    query: PlannedQuery,
    signal: AbortSignal
  ): Promise<{ releases: Release[]; warnings: string[] }>;
}

export interface InternetArchiveSearchItem {
  identifier: string;
  title: string;
  /** Canonical archive.org URLs only — never a data-node host. */
  detailsUrl: string;
  torrentUrl: string;
  publishedAt: number | null;
  size: number | null;
}

export interface InternetArchivePort {
  search(
    input: { title: string },
    signal: AbortSignal
  ): Promise<{ items: InternetArchiveSearchItem[]; warnings: string[] }>;
}

export interface ReleaseCandidateRecord {
  id: string;
  expiresAt: number;
  protocol: "usenet" | "torrent";
  indexerId: string;
  indexerConfigRevision: number;
  guid: string;
  title: string;
  size: number | null;
  seeders: number | null;
  downloadPath: string;
  category: string | null;
  sourceSnapshot: string;
  createdAt: number;
}

export interface CandidateRepository {
  save(value: ReleaseCandidateRecord): void;
  get(id: string): ReleaseCandidateRecord | null;
}

/** A game's disc serials, from the platform's Redump list. */
export interface DiscSerials {
  /** This game's retail serials in display form, the preferred region first. */
  serials: string[];
  /** The Redump game a serial belongs to, or `null` for an unknown serial. */
  gameFor(serial: string): string | null;
}

export interface SerialCatalogPort {
  /** `null` when the platform has no Redump list. */
  lookup(platformId: number, titles: string[]): Promise<DiscSerials | null>;
}
