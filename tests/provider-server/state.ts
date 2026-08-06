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

export const fixtureState: {
  jobs: FixtureJob[];
  torrent: FixtureTorrent | null;
  reset(): void;
} = {
  jobs: [] as FixtureJob[],
  torrent: null,
  reset() {
    this.jobs.splice(0);
    this.torrent = null;
  }
};
