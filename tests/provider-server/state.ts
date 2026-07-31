export interface FixtureJob {
  jobId: string;
  marker: string;
  status: string;
  progress: number;
}

export const fixtureState = {
  jobs: [] as FixtureJob[],
  reset() {
    this.jobs.splice(0);
  }
};
