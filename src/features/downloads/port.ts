import type { NzbUpload, SabJob } from "@/features/downloads/models";
import type { InternetArchiveFile } from "@/features/release-search/models";
import type { ReleaseCandidateRecord } from "@/features/release-search/ports";
import type { IndexerRecord } from "@/features/settings/models";
import { AppError } from "@/lib/errors";

/**
 * Whether an upload failure is known to have submitted nothing (`rejected`) or
 * might have been accepted before the failure surfaced (`ambiguous`). Only
 * `rejected` is safe to persist as a terminal `Failed`.
 */
export type SabnzbdUploadOutcome = "rejected" | "ambiguous";

export class SabnzbdUploadError extends AppError {
  constructor(
    readonly outcome: SabnzbdUploadOutcome,
    message: string,
    options?: ErrorOptions
  ) {
    super("UNAVAILABLE", 502, message, options);
    this.name = "SabnzbdUploadError";
  }
}

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

/**
 * Direct server-side download of one file from an Internet Archive item.
 * Implemented by the internet-archive integration (client metadata lookup
 * plus streaming downloader); injected into DownloadService as a single
 * narrowed port.
 */
export interface InternetArchiveDownloadPort {
  getFileInfo(input: {
    identifier: string;
    fileName: string;
  }): Promise<InternetArchiveFile | null>;
  download(input: {
    identifier: string;
    fileName: string;
    destinationDir: string;
    attemptId: string;
    maxBytes: number;
    onProgress: (received: number, total: number | null) => void;
  }): Promise<{ bytes: number; filePath: string }>;
}

export interface InternetArchiveDownloadConfig
  extends InternetArchiveDownloadPort {
  downloadDir: string;
  maxBytes: number;
}
