export type DownloadStatus =
  | "Pending"
  | "Submitting"
  | "Queued"
  | "Downloading"
  | "Completed"
  | "Failed"
  | "Unknown";

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
  releaseTitle: string;
  indexerId: string | null;
  indexerNameSnapshot: string;
  indexerUrlSnapshot: string | null;
  newznabGuid: string | null;
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
}
