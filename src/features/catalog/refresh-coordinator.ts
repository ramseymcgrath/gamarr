/**
 * Deduplicates background refreshes by key.
 *
 * `catalogService()` builds a fresh `CatalogService` per request, so a guard
 * held on the service instance would be a new empty map every time and would
 * never dedupe. This is injected from `dependencies.ts` as a module-scoped
 * singleton, the same way `IgdbRequestGate` is.
 */
export interface RefreshCoordinator {
  run(key: number, task: () => Promise<void>): Promise<void>;
}

export class InFlightRefreshCoordinator implements RefreshCoordinator {
  private readonly inFlight = new Map<number, Promise<void>>();

  run(key: number, task: () => Promise<void>): Promise<void> {
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    // `Promise.resolve().then(task)` so a synchronous throw inside `task`
    // still produces a rejected promise, and the `finally` still clears
    // the key rather than wedging it forever.
    const promise = Promise.resolve()
      .then(task)
      .finally(() => {
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, promise);
    return promise;
  }
}
