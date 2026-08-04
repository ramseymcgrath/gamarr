import type { IndexerRecord } from "@/features/settings/models";
import type {
  InternetArchiveFile,
  InternetArchiveSearchResult,
  NewznabSearchResult,
  PlannedQuery,
  ReleaseSourceType
} from "@/features/release-search/models";

export interface NewznabPort {
  search(
    query: PlannedQuery,
    signal: AbortSignal
  ): Promise<NewznabSearchResult>;
}

export interface InternetArchiveSearchPort {
  search(
    input: { title: string },
    signal: AbortSignal
  ): Promise<InternetArchiveSearchResult>;
  listFiles(identifier: string): Promise<InternetArchiveFile[]>;
}

export interface ReleaseCandidateRecord {
  id: string;
  expiresAt: number;
  source: ReleaseSourceType;
  indexerId: string | null;
  indexerConfigRevision: number;
  guid: string;
  title: string;
  size: number | null;
  downloadPath: string;
  category: string | null;
  sourceSnapshot: string;
  createdAt: number;
}

export interface CandidateRepository {
  save(value: ReleaseCandidateRecord): void;
  get(id: string): ReleaseCandidateRecord | null;
}

export type NewznabClientFactory = (indexer: IndexerRecord) => NewznabPort;
