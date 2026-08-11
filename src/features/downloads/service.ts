import { createHash, randomUUID } from "node:crypto";

import {
  isTerminalDownloadStatus,
  type AttemptSourceType,
  type DownloadAttempt,
  type DownloadStatus,
  type SelectedFile,
  type SubmitDownloadInput
} from "@/features/downloads/models";
import {
  SabnzbdUploadError,
  type ReleaseFetcherPort,
  type SabnzbdPort,
  TorrentAddError,
  type TorrentClientPort
} from "@/features/downloads/port";
import type { DownloadRepository } from "@/features/downloads/repository";
import type {
  CandidateRepository,
  ReleaseCandidateRecord
} from "@/features/release-search/ports";
import type { SabnzbdSettingsRecord } from "@/features/settings/models";
import type { SettingsRepository } from "@/features/settings/service";
// Pure validation module with no I/O; importing it across the feature boundary
// is the deliberate exception documented in CLAUDE.md.
import { decodeTorrentFiles } from "@/integrations/prowlarr/metainfo";
import { AppError, validationError } from "@/lib/errors";

interface DownloadServiceDependencies {
  repository: DownloadRepository;
  candidates: CandidateRepository;
  settings: SettingsRepository;
  releaseFetcher: ReleaseFetcherPort;
  sabFactory: (settings: SabnzbdSettingsRecord) => SabnzbdPort;
  torrentClient: () => TorrentClientPort | null;
  maxTorrentBytes: number;
  now?: () => number;
  id?: () => string;
}

interface CandidateSnapshot {
  indexerName: string | null;
  origin: string | null;
  magnetUrl: string | null;
}

function parseCandidateSnapshot(value: string): CandidateSnapshot {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null) {
      return { indexerName: null, origin: null, magnetUrl: null };
    }
    const record = parsed as Record<string, unknown>;
    return {
      indexerName: typeof record.indexerName === "string"
        ? record.indexerName
        : null,
      origin: typeof record.origin === "string" ? record.origin : null,
      // Candidates minted before Task 9 did not carry this field. Invalid or
      // absent values intentionally fall back to the Prowlarr download proxy.
      magnetUrl: typeof record.magnetUrl === "string"
        ? record.magnetUrl
        : null
    };
  } catch {
    return { indexerName: null, origin: null, magnetUrl: null };
  }
}

function selectedIndices(input: SubmitDownloadInput): number[] {
  const indices = input.selectedFiles ?? [];
  if (indices.some((index) => !Number.isInteger(index) || index < 0)) {
    throw validationError("Invalid torrent file selection");
  }
  return [...indices].sort((left, right) => left - right);
}

function fingerprintParts(
  source: AttemptSourceType,
  input: SubmitDownloadInput,
  legacy: { iaFileName: string | null }
): Array<string | number> {
  switch (source) {
    case "prowlarr-usenet":
      return [input.candidateId, input.gameId, input.platformId];
    case "prowlarr-torrent":
      return [
        input.candidateId,
        input.gameId,
        input.platformId,
        "torrent",
        ...selectedIndices(input)
      ];
    case "newznab":
      return [input.candidateId, input.gameId, input.platformId];
    case "internet-archive":
      return [
        input.candidateId,
        input.gameId,
        input.platformId,
        legacy.iaFileName ?? ""
      ];
    case "internet-archive-torrent":
      return [input.candidateId, input.gameId, input.platformId, "torrent"];
  }
}

function fingerprint(
  source: AttemptSourceType,
  input: SubmitDownloadInput,
  legacy: { iaFileName: string | null }
): string {
  return createHash("sha256")
    .update(JSON.stringify(fingerprintParts(source, input, legacy)))
    .digest("hex");
}

const historySuccess = ["completed", "completed/pp", "completed/unpack"];

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

function submittedNothing(error: unknown): boolean {
  if (error instanceof SabnzbdUploadError) return error.outcome === "rejected";
  return error instanceof AppError && error.code === "VALIDATION";
}

export class DownloadService {
  private readonly now: () => number;
  private readonly id: () => string;

  constructor(private readonly dependencies: DownloadServiceDependencies) {
    this.now = dependencies.now ?? Date.now;
    this.id = dependencies.id ?? randomUUID;
  }

  async submit(input: SubmitDownloadInput): Promise<DownloadAttempt> {
    if (
      !input.submissionKey.trim()
      || !Number.isInteger(input.gameId)
      || !Number.isInteger(input.platformId)
    ) {
      throw validationError("Invalid download submission");
    }
    selectedIndices(input);

    // Replay before candidate lookup: candidates expire, attempts do not.
    const existing = this.dependencies.repository
      .findBySubmissionKey(input.submissionKey);
    if (existing) return this.assertSameRequest(existing, input);

    const candidate = this.dependencies.candidates.get(input.candidateId);
    if (!candidate) throw validationError("Release candidate has expired");
    const prowlarr = this.dependencies.settings.getProwlarr();
    if (!prowlarr?.apiKey) {
      throw validationError("Prowlarr is not configured");
    }
    if (prowlarr.configRevision !== candidate.indexerConfigRevision) {
      throw validationError("Prowlarr configuration changed; search again");
    }

    return candidate.protocol === "usenet"
      ? this.submitUsenet(input, candidate)
      : this.submitTorrent(input, candidate);
  }

  private claim(
    input: SubmitDownloadInput,
    candidate: ReleaseCandidateRecord,
    source: "prowlarr-usenet" | "prowlarr-torrent",
    category: string | null,
    sabnzbdConfigRevision: number
  ) {
    const snapshot = parseCandidateSnapshot(candidate.sourceSnapshot);
    const timestamp = this.now();
    const attemptId = this.id();
    const marker = `gamarr-${attemptId}`;
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
        requestFingerprint: fingerprint(source, input, { iaFileName: null }),
        status: "Pending",
        source,
        releaseTitle: candidate.title,
        indexerId: candidate.indexerId,
        indexerNameSnapshot: snapshot.indexerName ?? "Prowlarr indexer",
        indexerUrlSnapshot: snapshot.origin,
        newznabGuid: candidate.guid,
        iaFileName: null,
        torrentHash: null,
        selectedFiles: source === "prowlarr-torrent" ? [] : null,
        filesAppliedAt: null,
        size: candidate.size,
        category,
        sabnzbdConfigRevision,
        marker,
        sabJobId: null,
        progress: 0,
        failureDetail: null,
        sabRequestStartedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        completedAt: null
      }
    });
    return { ...claimed, snapshot };
  }

  private async submitUsenet(
    input: SubmitDownloadInput,
    candidate: ReleaseCandidateRecord
  ): Promise<DownloadAttempt> {
    const sabSettings = this.dependencies.settings.getSabnzbd();
    if (!sabSettings?.apiKey) {
      throw validationError("SABnzbd is not configured");
    }
    const claimed = this.claim(
      input,
      candidate,
      "prowlarr-usenet",
      sabSettings.defaultCategory,
      sabSettings.configRevision
    );
    if (!claimed.created) {
      return this.assertSameRequest(claimed.attempt, input);
    }

    let fetched: Awaited<ReturnType<ReleaseFetcherPort["fetch"]>>;
    try {
      fetched = await this.dependencies.releaseFetcher.fetch({
        candidate,
        magnetUrl: claimed.snapshot.magnetUrl,
        maxBytes: sabSettings.maxNzbBytes
      });
    } catch (error) {
      return this.failFetch(claimed.attempt.id, error);
    }
    if (fetched.kind !== "nzb") {
      return this.dependencies.repository.update(claimed.attempt.id, {
        status: "Failed",
        failureDetail: "Prowlarr returned an unexpected release payload",
        updatedAt: this.now()
      });
    }

    const submittingAt = this.now();
    this.dependencies.repository.update(claimed.attempt.id, {
      status: "Submitting",
      sabRequestStartedAt: submittingAt,
      updatedAt: submittingAt
    });
    try {
      const result = await this.dependencies.sabFactory(sabSettings).upload({
        filename: `gamarr-${claimed.attempt.id}.nzb`,
        bytes: fetched.bytes,
        category: sabSettings.defaultCategory,
        marker: claimed.attempt.marker
      });
      return this.dependencies.repository.update(claimed.attempt.id, {
        status: "Queued",
        sabJobId: result.jobId,
        updatedAt: this.now()
      });
    } catch (error) {
      const rejected = submittedNothing(error);
      return this.dependencies.repository.update(claimed.attempt.id, {
        status: rejected ? "Failed" : "Unknown",
        failureDetail: rejected && error instanceof Error
          ? error.message
          : "SABnzbd acknowledgement was not confirmed",
        updatedAt: this.now()
      });
    }
  }

  private async submitTorrent(
    input: SubmitDownloadInput,
    candidate: ReleaseCandidateRecord
  ): Promise<DownloadAttempt> {
    const qbitSettings = this.dependencies.settings.getQbittorrent();
    const client = this.dependencies.torrentClient();
    if (!qbitSettings?.password || !client) {
      throw validationError("qBittorrent is not configured");
    }
    const claimed = this.claim(
      input,
      candidate,
      "prowlarr-torrent",
      qbitSettings.defaultCategory,
      0
    );
    if (!claimed.created) {
      return this.assertSameRequest(claimed.attempt, input);
    }

    let fetched: Awaited<ReturnType<ReleaseFetcherPort["fetch"]>>;
    try {
      fetched = await this.dependencies.releaseFetcher.fetch({
        candidate,
        magnetUrl: claimed.snapshot.magnetUrl,
        maxBytes: this.dependencies.maxTorrentBytes
      });
    } catch (error) {
      return this.failFetch(claimed.attempt.id, error);
    }

    const indices = selectedIndices(input);
    let selectedFiles: SelectedFile[] = [];
    let payload: { torrent: Uint8Array; filename: string } | { magnet: string };
    if (fetched.kind === "magnet") {
      if (indices.length > 0) {
        this.rejectClaim(
          claimed.attempt.id,
          "File selection is not available for a magnet release"
        );
      }
      payload = { magnet: fetched.uri };
    } else if (fetched.kind === "torrent") {
      let files: ReturnType<typeof decodeTorrentFiles>;
      try {
        files = decodeTorrentFiles(fetched.bytes);
      } catch (error) {
        return this.failFetch(claimed.attempt.id, error);
      }
      selectedFiles = indices.map((index) => {
        const file = files.find((value) => value.index === index);
        if (!file) {
          this.rejectClaim(
            claimed.attempt.id,
            "Selected torrent file is not available"
          );
        }
        return { index, name: file.name };
      });
      payload = {
        torrent: fetched.bytes,
        filename: `gamarr-${claimed.attempt.id}.torrent`
      };
    } else {
      return this.dependencies.repository.update(claimed.attempt.id, {
        status: "Failed",
        failureDetail: "Prowlarr returned an unexpected release payload",
        updatedAt: this.now()
      });
    }

    const submittingAt = this.now();
    this.dependencies.repository.update(claimed.attempt.id, {
      status: "Submitting",
      selectedFiles,
      sabRequestStartedAt: submittingAt,
      updatedAt: submittingAt
    });
    try {
      const result = await client.add({
        payload,
        category: qbitSettings.defaultCategory,
        tag: claimed.attempt.marker
      });
      return this.dependencies.repository.update(claimed.attempt.id, {
        status: "Queued",
        torrentHash: result.hash,
        updatedAt: this.now()
      });
    } catch (error) {
      if (error instanceof TorrentAddError) {
        return this.dependencies.repository.update(claimed.attempt.id, {
          status: error.outcome === "rejected" ? "Failed" : "Unknown",
          failureDetail: error.message,
          updatedAt: this.now()
        });
      }
      return this.dependencies.repository.update(claimed.attempt.id, {
        status: "Unknown",
        failureDetail: "qBittorrent acknowledgement was not confirmed",
        updatedAt: this.now()
      });
    }
  }

  private failFetch(id: string, error: unknown): DownloadAttempt {
    return this.dependencies.repository.update(id, {
      status: "Failed",
      failureDetail: error instanceof AppError
        ? error.message
        : "Release payload retrieval failed",
      updatedAt: this.now()
    });
  }

  private rejectClaim(id: string, message: string): never {
    this.dependencies.repository.update(id, {
      status: "Failed",
      failureDetail: message,
      updatedAt: this.now()
    });
    throw validationError(message);
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
      if (
        attempt.source !== "prowlarr-usenet"
        && attempt.source !== "newznab"
      ) continue;
      const historyJob = history.find((job) =>
        job.jobId === attempt.sabJobId || job.marker === attempt.marker);
      const queueJob = queue.find((job) =>
        job.jobId === attempt.sabJobId || job.marker === attempt.marker);
      const job = historyJob ?? queueJob;
      if (!job) continue;
      const status = statusFromJob(historyJob ? "history" : "queue", job.status);
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
    const client = this.dependencies.torrentClient();
    if (!client) return;
    const torrents = await client.list();
    for (const attempt of attempts) {
      if (isTerminalDownloadStatus(attempt.status)) continue;
      // Task 11 widens this to Prowlarr torrents and applies file priorities.
      if (attempt.source !== "internet-archive-torrent") continue;
      const torrent = attempt.torrentHash === null
        ? torrents.find((job) => job.tags.includes(attempt.marker))
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
    this.dependencies.repository.recoverStaleInternetArchiveDownloads(
      timestamp - 60_000,
      timestamp
    );
  }

  private selected(ids?: string[]): DownloadAttempt[] {
    const selected = ids ? new Set(ids) : null;
    return this.dependencies.repository.list()
      .filter((attempt) => !selected || selected.has(attempt.id));
  }

  private assertSameRequest(
    attempt: DownloadAttempt,
    input: SubmitDownloadInput
  ): DownloadAttempt {
    if (
      attempt.requestFingerprint !== fingerprint(
        attempt.source,
        input,
        { iaFileName: attempt.iaFileName }
      )
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
