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
import {
  COLLECTION_INDEXER_PREFIX,
  INTERNET_ARCHIVE_INDEXER_ID
} from "@/features/release-search/models";
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
  /**
   * Told which attempts this reconcile moved to `Completed`, after the pass
   * finishes. Used to queue Redump verification; must not throw.
   */
  onCompleted?: (attemptIds: string[]) => void;
  id?: () => string;
  /** Waits between `listFiles` polls after a collection add. */
  sleep?: (ms: number) => Promise<void>;
}

const COLLECTION_CHANGED = "Collection torrent changed; search again";
const OTHER_FILES_ENABLED =
  "Other files in this collection are enabled in qBittorrent; "
  + "set them to Do not download, then retry";
/**
 * 20 polls with a 500 ms wait before each retry (19 waits, 9.5 s): qBittorrent
 * gets under 10 s to list a freshly added torrent.
 */
const FILE_LIST_POLLS = 20;
const FILE_LIST_POLL_MS = 500;

interface CollectionSnapshot {
  indexerName: string | null;
  hash: string;
  file: SelectedFile;
}

function parseCollectionSnapshot(value: string): CollectionSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.collectionId !== "string"
    || !/^[0-9a-f]{40}$/.test(record.collectionId)
    || typeof record.fileIndex !== "number"
    || !Number.isInteger(record.fileIndex)
    || record.fileIndex < 0
    || typeof record.fileName !== "string"
    || record.fileName === ""
  ) {
    return null;
  }
  return {
    indexerName: typeof record.indexerName === "string"
      ? record.indexerName
      : null,
    hash: record.collectionId,
    file: { index: record.fileIndex, name: record.fileName }
  };
}

/**
 * qBittorrent names a multi-file torrent's files with the root folder in
 * front, while the snapshot holds the name inside the root. Accept the exact
 * name (a single-file torrent, or one added without its root folder) or the
 * name with exactly one leading segment removed. Nothing fuzzier.
 */
export function collectionFileMatches(qbitName: string, fileName: string): boolean {
  if (qbitName === fileName) return true;
  const slash = qbitName.indexOf("/");
  return slash > 0 && qbitName.slice(slash + 1) === fileName;
}

type TorrentFileList = Awaited<ReturnType<TorrentClientPort["listFiles"]>>;

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

export function fingerprintParts(
  source: AttemptSourceType,
  input: SubmitDownloadInput,
  legacy: { iaFileName: string | null; collectionFileIndex: number | null }
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
      // Selected indices are appended like `prowlarr-torrent`; a request with
      // no selection (every legacy attempt) hashes exactly as it always has.
      return [
        input.candidateId,
        input.gameId,
        input.platformId,
        "torrent",
        ...selectedIndices(input)
      ];
    case "collection-torrent":
      return [
        input.candidateId,
        input.gameId,
        input.platformId,
        "torrent",
        legacy.collectionFileIndex ?? -1
      ];
  }
}

function fingerprint(
  source: AttemptSourceType,
  input: SubmitDownloadInput,
  legacy: { iaFileName: string | null; collectionFileIndex: number | null }
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
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly dependencies: DownloadServiceDependencies) {
    this.now = dependencies.now ?? Date.now;
    this.id = dependencies.id ?? randomUUID;
    this.sleep = dependencies.sleep
      ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
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

    if (candidate.indexerId.startsWith(COLLECTION_INDEXER_PREFIX)) {
      return this.submitCollection(input, candidate);
    }
    return candidate.protocol === "usenet"
      ? this.submitUsenet(input, candidate)
      : this.submitTorrent(input, candidate);
  }

  private claim(
    input: SubmitDownloadInput,
    candidate: ReleaseCandidateRecord,
    source:
      | "prowlarr-usenet"
      | "prowlarr-torrent"
      | "internet-archive-torrent"
      | "collection-torrent",
    category: string | null,
    sabnzbdConfigRevision: number,
    collection: CollectionSnapshot | null = null
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
        requestFingerprint: fingerprint(source, input, {
          iaFileName: null,
          collectionFileIndex: collection?.file.index ?? null
        }),
        status: "Pending",
        source,
        releaseTitle: candidate.title,
        indexerId: candidate.indexerId,
        indexerNameSnapshot: snapshot.indexerName ?? "Prowlarr indexer",
        indexerUrlSnapshot: snapshot.origin,
        newznabGuid: candidate.guid,
        iaFileName: null,
        // A collection attempt owns its file from the moment it is claimed,
        // so a concurrent grab's safety check already counts it.
        torrentHash: collection?.hash ?? null,
        selectedFiles: collection
          ? [collection.file]
          : source === "prowlarr-usenet" ? null : [],
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
      candidate.indexerId === INTERNET_ARCHIVE_INDEXER_ID
        ? "internet-archive-torrent"
        : "prowlarr-torrent",
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

  /**
   * Grabs one file out of a shared collection torrent. The torrent must never
   * run while a file nobody asked for is wanted, so `start` is the last call
   * and only follows a passing safety check; every failure leaves a torrent
   * this method added stopped.
   */
  private async submitCollection(
    input: SubmitDownloadInput,
    candidate: ReleaseCandidateRecord
  ): Promise<DownloadAttempt> {
    if (input.selectedFiles !== undefined) {
      throw validationError("Collection file selection is fixed");
    }
    const collection = parseCollectionSnapshot(candidate.sourceSnapshot);
    if (!collection) throw validationError(COLLECTION_CHANGED);
    const qbitSettings = this.dependencies.settings.getQbittorrent();
    const client = this.dependencies.torrentClient();
    if (!qbitSettings?.password || !client) {
      throw validationError("qBittorrent is not configured");
    }
    const claimed = this.claim(
      input,
      candidate,
      "collection-torrent",
      qbitSettings.defaultCategory,
      0,
      collection
    );
    if (!claimed.created) {
      return this.assertSameRequest(claimed.attempt, input);
    }

    let fetched: Awaited<ReturnType<ReleaseFetcherPort["fetch"]>>;
    try {
      fetched = await this.dependencies.releaseFetcher.fetch({
        candidate,
        magnetUrl: null,
        maxBytes: this.dependencies.maxTorrentBytes
      });
    } catch (error) {
      return this.failFetch(claimed.attempt.id, error);
    }
    if (fetched.kind !== "torrent") {
      return this.dependencies.repository.update(claimed.attempt.id, {
        status: "Failed",
        failureDetail: COLLECTION_CHANGED,
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
      await this.applyCollection(client, {
        attempt: claimed.attempt,
        collection,
        bytes: fetched.bytes,
        category: qbitSettings.defaultCategory
      });
    } catch (error) {
      return this.dependencies.repository.update(claimed.attempt.id, {
        status: "Failed",
        failureDetail: error instanceof AppError
          ? error.message
          : "qBittorrent did not accept the collection grab",
        updatedAt: this.now()
      });
    }
    // 6b. Only reached once the safety check passed. A failed start may
    // still have started the torrent, so the outcome is Unknown, not Failed.
    try {
      await client.start(collection.hash);
    } catch {
      return this.dependencies.repository.update(claimed.attempt.id, {
        status: "Unknown",
        failureDetail: "qBittorrent start was not confirmed",
        updatedAt: this.now()
      });
    }
    const appliedAt = this.now();
    return this.dependencies.repository.update(claimed.attempt.id, {
      status: "Downloading",
      filesAppliedAt: appliedAt,
      updatedAt: appliedAt
    });
  }

  /**
   * Spec steps 1-6 up to, not including, `start`. Throws on any failure;
   * returning normally means the safety check passed.
   */
  private async applyCollection(
    client: TorrentClientPort,
    input: {
      attempt: DownloadAttempt;
      collection: CollectionSnapshot;
      bytes: Uint8Array;
      category: string | null;
    }
  ): Promise<void> {
    const { attempt, collection } = input;
    const { hash, file } = collection;

    // 1. Is the torrent already loaded?
    let loaded = await this.torrentLoaded(client, hash);

    // 2. Not loaded: add it stopped, then switch every file off before
    //    anything else touches it.
    if (!loaded) {
      try {
        const added = await client.add({
          payload: {
            torrent: input.bytes,
            filename: `gamarr-${attempt.id}.torrent`
          },
          category: input.category,
          tag: attempt.marker,
          stopped: true
        });
        if (added.hash === null) {
          // qBittorrent 5.3 names every clean add in `added_torrent_ids`, so
          // no hash means a duplicate or an unconfirmed add. Treat it as
          // already loaded: nothing is zeroed, only the target is raised.
          loaded = true;
        } else if (added.hash.toLowerCase() !== hash) {
          throw validationError(COLLECTION_CHANGED);
        }
      } catch (error) {
        // qBittorrent answers 409 when it already has the torrent (a
        // concurrent grab won the add). Only that case takes the
        // already-loaded path, and only once `list` confirms it.
        if (
          !(error instanceof TorrentAddError)
          || error.outcome !== "rejected"
          || !(await this.torrentLoaded(client, hash))
        ) {
          throw error;
        }
        loaded = true;
      }
    }

    let files: TorrentFileList;
    if (loaded) {
      // 3. Shared torrent: one marker tag per attempt.
      await client.addTags(hash, attempt.marker);
      files = await this.pollFiles(client, hash);
    } else {
      files = await this.pollFiles(client, hash);
      // Every file except those of other grabs still in flight
      // (`Submitting`), which may have raced this add and raised their file.
      // Completed, Downloading and Unknown owners are stale once the torrent
      // was gone, so their files are zeroed: skipping them would re-download
      // every past grab.
      const inFlight = this.inFlightCollectionFiles(hash, attempt.id);
      const zero = files
        .map((entry) => entry.index)
        .filter((index) => !inFlight.has(index));
      if (zero.length > 0) await client.setFilePriorities(hash, zero, 0);
    }

    // 4. The file at the pinned index must still be the one the user chose.
    const target = files.find((entry) => entry.index === file.index);
    if (!target || !collectionFileMatches(target.name, file.name)) {
      throw validationError(COLLECTION_CHANGED);
    }

    // Already loaded: refuse before raising anything if an unowned file is
    // wanted, so a failed grab does not leave its own file enabled on a
    // torrent that may be running.
    if (loaded) this.assertOnlyOwnedFilesWanted(hash, files);

    // 5. Raise only the target. Nothing on a loaded torrent is ever lowered.
    await client.setFilePriorities(hash, [file.index], 1);

    // 6. Safety check on a fresh read, then start.
    const after = await client.listFiles(hash);
    const own = after.find((entry) => entry.index === file.index);
    if (!own || own.priority <= 0) {
      throw new AppError(
        "UNAVAILABLE",
        502,
        "qBittorrent did not apply the file selection"
      );
    }
    this.assertOnlyOwnedFilesWanted(hash, after);
  }

  private async torrentLoaded(
    client: TorrentClientPort,
    hash: string
  ): Promise<boolean> {
    const torrents = await client.list();
    return torrents.some((torrent) => torrent.hash.toLowerCase() === hash);
  }

  /** NOT_FOUND and an empty list both mean "qBittorrent is not ready yet". */
  private async pollFiles(
    client: TorrentClientPort,
    hash: string
  ): Promise<TorrentFileList> {
    for (let poll = 0; poll < FILE_LIST_POLLS; poll += 1) {
      if (poll > 0) await this.sleep(FILE_LIST_POLL_MS);
      try {
        const files = await client.listFiles(hash);
        if (files.length > 0) return files;
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== "NOT_FOUND") {
          throw error;
        }
      }
    }
    throw new AppError(
      "UNAVAILABLE",
      504,
      "qBittorrent did not list the collection's files in time"
    );
  }

  /**
   * File indices claimed by `collection-torrent` attempts on this hash that
   * have not failed. Completed attempts still own their file: switching it
   * off would stop it seeding, and it is the operator's, not ours, to drop.
   */
  private ownedCollectionFiles(hash: string): Set<number> {
    const owned = new Set<number>();
    for (const attempt of this.dependencies.repository.listByTorrentHash(hash)) {
      if (attempt.source !== "collection-torrent") continue;
      if (attempt.status === "Failed") continue;
      const index = attempt.selectedFiles?.[0]?.index;
      if (index !== undefined) owned.add(index);
    }
    return owned;
  }

  /** Files of other collection grabs on this hash that are mid-submit. */
  private inFlightCollectionFiles(hash: string, exceptId: string): Set<number> {
    const inFlight = new Set<number>();
    for (const attempt of this.dependencies.repository.listByTorrentHash(hash)) {
      if (attempt.source !== "collection-torrent") continue;
      if (attempt.status !== "Submitting") continue;
      if (attempt.id === exceptId) continue;
      const index = attempt.selectedFiles?.[0]?.index;
      if (index !== undefined) inFlight.add(index);
    }
    return inFlight;
  }

  private assertOnlyOwnedFilesWanted(
    hash: string,
    files: TorrentFileList
  ): void {
    // This attempt is claimed and Submitting, so it owns its own file here.
    // A fully downloaded file has nothing left to fetch, so it never blocks.
    const owned = this.ownedCollectionFiles(hash);
    const offenders = files.filter((entry) =>
      entry.priority > 0 && entry.progress < 1 && !owned.has(entry.index));
    if (offenders.length === 0) return;
    // Base names only, on one line: the message is shown as a failure detail.
    const names = offenders
      .slice(0, 3)
      .map((entry) =>
        (entry.name.split("/").at(-1) ?? entry.name).replace(/\s+/g, " "))
      .join(", ");
    const more = offenders.length > 3
      ? ` and ${offenders.length - 3} more`
      : "";
    throw validationError(
      `${OTHER_FILES_ENABLED} (or remove the stopped torrent). `
        + `Enabled: ${names}${more}`
    );
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
    const reconciled = this.selected(ids);
    if (this.dependencies.onCompleted) {
      const wasCompleted = new Set(attempts
        .filter((attempt) => attempt.status === "Completed")
        .map((attempt) => attempt.id));
      const completed = reconciled
        .filter((attempt) =>
          attempt.status === "Completed" && !wasCompleted.has(attempt.id))
        .map((attempt) => attempt.id);
      if (completed.length > 0) this.dependencies.onCompleted(completed);
    }
    return reconciled;
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
    await this.reconcileCollections(client, torrents, attempts, timestamp);
    for (const attempt of attempts) {
      if (isTerminalDownloadStatus(attempt.status)) continue;
      if (
        attempt.source !== "prowlarr-torrent"
        && attempt.source !== "internet-archive-torrent"
      ) continue;
      const torrent = attempt.torrentHash === null
        ? torrents.find((job) => job.tags.includes(attempt.marker))
        : torrents.find((job) => job.hash === attempt.torrentHash);
      let reconciled = attempt;
      if (torrent) {
        const status = statusFromTorrent(torrent.state);
        if (status !== null) {
          reconciled = this.dependencies.repository.update(attempt.id, {
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

      if (isTerminalDownloadStatus(reconciled.status)) continue;
      if (
        !reconciled.selectedFiles?.length
        || reconciled.filesAppliedAt !== null
      ) continue;
      const hash = reconciled.torrentHash ?? torrent?.hash;
      if (!hash) continue;

      const files = await client.listFiles(hash);
      if (files.length === 0) continue;

      const namesMatch = reconciled.selectedFiles.every((selected) =>
        files.find((file) => file.index === selected.index)?.name
          === selected.name);
      if (!namesMatch) {
        this.dependencies.repository.update(attempt.id, {
          failureDetail: "Torrent file list did not match the selection",
          updatedAt: timestamp
        });
        continue;
      }

      const selected = new Set(
        reconciled.selectedFiles.map((file) => file.index)
      );
      const unselectedIndices = files
        .filter((file) => !selected.has(file.index))
        .map((file) => file.index);
      if (unselectedIndices.length > 0) {
        await client.setFilePriorities(hash, unselectedIndices, 0);
      }
      this.dependencies.repository.update(attempt.id, {
        filesAppliedAt: timestamp,
        updatedAt: timestamp
      });
    }
  }

  /**
   * Collection attempts share one torrent and each owns one file, so they are
   * matched by hash and judged by their own file's progress, never the
   * torrent's. File priorities are never touched here.
   */
  private async reconcileCollections(
    client: TorrentClientPort,
    torrents: Awaited<ReturnType<TorrentClientPort["list"]>>,
    attempts: DownloadAttempt[],
    timestamp: number
  ): Promise<void> {
    const fileLists = new Map<string, Promise<TorrentFileList | null>>();
    const filesOf = (hash: string) => {
      let pending = fileLists.get(hash);
      if (!pending) {
        pending = client.listFiles(hash).catch((error: unknown) => {
          if (error instanceof AppError && error.code === "NOT_FOUND") {
            return null;
          }
          throw error;
        });
        fileLists.set(hash, pending);
      }
      return pending;
    };
    const fail = (id: string, detail: string) =>
      this.dependencies.repository.update(id, {
        status: "Failed",
        failureDetail: detail,
        completedAt: null,
        updatedAt: timestamp
      });

    for (const attempt of attempts) {
      if (attempt.source !== "collection-torrent") continue;
      if (isTerminalDownloadStatus(attempt.status)) continue;
      const { torrentHash: hash } = attempt;
      const selected = attempt.selectedFiles?.[0];
      if (!hash || !selected) continue;

      // A grab still in flight owns its row until `submit` settles it.
      if (attempt.status === "Submitting" || attempt.status === "Pending") {
        continue;
      }

      const torrent = torrents.find((job) =>
        job.hash.toLowerCase() === hash.toLowerCase());
      if (!torrent) {
        fail(attempt.id, "Torrent was removed from qBittorrent");
        continue;
      }
      if (torrent.state === "error" || torrent.state === "missingFiles") {
        fail(attempt.id, torrent.state);
        continue;
      }

      let files: TorrentFileList | null;
      try {
        files = await filesOf(hash);
      } catch {
        continue;
      }
      if (files === null) {
        fail(attempt.id, "Torrent was removed from qBittorrent");
        continue;
      }
      const file = files.find((entry) => entry.index === selected.index);
      if (!file || !collectionFileMatches(file.name, selected.name)) {
        fail(attempt.id, COLLECTION_CHANGED);
        continue;
      }

      if (file.progress >= 1) {
        this.dependencies.repository.update(attempt.id, {
          status: "Completed",
          progress: 100,
          failureDetail: null,
          completedAt: timestamp,
          updatedAt: timestamp
        });
        continue;
      }
      const stopped = torrent.state === "stoppedDL"
        || torrent.state === "pausedDL";
      this.dependencies.repository.update(attempt.id, {
        status: "Downloading",
        progress: torrentProgress(file.progress * 100),
        failureDetail: stopped ? "Stopped in qBittorrent" : null,
        completedAt: null,
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
    this.dependencies.repository.recoverStaleInternetArchiveDownloads(timestamp);
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
        {
          iaFileName: attempt.iaFileName,
          collectionFileIndex: attempt.selectedFiles?.[0]?.index ?? null
        }
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
