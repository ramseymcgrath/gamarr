/**
 * New attempts are source-derived from Prowlarr's protocol. The remaining
 * values are legacy history written before the Prowlarr refactor; they remain
 * readable for replay compatibility but are never created.
 */
export type AttemptSourceType =
  | "prowlarr-usenet"
  | "prowlarr-torrent"
  | "newznab"
  | "internet-archive"
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

export interface SelectedFile {
  index: number;
  name: string;
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
  selectedFiles: SelectedFile[] | null;
  filesAppliedAt: number | null;
  size: number | null;
  category: string | null;
  sabnzbdConfigRevision: number;
  /** Stored in the legacy `sab_marker` column; shared by SAB and qBittorrent. */
  marker: string;
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
  /** Torrent metainfo indices. Empty or absent means the whole torrent. */
  selectedFiles?: number[];
}
