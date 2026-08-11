import { createHash, randomUUID } from "node:crypto";
// Imported explicitly rather than taken from the global scope: `lib: ["dom"]`
// types the global `setInterval` as returning a `number`, which has no
// `unref()`, and an unref'd handle is what keeps a heartbeat from holding the
// process open.
import { clearInterval, setInterval } from "node:timers";

import {
  isTerminalDownloadStatus,
  type AttemptSourceType,
  type DownloadAttempt,
  type DownloadStatus,
  type SubmitDownloadInput
} from "@/features/downloads/models";
import {
  SabnzbdUploadError,
  type InternetArchiveDownloadConfig,
  type InternetArchiveTorrentConfig,
  type NzbFetcherPort,
  type SabnzbdPort,
  TorrentAddError
} from "@/features/downloads/port";
import type { DownloadRepository } from "@/features/downloads/repository";
import { INTERNET_ARCHIVE_INDEXER_NAME } from "@/features/release-search/models";
import type {
  CandidateRepository,
  ReleaseCandidateRecord
} from "@/features/release-search/ports";
import type { SabnzbdSettingsRecord } from "@/features/settings/models";
import type { SettingsRepository } from "@/features/settings/service";
import {
  isSafeInternetArchiveFileName,
  isValidInternetArchiveIdentifier
} from "@/integrations/internet-archive/path-policy";
import { AppError, validationError } from "@/lib/errors";

interface DownloadServiceDependencies {
  repository: DownloadRepository;
  candidates: CandidateRepository;
  settings: SettingsRepository;
  nzbFetcher: NzbFetcherPort;
  sabFactory: (settings: SabnzbdSettingsRecord) => SabnzbdPort;
  internetArchive?: InternetArchiveDownloadConfig;
  internetArchiveTorrent?: InternetArchiveTorrentConfig;
  now?: () => number;
  id?: () => string;
  /**
   * Schedules the in-flight download heartbeat and returns its canceller.
   * Injectable for the same reason `now` and `id` are: vitest's fake timers
   * replace `globalThis.setInterval`, not the `node:timers` binding this
   * module imports, so a test cannot otherwise drive the heartbeat.
   */
  scheduleHeartbeat?: (callback: () => void, intervalMs: number) => () => void;
}

/**
 * How often an in-flight Internet Archive download stamps `updatedAt` to prove
 * it is alive. Progress callbacks are not a liveness signal: a stalled archive
 * node can deliver zero chunks for an unbounded time, so this timer runs
 * unconditionally alongside the stream.
 */
const IA_HEARTBEAT_MS = 5_000;

/**
 * How quiet a Pending/Downloading Internet Archive row must be before recovery
 * treats it as orphaned. A comfortable multiple of the heartbeat interval
 * (12x) so ordinary event-loop pressure, a slow SQLite write, or a missed tick
 * can never make a live download look abandoned.
 */
const IA_STALE_AFTER_MS = 60_000;

/**
 * The exact string the Internet Archive path downloads. Identity, deliberately:
 * the name is matched verbatim upstream and on disk, so the fingerprint must
 * hash the same bytes the download uses. Kept as a named helper so the two
 * call sites can never drift apart.
 */
function selectedFileName(input: SubmitDownloadInput): string {
  return input.fileName ?? "";
}

/**
 * Identity is derived from the candidate's source, never from whether a file
 * name happens to be present. The Newznab shape is deliberately the 3-element
 * array earlier versions wrote, so rows already in deployed databases keep
 * matching: `source` is NOT NULL defaulting to 'newznab' and migration 0003
 * backfilled every pre-existing row, so a legacy row always selects the legacy
 * identity. A Newznab submission that carries an ignored file name therefore
 * still replays instead of conflicting.
 */
function fingerprint(
  input: SubmitDownloadInput,
  source: AttemptSourceType
): string {
  const identity = source === "internet-archive"
    ? [input.candidateId, input.gameId, input.platformId, selectedFileName(input)]
    : source === "internet-archive-torrent"
      ? [input.candidateId, input.gameId, input.platformId, "torrent"]
      : [input.candidateId, input.gameId, input.platformId];
  return createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex");
}

const historySuccess = ["completed", "completed/pp", "completed/unpack"];

/**
 * SABnzbd moves a job into history as soon as downloading finishes and keeps it
 * there throughout post-processing (Extracting, Repairing, Moving, ...). Only
 * `Completed` and `Failed` are terminal, so anything else returns null meaning
 * "no verdict yet" — writing a terminal status there would be permanent, since
 * reconcile never revisits a Completed or Failed attempt.
 */
function statusFromJob(
  source: "queue" | "history",
  status: string
): DownloadStatus | null {
  const normalized = status.toLowerCase();
  if (source === "history") {
    if (historySuccess.includes(normalized)) return "Completed";
    if (normalized === "failed") return "Failed";
    return null;
  }
  return normalized.includes("download") ? "Downloading" : "Queued";
}

/**
 * qBittorrent states, mapped the same way SABnzbd history is: only
 * `Completed` and `Failed` are terminal, and an unrecognised state returns
 * null meaning "no verdict yet". Writing a terminal status on a state this
 * table does not know would be permanent, because reconcile never revisits a
 * Completed or Failed attempt.
 */
const torrentStatuses: Readonly<Record<string, DownloadStatus>> = {
  uploading: "Completed",
  stalledUP: "Completed",
  pausedUP: "Completed",
  queuedUP: "Completed",
  forcedUP: "Completed",
  checkingUP: "Completed",
  error: "Failed",
  missingFiles: "Failed",
  downloading: "Downloading",
  stalledDL: "Downloading",
  metaDL: "Downloading",
  forcedDL: "Downloading",
  checkingDL: "Downloading",
  allocating: "Downloading",
  queuedDL: "Queued",
  pausedDL: "Queued",
  checkingResumeData: "Queued",
  moving: "Queued"
};

function statusFromTorrent(state: string): DownloadStatus | null {
  return torrentStatuses[state] ?? null;
}

function torrentProgress(progress: number): number {
  return Math.min(100, Math.max(0, Math.round(progress)));
}

/**
 * True only when the upload provably never reached SABnzbd's queue. Anything
 * else — a timeout, an aborted connection, a 5xx, an unreadable acknowledgement
 * — may have been accepted, so it must stay Unknown rather than terminal.
 */
function submittedNothing(error: unknown): boolean {
  if (error instanceof SabnzbdUploadError) return error.outcome === "rejected";
  return error instanceof AppError && error.code === "VALIDATION";
}

export class DownloadService {
  private readonly now: () => number;
  private readonly id: () => string;
  private readonly scheduleHeartbeat: (
    callback: () => void,
    intervalMs: number
  ) => () => void;

  constructor(private readonly dependencies: DownloadServiceDependencies) {
    this.now = dependencies.now ?? Date.now;
    this.id = dependencies.id ?? randomUUID;
    this.scheduleHeartbeat = dependencies.scheduleHeartbeat
      ?? ((callback, intervalMs) => {
        const handle = setInterval(callback, intervalMs);
        // A heartbeat must never be the reason the process stays alive.
        handle.unref();
        return () => clearInterval(handle);
      });
  }

  async submit(input: SubmitDownloadInput): Promise<DownloadAttempt> {
    if (
      !input.submissionKey.trim() ||
      !Number.isInteger(input.gameId) ||
      !Number.isInteger(input.platformId)
    ) {
      throw validationError("Invalid download submission");
    }
    // The replay short-circuit runs before anything is resolved: candidates
    // expire after 30 minutes while attempt rows are permanent, so resolving
    // one here would turn every later replay into a spurious 400. The stored
    // attempt carries the source needed to recompute its own fingerprint.
    const existing = this.dependencies.repository
      .findBySubmissionKey(input.submissionKey);
    if (existing) return this.assertSameRequest(existing, input);

    const candidate = this.dependencies.candidates.get(input.candidateId);
    if (!candidate) throw validationError("Release candidate has expired");
    if (candidate.source === "internet-archive") {
      return input.delivery === "torrent"
        ? this.submitInternetArchiveTorrent(input, candidate)
        : this.submitInternetArchive(input, candidate);
    }
    const requestFingerprint = fingerprint(input, candidate.source);
    const sabSettings = this.dependencies.settings.getSabnzbd();
    if (!sabSettings?.apiKey) {
      throw validationError("SABnzbd is not configured");
    }
    const indexer = this.dependencies.settings.listIndexers()
      .find((value) => value.id === candidate.indexerId);
    if (
      !indexer ||
      indexer.deletedAt !== null ||
      indexer.configRevision !== candidate.indexerConfigRevision
    ) {
      throw validationError("Indexer configuration changed; search again");
    }
    const snapshot = JSON.parse(candidate.sourceSnapshot) as {
      indexerName?: string;
      origin?: string;
    };
    const timestamp = this.now();
    const attemptId = this.id();
    const claimed = this.dependencies.repository.claimSubmission({
      library: {
        id: `library-${input.gameId}-${input.platformId}`,
        gameId: input.gameId,
        platformId: input.platformId,
        createdAt: timestamp,
        updatedAt: timestamp
      },
      attempt: {
        id: attemptId,
        libraryEntryId: `library-${input.gameId}-${input.platformId}`,
        submissionKey: input.submissionKey,
        requestFingerprint,
        status: "Pending",
        source: "newznab",
        releaseTitle: candidate.title,
        indexerId: indexer.id,
        indexerNameSnapshot: snapshot.indexerName ?? indexer.name,
        indexerUrlSnapshot: snapshot.origin ?? new URL(indexer.baseUrl).origin,
        newznabGuid: candidate.guid,
        iaFileName: null,
        torrentHash: null,
        size: candidate.size,
        category: sabSettings.defaultCategory,
        sabnzbdConfigRevision: sabSettings.configRevision,
        sabMarker: `gamarr-${attemptId}`,
        sabJobId: null,
        progress: 0,
        failureDetail: null,
        sabRequestStartedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        completedAt: null
      }
    });
    if (!claimed.created) {
      return this.assertSameRequest(claimed.attempt, input);
    }

    let bytes: Uint8Array;
    try {
      bytes = await this.dependencies.nzbFetcher.fetch({
        candidate,
        indexer,
        maxBytes: sabSettings.maxNzbBytes
      });
    } catch (error) {
      return this.dependencies.repository.update(attemptId, {
        status: "Failed",
        // AppError, not Error: `failureDetail` is persisted and rendered in
        // Activity, and only AppError messages are written to be seen. The
        // fetcher rethrows raw undici failures (newznab/download.ts), whose
        // messages can carry the request URL — and that URL embeds the
        // indexer's API key.
        failureDetail: error instanceof AppError
          ? error.message
          : "NZB retrieval failed",
        updatedAt: this.now()
      });
    }

    const submittingAt = this.now();
    this.dependencies.repository.update(attemptId, {
      status: "Submitting",
      sabRequestStartedAt: submittingAt,
      updatedAt: submittingAt
    });
    try {
      const result = await this.dependencies.sabFactory(sabSettings).upload({
        filename: `gamarr-${attemptId}.nzb`,
        bytes,
        category: sabSettings.defaultCategory,
        marker: `gamarr-${attemptId}`
      });
      return this.dependencies.repository.update(attemptId, {
        status: "Queued",
        sabJobId: result.jobId,
        updatedAt: this.now()
      });
    } catch (error) {
      const rejected = submittedNothing(error);
      return this.dependencies.repository.update(attemptId, {
        status: rejected ? "Failed" : "Unknown",
        failureDetail: rejected && error instanceof Error
          ? error.message
          : "SABnzbd acknowledgement was not confirmed",
        updatedAt: this.now()
      });
    }
  }

  /**
   * Internet Archive torrent path: claim a durable attempt, fetch bounded
   * metainfo, and hand it to qBittorrent. qBittorrent owns the payload after
   * submission, so this path deliberately has no direct-download heartbeat.
   */
  private async submitInternetArchiveTorrent(
    input: SubmitDownloadInput,
    candidate: ReleaseCandidateRecord
  ): Promise<DownloadAttempt> {
    if (input.fileName !== undefined) {
      throw validationError(
        "A torrent covers the whole item; do not select a file"
      );
    }
    const config = this.dependencies.internetArchiveTorrent;
    if (!config) {
      throw validationError("Internet Archive torrents are not configured");
    }
    const client = config.client();
    if (!client) throw validationError("qBittorrent is not configured");

    const identifier = candidate.guid;
    if (!isValidInternetArchiveIdentifier(identifier)) {
      throw validationError("Release candidate is not usable; search again");
    }
    const torrent = await config.findTorrent(identifier);
    if (!torrent) {
      throw validationError("This item has no torrent; download a file instead");
    }

    const snapshot = JSON.parse(candidate.sourceSnapshot) as {
      indexerName?: string;
      origin?: string;
    };
    const timestamp = this.now();
    const attemptId = this.id();
    const sabMarker = `gamarr-${attemptId}`;
    const claimed = this.dependencies.repository.claimSubmission({
      library: {
        id: `library-${input.gameId}-${input.platformId}`,
        gameId: input.gameId,
        platformId: input.platformId,
        createdAt: timestamp,
        updatedAt: timestamp
      },
      attempt: {
        id: attemptId,
        libraryEntryId: `library-${input.gameId}-${input.platformId}`,
        submissionKey: input.submissionKey,
        requestFingerprint: fingerprint(input, "internet-archive-torrent"),
        status: "Pending",
        source: "internet-archive-torrent",
        releaseTitle: candidate.title,
        indexerId: null,
        indexerNameSnapshot: snapshot.indexerName
          ?? INTERNET_ARCHIVE_INDEXER_NAME,
        indexerUrlSnapshot: snapshot.origin ?? null,
        newznabGuid: null,
        iaFileName: null,
        torrentHash: null,
        size: candidate.size,
        category: config.defaultCategory(),
        sabnzbdConfigRevision: 0,
        sabMarker,
        sabJobId: null,
        progress: 0,
        failureDetail: null,
        sabRequestStartedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        completedAt: null
      }
    });
    if (!claimed.created) {
      return this.assertSameRequest(claimed.attempt, input);
    }

    let bytes: Uint8Array;
    try {
      bytes = await config.fetchTorrent(identifier, torrent.name);
    } catch (error) {
      return this.dependencies.repository.update(attemptId, {
        status: "Failed",
        failureDetail: error instanceof AppError
          ? error.message
          : "Torrent retrieval failed",
        updatedAt: this.now()
      });
    }

    const submittingAt = this.now();
    this.dependencies.repository.update(attemptId, {
      status: "Submitting",
      sabRequestStartedAt: submittingAt,
      updatedAt: submittingAt
    });
    try {
      const result = await client.add({
        payload: { torrent: bytes, filename: torrent.name },
        category: config.defaultCategory(),
        tag: sabMarker
      });
      return this.dependencies.repository.update(attemptId, {
        status: "Queued",
        torrentHash: result.hash,
        updatedAt: this.now()
      });
    } catch (error) {
      if (error instanceof TorrentAddError) {
        return this.dependencies.repository.update(attemptId, {
          status: error.outcome === "rejected" ? "Failed" : "Unknown",
          failureDetail: error.message,
          updatedAt: this.now()
        });
      }
      return this.dependencies.repository.update(attemptId, {
        status: "Unknown",
        failureDetail: "qBittorrent acknowledgement was not confirmed",
        updatedAt: this.now()
      });
    }
  }

  /**
   * Internet Archive path: no NZB, no SABnzbd. The attempt is claimed first
   * (idempotency rules identical to Newznab), then the file streams to disk
   * outside the request — the response returns `Downloading` and progress is
   * read back through reconcile like any other attempt.
   */
  private async submitInternetArchive(
    input: SubmitDownloadInput,
    candidate: ReleaseCandidateRecord
  ): Promise<DownloadAttempt> {
    const config = this.dependencies.internetArchive;
    if (!config) {
      throw validationError("Internet Archive downloads are not configured");
    }
    // Used verbatim: it must match Internet Archive metadata exactly (the
    // lookup below is an equality match) and it becomes both a URL path
    // segment and the file name on disk. Trimming would miss legitimate names
    // carrying leading or trailing whitespace, and " Game.zip" is genuinely a
    // different file from "Game.zip". trim() is only an emptiness guard here.
    const fileName = selectedFileName(input);
    if (!fileName.trim() || !isSafeInternetArchiveFileName(fileName)) {
      throw validationError("A valid file must be selected");
    }
    const identifier = candidate.guid;
    if (!isValidInternetArchiveIdentifier(identifier)) {
      throw validationError("Release candidate is not usable; search again");
    }
    const fileInfo = await config.getFileInfo({ identifier, fileName });
    if (!fileInfo) {
      throw validationError(
        "The selected file is no longer available; search again"
      );
    }
    const snapshot = JSON.parse(candidate.sourceSnapshot) as {
      indexerName?: string;
      origin?: string;
    };
    const requestFingerprint = fingerprint(input, candidate.source);
    const timestamp = this.now();
    const attemptId = this.id();
    const claimed = this.dependencies.repository.claimSubmission({
      library: {
        id: `library-${input.gameId}-${input.platformId}`,
        gameId: input.gameId,
        platformId: input.platformId,
        createdAt: timestamp,
        updatedAt: timestamp
      },
      attempt: {
        id: attemptId,
        libraryEntryId: `library-${input.gameId}-${input.platformId}`,
        submissionKey: input.submissionKey,
        requestFingerprint,
        status: "Pending",
        source: "internet-archive",
        releaseTitle: candidate.title,
        indexerId: null,
        indexerNameSnapshot: snapshot.indexerName ?? INTERNET_ARCHIVE_INDEXER_NAME,
        indexerUrlSnapshot: snapshot.origin ?? null,
        newznabGuid: null,
        iaFileName: fileName,
        torrentHash: null,
        size: fileInfo.size,
        category: null,
        // No SABnzbd configuration participates in this path; revision 0 is
        // the "unbound" marker and can never collide with a real revision
        // because real revisions start at 1.
        sabnzbdConfigRevision: 0,
        sabMarker: `gamarr-${attemptId}`,
        sabJobId: null,
        progress: 0,
        failureDetail: null,
        sabRequestStartedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        completedAt: null
      }
    });
    if (!claimed.created) {
      return this.assertSameRequest(claimed.attempt, input);
    }

    const attempt = this.dependencies.repository.update(attemptId, {
      status: "Downloading",
      updatedAt: this.now()
    });
    void this.runInternetArchiveDownload(config, attemptId, identifier, fileName);
    return attempt;
  }

  private async runInternetArchiveDownload(
    config: InternetArchiveDownloadConfig,
    attemptId: string,
    identifier: string,
    fileName: string
  ): Promise<void> {
    let lastPercent = -1;
    let lastWrite = 0;
    // Progress callbacks fire per received chunk, so a stalled archive node
    // produces none at all. This timer stamps `updatedAt` regardless, which is
    // what lets recovery tell a live stream from an orphaned row. It patches
    // only `updatedAt` — never status, never progress — so it can never
    // resurrect a row that legitimately failed.
    const stopHeartbeat = this.scheduleHeartbeat(() => {
      this.tryUpdate(attemptId, { updatedAt: this.now() });
    }, IA_HEARTBEAT_MS);
    try {
      const result = await config.download({
        identifier,
        fileName,
        destinationDir: config.downloadDir,
        attemptId,
        maxBytes: config.maxBytes,
        onProgress: (received, total) => {
          const percent = total && total > 0
            ? Math.min(99, Math.floor((received / total) * 100))
            : 0;
          const now = this.now();
          // Throttled: the attempt row exists so the UI can poll progress,
          // not to record every chunk.
          if (percent >= lastPercent + 5 || now - lastWrite >= 1_000) {
            lastPercent = percent;
            lastWrite = now;
            this.tryUpdate(attemptId, { progress: percent, updatedAt: now });
          }
        }
      });
      const completedAt = this.now();
      this.tryUpdate(attemptId, {
        status: "Completed",
        progress: 100,
        size: result.bytes,
        completedAt,
        updatedAt: completedAt
      });
    } catch (error) {
      this.tryUpdate(attemptId, {
        status: "Failed",
        // AppError, not Error: see the NZB path above. The downloader wraps
        // everything it throws, but gating on the type rather than trusting
        // that discipline keeps a node:fs path (which carries the download
        // directory) out of a client-visible field if a future adapter slips.
        failureDetail: error instanceof AppError
          ? error.message
          : "Internet Archive download failed",
        updatedAt: this.now()
      });
    } finally {
      stopHeartbeat();
    }
  }

  /** The library entry can be deleted — cascading the attempt — while a
   * direct download is still streaming; losing that race is not an error. */
  private tryUpdate(id: string, patch: Partial<DownloadAttempt>): void {
    try {
      this.dependencies.repository.update(id, patch);
    } catch {
      // Attempt row is gone; nothing to record progress against.
    }
  }

  async reconcile(ids?: string[]): Promise<DownloadAttempt[]> {
    const attempts = this.selected(ids);
    const timestamp = this.now();
    await Promise.allSettled([
      this.reconcileSabnzbd(attempts, timestamp),
      this.reconcileTorrents(attempts, timestamp)
    ]);
    return this.selected(ids);
  }

  private async reconcileSabnzbd(
    attempts: DownloadAttempt[],
    timestamp: number
  ): Promise<void> {
    const settings = this.dependencies.settings.getSabnzbd();
    if (!settings?.apiKey) return;
    const sab = this.dependencies.sabFactory(settings);
    const [queue, history] = await Promise.all([
      sab.getQueue(),
      sab.getHistory()
    ]);
    for (const attempt of attempts) {
      if (isTerminalDownloadStatus(attempt.status)) continue;
      // Direct downloads own their status already; there is no SABnzbd job
      // to reconcile them against.
      if (attempt.source !== "newznab") continue;
      const historyJob = history.find((job) =>
        job.jobId === attempt.sabJobId || job.marker === attempt.sabMarker);
      const queueJob = queue.find((job) =>
        job.jobId === attempt.sabJobId || job.marker === attempt.sabMarker);
      const job = historyJob ?? queueJob;
      if (!job) continue;
      const status = statusFromJob(historyJob ? "history" : "queue", job.status);
      // Post-processing in progress: leave the attempt untouched so a later
      // poll can still resolve it.
      if (status === null) continue;
      this.dependencies.repository.update(attempt.id, {
        status,
        sabJobId: attempt.sabJobId ?? job.jobId,
        progress: status === "Completed" ? 100 : job.progress,
        failureDetail: status === "Failed" ? job.status : null,
        completedAt: status === "Completed" ? timestamp : null,
        updatedAt: timestamp
      });
    }
  }

  private async reconcileTorrents(
    attempts: DownloadAttempt[],
    timestamp: number
  ): Promise<void> {
    const client = this.dependencies.internetArchiveTorrent?.client();
    if (!client) return;
    const torrents = await client.list();
    for (const attempt of attempts) {
      if (isTerminalDownloadStatus(attempt.status)) continue;
      if (attempt.source !== "internet-archive-torrent") continue;
      const torrent = attempt.torrentHash === null
        ? torrents.find((job) => job.tags.includes(attempt.sabMarker))
        : torrents.find((job) => job.hash === attempt.torrentHash);
      if (!torrent) continue;
      const status = statusFromTorrent(torrent.state);
      if (status === null) continue;
      this.dependencies.repository.update(attempt.id, {
        status,
        progress: status === "Completed"
          ? 100
          : torrentProgress(torrent.progress),
        ...(attempt.torrentHash === null
          ? { torrentHash: torrent.hash }
          : {}),
        failureDetail: status === "Failed" ? torrent.state : null,
        completedAt: status === "Completed" ? timestamp : null,
        updatedAt: timestamp
      });
    }
  }

  recoverStaleSubmissions(maxAgeMs = 60_000): void {
    const timestamp = this.now();
    this.dependencies.repository.recoverStaleSubmitting(
      timestamp - maxAgeMs,
      timestamp
    );
    // A direct download cannot outlive the process, so an Internet Archive
    // attempt whose heartbeat stopped died with the last run. The age cutoff
    // is what distinguishes that from a stream running right now, and it is
    // load-bearing: recovery is re-entrant by design, because a startup pass
    // that finds an unmigrated database defers to a later request (see
    // `recoverOnce` in the downloads composition root). Remove the cutoff and
    // that deferred pass will fail a download that is streaming.
    this.dependencies.repository.recoverStaleInternetArchiveDownloads(
      timestamp - IA_STALE_AFTER_MS,
      timestamp
    );
  }

  private selected(ids?: string[]): DownloadAttempt[] {
    const selected = ids ? new Set(ids) : null;
    return this.dependencies.repository.list()
      .filter((attempt) => !selected || selected.has(attempt.id));
  }

  /**
   * Recomputes the fingerprint from the stored attempt's own source, which is
   * the only reliable record of how the original hash was built — the
   * candidate that produced it may already have expired.
   */
  private assertSameRequest(
    attempt: DownloadAttempt,
    input: SubmitDownloadInput
  ): DownloadAttempt {
    const changedInternetArchiveDelivery =
      (attempt.source === "internet-archive-torrent"
        && input.delivery !== "torrent")
      || (attempt.source === "internet-archive"
        && input.delivery === "torrent");
    if (
      changedInternetArchiveDelivery
      || attempt.requestFingerprint !== fingerprint(input, attempt.source)
    ) {
      throw new AppError(
        "CONFLICT",
        409,
        "Submission key was already used for a different download"
      );
    }
    return attempt;
  }
}
