import type { NzbUpload, SabJob } from "@/features/downloads/models";
import type { ReleaseCandidateRecord } from "@/features/release-search/ports";
import type { IndexerRecord } from "@/features/settings/models";

export interface SabnzbdPort {
  upload(input: NzbUpload): Promise<{ jobId: string }>;
  getQueue(): Promise<SabJob[]>;
  getHistory(): Promise<SabJob[]>;
  testConnection(): Promise<void>;
}

export interface NzbFetcherPort {
  fetch(input: {
    candidate: ReleaseCandidateRecord;
    indexer: IndexerRecord;
    maxBytes: number;
  }): Promise<Uint8Array>;
}
