import type { ReleaseSourceType } from "@/features/release-search/models";

export type DownloadStatus =
  | "Pending"
  | "Submitting"
  | "Queued"
  | "Downloading"
  | "Completed"
  | "Failed"
  | "Unknown";

/**
 * Statuses an attempt can never leave. `Unknown` is deliberately absent: it
 * means "outcome not established yet" and reconcile is expected to resolve it
 * into a real terminal status later.
 */
export const TERMINAL_DOWNLOAD_STATUSES: readonly DownloadStatus[] = [
  "Completed",
  "Failed"
];

export function isTerminalDownloadStatus(status: DownloadStatus): boolean {
  return TERMINAL_DOWNLOAD_STATUSES.includes(status);
}

export interface NzbUpload {
  filename: string;
  bytes: Uint8Array;
  category: string | null;
  marker: string;
}

export interface SabJob {
  jobId: string;
  marker: string;
  status: string;
  progress: number;
}

export interface DownloadAttempt {
  id: string;
  libraryEntryId: string;
  submissionKey: string;
  requestFingerprint: string;
  status: DownloadStatus;
  source: ReleaseSourceType;
  releaseTitle: string;
  indexerId: string | null;
  indexerNameSnapshot: string;
  indexerUrlSnapshot: string | null;
  newznabGuid: string | null;
  iaFileName: string | null;
  size: number | null;
  category: string | null;
  sabnzbdConfigRevision: number;
  sabMarker: string;
  sabJobId: string | null;
  progress: number;
  failureDetail: string | null;
  sabRequestStartedAt: number | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface SubmissionClaimInput {
  library: {
    id: string;
    gameId: number;
    platformId: number;
    createdAt: number;
    updatedAt: number;
  };
  attempt: DownloadAttempt;
}

export interface SubmitDownloadInput {
  submissionKey: string;
  candidateId: string;
  gameId: number;
  platformId: number;
  /**
   * Required for Internet Archive candidates, which bundle many files per
   * item; ignored for Newznab candidates, whose fingerprint never includes it
   * so a replay carrying one still matches.
   *
   * Whitespace is significant. The name is matched against Internet Archive
   * metadata by exact equality and becomes both a URL path segment and the
   * file name on disk, so " Game.zip" is a different file from "Game.zip".
   */
  fileName?: string;
}
