import type { CollectionsPort } from "@/features/release-search/ports";
import type {
  ReleaseFetcher,
  ReleaseFetchInput
} from "@/integrations/internet-archive/fetch";
import type { FetchedRelease } from "@/integrations/prowlarr/fetch";
import { validationError } from "@/lib/errors";

/**
 * Serves a collection candidate's `.torrent` straight from the operator's
 * folder. The snapshot pins the file the user picked, so a replaced or edited
 * torrent fails instead of silently selecting a different file.
 */
export class CollectionTorrentFetcher implements ReleaseFetcher {
  constructor(private readonly port: CollectionsPort) {}

  async fetch(input: ReleaseFetchInput): Promise<FetchedRelease> {
    const changed = () => validationError("Collection torrent changed; search again");
    let snapshot: {
      collectionId?: unknown;
      fileIndex?: unknown;
      fileName?: unknown;
    };
    try {
      snapshot = JSON.parse(input.candidate.sourceSnapshot) as typeof snapshot;
    } catch {
      throw changed();
    }
    if (
      typeof snapshot.collectionId !== "string"
      || typeof snapshot.fileIndex !== "number"
      || typeof snapshot.fileName !== "string"
    ) {
      throw changed();
    }
    const found = this.port.read(snapshot.collectionId);
    if (found === null) throw changed();
    const file = found.collection.files.find(
      (candidate) => candidate.index === snapshot.fileIndex
    );
    if (file?.name !== snapshot.fileName) throw changed();
    return { kind: "torrent", bytes: found.bytes };
  }
}
