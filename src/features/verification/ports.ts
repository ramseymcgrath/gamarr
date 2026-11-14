import type { DownloadAttempt } from "@/features/downloads/models";
import type { DiscRead } from "@/features/verification/disc";
import type {
  DownloadVerification,
  ExportResult,
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
  /** Startup recovery: `Running` rows (checks and exports) go back to `Pending`. */
  resetRunning(timestamp: number): number;
  /** Queues an export; the row must exist. */
  requestExport(attemptId: string, timestamp: number): DownloadVerification;
  claimNextExport(timestamp: number): DownloadVerification | null;
  completeExport(
    attemptId: string,
    result: ExportResult,
    timestamp: number
  ): DownloadVerification;
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
  stream(path: string): AsyncIterable<Uint8Array>;
}

export interface ArchiveEntry {
  /** Path inside the archive. */
  path: string;
  size: number;
}

/** Reads `.7z`, `.zip` and `.rar` without extracting them to disk. */
export interface ArchivePort {
  list(archivePath: string): Promise<ArchiveEntry[]>;
  /**
   * Streams one entry. Throws after the last chunk when the archive is
   * damaged (its own CRC failed) or encrypted, so a consumer that read every
   * byte also learns the bytes were good.
   */
  open(archivePath: string, entry: string): AsyncIterable<Uint8Array>;
}

/** A disc image to check: a plain file or a file inside an archive. */
export type ImageSource =
  | { kind: "file"; path: string; name: string; size: number }
  | {
    kind: "archive";
    archivePath: string;
    entry: string;
    /** `Game.rar › Game.iso`, for display. */
    name: string;
    size: number;
  };

/** The Open PS2 Loader share (`DVD/`, `CD/`) gamarr writes verified images to. */
export interface Ps2LibraryPort {
  freeBytes(): Promise<number>;
  /**
   * Starts a hidden temp file at the share root. `commit` moves it to
   * `relativePath` without replacing anything already there.
   */
  begin(): Promise<Ps2LibraryWrite>;
}

export interface Ps2LibraryWrite {
  write(chunk: Uint8Array): Promise<void>;
  commit(relativePath: string): Promise<"created" | "exists">;
  discard(): Promise<void>;
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
