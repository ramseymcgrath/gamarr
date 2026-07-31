import { createHash, randomUUID } from "node:crypto";

import type {
  DownloadAttempt,
  DownloadStatus,
  SubmitDownloadInput
} from "@/features/downloads/models";
import {
  SabnzbdUploadError,
  type NzbFetcherPort,
  type SabnzbdPort
} from "@/features/downloads/port";
import type { DownloadRepository } from "@/features/downloads/repository";
import type { CandidateRepository } from "@/features/release-search/ports";
import type { SabnzbdSettingsRecord } from "@/features/settings/models";
import type { SettingsRepository } from "@/features/settings/service";
import { AppError, validationError } from "@/lib/errors";

interface DownloadServiceDependencies {
  repository: DownloadRepository;
  candidates: CandidateRepository;
  settings: SettingsRepository;
  nzbFetcher: NzbFetcherPort;
  sabFactory: (settings: SabnzbdSettingsRecord) => SabnzbdPort;
  now?: () => number;
  id?: () => string;
}

function fingerprint(input: SubmitDownloadInput): string {
  return createHash("sha256")
    .update(JSON.stringify([
      input.candidateId,
      input.gameId,
      input.platformId
    ]))
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

  constructor(private readonly dependencies: DownloadServiceDependencies) {
    this.now = dependencies.now ?? Date.now;
    this.id = dependencies.id ?? randomUUID;
  }

  async submit(input: SubmitDownloadInput): Promise<DownloadAttempt> {
    if (
      !input.submissionKey.trim() ||
      !Number.isInteger(input.gameId) ||
      !Number.isInteger(input.platformId)
    ) {
      throw validationError("Invalid download submission");
    }
    const requestFingerprint = fingerprint(input);
    const existing = this.dependencies.repository
      .findBySubmissionKey(input.submissionKey);
    if (existing) return this.assertSameRequest(existing, requestFingerprint);

    const candidate = this.dependencies.candidates.get(input.candidateId);
    if (!candidate) throw validationError("Release candidate has expired");
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
        releaseTitle: candidate.title,
        indexerId: indexer.id,
        indexerNameSnapshot: snapshot.indexerName ?? indexer.name,
        indexerUrlSnapshot: snapshot.origin ?? new URL(indexer.baseUrl).origin,
        newznabGuid: candidate.guid,
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
      return this.assertSameRequest(claimed.attempt, requestFingerprint);
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
        failureDetail: error instanceof Error ? error.message : "NZB retrieval failed",
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

  async reconcile(ids?: string[]): Promise<DownloadAttempt[]> {
    const settings = this.dependencies.settings.getSabnzbd();
    if (!settings?.apiKey) return [];
    const sab = this.dependencies.sabFactory(settings);
    let queue;
    let history;
    try {
      [queue, history] = await Promise.all([
        sab.getQueue(),
        sab.getHistory()
      ]);
    } catch {
      return this.selected(ids);
    }
    const timestamp = this.now();
    for (const attempt of this.selected(ids)) {
      if (attempt.status === "Completed" || attempt.status === "Failed") continue;
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
    return this.selected(ids);
  }

  recoverStaleSubmissions(maxAgeMs = 60_000): void {
    const timestamp = this.now();
    this.dependencies.repository.recoverStaleSubmitting(
      timestamp - maxAgeMs,
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
    requestFingerprint: string
  ): DownloadAttempt {
    if (attempt.requestFingerprint !== requestFingerprint) {
      throw new AppError(
        "CONFLICT",
        409,
        "Submission key was already used for a different download"
      );
    }
    return attempt;
  }
}
