import type { ReleaseSourceType } from "@/features/release-search/models";

/**
 * How an attempt's payload is delivered. Wider than `ReleaseSourceType`
 * because torrent delivery is a property of the *attempt*, not of the release:
 * an Internet Archive search result can be taken either way, and the choice is
 * made at submit time. Stored on the attempt because `assertSameRequest`
 * recomputes a replayed fingerprint from it — the candidate that produced the
 * original may already have expired.
 */
export type AttemptSourceType =
  | ReleaseSourceType
  | "internet-archive-torrent";

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
  source: AttemptSourceType;
  releaseTitle: string;
  indexerId: string | null;
  indexerNameSnapshot: string;
  indexerUrlSnapshot: string | null;
  newznabGuid: string | null;
  iaFileName: string | null;
  /** qBittorrent infohash. Null until the client reports one — WebAPI builds
   * before 2.14.0 answer `torrents/add` with a bare `Ok.`, and those attempts
   * are matched by tag instead. */
  torrentHash: string | null;
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
   * Which delivery an Internet Archive candidate should use. Defaults to
   * `"file"` so existing clients keep working unchanged. Ignored for Newznab
   * candidates, which have only one delivery.
   */
  delivery?: "file" | "torrent";
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
