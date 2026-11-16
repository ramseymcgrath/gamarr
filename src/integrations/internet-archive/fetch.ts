import {
  COLLECTION_INDEXER_PREFIX,
  INTERNET_ARCHIVE_INDEXER_ID
} from "@/features/release-search/models";
import type { ReleaseCandidateRecord } from "@/features/release-search/ports";
import type { InternetArchiveClient } from "@/integrations/internet-archive/client";
import { isValidInternetArchiveIdentifier } from "@/integrations/internet-archive/path-policy";
import type { FetchedRelease } from "@/integrations/prowlarr/fetch";
import { AppError } from "@/lib/errors";

export interface ReleaseFetchInput {
  candidate: ReleaseCandidateRecord;
  magnetUrl: string | null;
  maxBytes: number;
}

export interface ReleaseFetcher {
  fetch(input: ReleaseFetchInput): Promise<FetchedRelease>;
}

export function isInternetArchiveCandidate(
  candidate: Pick<ReleaseCandidateRecord, "indexerId">
): boolean {
  return candidate.indexerId === INTERNET_ARCHIVE_INDEXER_ID;
}

/** The identifier is persisted in the candidate snapshot at search time. */
export function internetArchiveIdentifier(
  candidate: Pick<ReleaseCandidateRecord, "sourceSnapshot">
): string {
  let identifier: unknown;
  try {
    identifier = (JSON.parse(candidate.sourceSnapshot) as {
      identifier?: unknown;
    }).identifier;
  } catch {
    identifier = undefined;
  }
  if (
    typeof identifier !== "string"
    || !isValidInternetArchiveIdentifier(identifier)
  ) {
    throw new AppError(
      "UNAVAILABLE",
      502,
      "Internet Archive release is missing its item identifier"
    );
  }
  return identifier;
}

/** Retrieves an Internet Archive candidate's generated `_archive.torrent`. */
export class InternetArchiveTorrentFetcher implements ReleaseFetcher {
  constructor(private readonly client: InternetArchiveClient) {}

  async fetch(input: ReleaseFetchInput): Promise<FetchedRelease> {
    const bytes = await this.client.fetchTorrent(
      internetArchiveIdentifier(input.candidate),
      input.maxBytes
    );
    return { kind: "torrent", bytes };
  }
}

/**
 * Sends collection candidates to the operator's folder, Internet Archive
 * candidates to archive.org and everything else to Prowlarr. With Internet
 * Archive disabled, its stale candidates fail cleanly rather than being
 * misrouted through the Prowlarr download proxy.
 */
export function routeReleaseFetch(input: {
  prowlarr: ReleaseFetcher;
  internetArchive: ReleaseFetcher | null;
  collections: ReleaseFetcher | null;
}): ReleaseFetcher {
  return {
    fetch: async (request) => {
      if (request.candidate.indexerId.startsWith(COLLECTION_INDEXER_PREFIX)) {
        if (input.collections === null) {
          throw new AppError("UNAVAILABLE", 503, "Collections are disabled");
        }
        return input.collections.fetch(request);
      }
      if (!isInternetArchiveCandidate(request.candidate)) {
        return input.prowlarr.fetch(request);
      }
      if (input.internetArchive === null) {
        throw new AppError(
          "UNAVAILABLE",
          503,
          "Internet Archive is disabled"
        );
      }
      return input.internetArchive.fetch(request);
    }
  };
}
