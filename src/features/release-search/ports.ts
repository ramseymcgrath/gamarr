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
