import type { DownloadAttempt } from "@/features/downloads/models";
import type { DiscRead } from "@/features/verification/disc";
import type {
  DownloadVerification,
  VerificationResult
} from "@/features/verification/models";
import type { RedumpIndex } from "@/features/verification/redump";

export interface VerificationTarget {
  attempt: DownloadAttempt;
  platformId: number;
}

export interface VerificationRepository {
  get(attemptId: string): DownloadVerification | null;
  list(): DownloadVerification[];
  /** Inserts or resets a row to `Pending`, clearing any previous result. */
  requestPending(attemptId: string, timestamp: number): DownloadVerification;
  /** Atomically moves the oldest `Pending` row to `Running`. */
  claimNextPending(timestamp: number): DownloadVerification | null;
  complete(
    attemptId: string,
    result: VerificationResult,
    timestamp: number
  ): DownloadVerification;
  /** Startup recovery: `Running` rows left by a crash go back to `Pending`. */
  resetRunning(timestamp: number): number;
  target(attemptId: string): VerificationTarget | null;
}

export interface DiscFileEntry {
  /** Absolute path inside gamarr's container. */
  path: string;
  /** Path relative to the download folder, for display. */
  name: string;
  size: number;
}

export interface DiscFilesPort {
  /** A file, or the files under a directory (bounded depth and count). */
  list(path: string): Promise<DiscFileEntry[]>;
  sha1(path: string): Promise<string>;
  reader(path: string): DiscRead;
}

export interface RedumpSourcePort {
  load(datName: string): Promise<RedumpIndex>;
}

/** Where the client says a finished download lives, in its own container. */
export type DownloadLocation =
  | { kind: "found"; clientPath: string }
  | { kind: "missing"; detail: string };

export interface DownloadLocatorPort {
  locate(attempt: DownloadAttempt): Promise<DownloadLocation>;
}
