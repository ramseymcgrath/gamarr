import type { IndexerRecord } from "@/features/settings/models";
import type {
  NewznabSearchResult,
  PlannedQuery
} from "@/features/release-search/models";

export interface NewznabPort {
  search(
    query: PlannedQuery,
    signal: AbortSignal
  ): Promise<NewznabSearchResult>;
}

export interface ReleaseCandidateRecord {
  id: string;
  expiresAt: number;
  indexerId: string;
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
