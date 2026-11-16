export interface FixtureJob {
  jobId: string;
  marker: string;
  status: string;
  progress: number;
}

export interface FixtureTorrent {
  tag: string;
  polls: number;
}

/** A multi-file torrent added through the collection grab path. */
export interface FixtureCollectionTorrent {
  hash: string;
  tags: string[];
  stopped: boolean;
  files: Array<{ name: string; priority: number }>;
}

export const fixtureState: {
  jobs: FixtureJob[];
  torrent: FixtureTorrent | null;
  collection: FixtureCollectionTorrent | null;
  /** Ordered qBittorrent write calls, so a test can assert their order. */
  qbittorrentCalls: string[];
  reset(): void;
} = {
  jobs: [] as FixtureJob[],
  torrent: null,
  collection: null,
  qbittorrentCalls: [] as string[],
  reset() {
    this.jobs.splice(0);
    this.torrent = null;
    this.collection = null;
    this.qbittorrentCalls.splice(0);
  }
};
