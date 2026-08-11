import type { NzbUpload, SabJob } from "@/features/downloads/models";
import type {
  InternetArchiveFile,
  ItemTorrent
} from "@/features/release-search/models";
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
}

export interface TorrentClientPort {
  add(input: {
    payload: { torrent: Uint8Array; filename: string } | { magnet: string };
    category: string | null;
    tag: string;
  }): Promise<{ hash: string | null }>;
  listFiles(hash: string): Promise<Array<{ index: number; name: string }>>;
  setFilePriorities(
    hash: string,
    indices: number[],
    priority: 0
  ): Promise<void>;
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

/**
 * Everything the torrent path needs, bound in the composition root. Separate
 * from `InternetArchiveDownloadConfig` because the two deliveries share no
 * machinery: one streams bytes to disk under a heartbeat, the other hands
 * metainfo to a client that owns the download from then on.
 */
export interface InternetArchiveTorrentConfig {
  /** Resolves the item's `_archive.torrent`, or null when it has none. */
  findTorrent(identifier: string): Promise<ItemTorrent | null>;
  fetchTorrent(identifier: string, fileName: string): Promise<Uint8Array>;
  client(): TorrentClientPort | null;
  /**
   * A function, not a value, for the same reason `client()` is: the category
   * lives in `qbittorrent_settings`, and the composition root is built during
   * startup recovery — before migrations have necessarily run. Reading it
   * eagerly makes `buildDownloadService()` query a table that may not exist
   * yet, which turns a deferrable "schema not ready" into a hard failure and
   * masks any genuine error the recovery pass was meant to surface.
   */
  defaultCategory(): string | null;
}
