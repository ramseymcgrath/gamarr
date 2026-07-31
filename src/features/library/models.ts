import type { DownloadStatus } from "@/features/downloads/models";

export interface LibraryAttempt {
  id: string;
  status: DownloadStatus;
  releaseTitle: string;
  progress: number;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  failureDetail: string | null;
}

export interface LibraryDetail {
  id: string;
  gameId: number;
  gameTitle: string;
  coverUrl: string | null;
  platformId: number;
  platformName: string;
  createdAt: number;
  updatedAt: number;
  attempts: LibraryAttempt[];
}

export interface LibraryCard extends Omit<LibraryDetail, "attempts"> {
  latestAttempt: LibraryAttempt | null;
}
