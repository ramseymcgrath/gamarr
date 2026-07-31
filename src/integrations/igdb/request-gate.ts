export class IgdbRequestGate {
  private nextAvailableAt = 0;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly sleep: (milliseconds: number) => Promise<void> = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
    private readonly intervalMs = 250
  ) {}

  wait(): Promise<void> {
    const turn = this.tail.then(async () => {
      const delay = Math.max(0, this.nextAvailableAt - this.now());
      if (delay > 0) await this.sleep(delay);
      this.nextAvailableAt = this.now() + this.intervalMs;
    });
    this.tail = turn.catch(() => undefined);
    return turn;
  }
}
