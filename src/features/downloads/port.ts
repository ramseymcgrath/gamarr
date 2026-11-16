import type { NzbUpload, SabJob } from "@/features/downloads/models";
import type { ReleaseCandidateRecord } from "@/features/release-search/ports";
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

/**
 * Whether an add failure is known to have submitted nothing (`rejected`) or
 * might have been accepted before the failure surfaced (`ambiguous`). Only
 * `rejected` is safe to persist as a terminal `Failed`. Exactly the
 * `SabnzbdUploadError` contract, for exactly the same reason.
 */
export type TorrentAddOutcome = "rejected" | "ambiguous";

export class TorrentAddError extends AppError {
  constructor(
    readonly outcome: TorrentAddOutcome,
    message: string,
    options?: ErrorOptions
  ) {
    super("UNAVAILABLE", 502, message, options);
    this.name = "TorrentAddError";
  }
}

export interface TorrentJob {
  hash: string;
  /** A torrent may carry several tags, so attempts match by membership. */
  tags: string[];
  state: string;
  /** Already scaled to 0..100 from qBittorrent's 0..1 fraction. */
  progress: number;
  /** Where the content lives inside the qBittorrent container. */
  contentPath?: string;
  /** qBittorrent's `save_path`: the directory the torrent downloads into. */
  savePath?: string;
}

export interface TorrentClientPort {
  add(input: {
    payload: { torrent: Uint8Array; filename: string } | { magnet: string };
    category: string | null;
    tag: string;
    /** Add paused, so file priorities can be set before any piece downloads. */
    stopped?: boolean;
  }): Promise<{ hash: string | null }>;
  /**
   * Throws `AppError("NOT_FOUND", 404)` when qBittorrent does not know the
   * torrent yet, so callers can tell that apart from other failures.
   * `progress` is qBittorrent's raw 0..1 fraction.
   */
  listFiles(hash: string): Promise<Array<{
    index: number;
    name: string;
    progress: number;
    priority: number;
  }>>;
  setFilePriorities(
    hash: string,
    indices: number[],
    priority: 0 | 1
  ): Promise<void>;
  addTags(hash: string, tag: string): Promise<void>;
  start(hash: string): Promise<void>;
  /**
   * Every torrent the client knows about, in one request. qBittorrent's `tag=`
   * filter accepts a single value, so filtering server-side would cost one
   * HTTP round trip per in-flight attempt on every reconcile.
   */
  list(): Promise<TorrentJob[]>;
  testConnection(): Promise<void>;
}

export interface SabnzbdPort {
  upload(input: NzbUpload): Promise<{ jobId: string }>;
  getQueue(): Promise<SabJob[]>;
  getHistory(): Promise<SabJob[]>;
  testConnection(): Promise<void>;
}

export type FetchedRelease =
  | { kind: "nzb"; bytes: Uint8Array }
  | { kind: "torrent"; bytes: Uint8Array }
  | { kind: "magnet"; uri: string };

export interface ReleaseFetcherPort {
  fetch(input: {
    candidate: ReleaseCandidateRecord;
    magnetUrl: string | null;
    maxBytes: number;
  }): Promise<FetchedRelease>;
}
