import { describe, expect, it } from "vitest";

import { InFlightRefreshCoordinator } from "@/features/catalog/refresh-coordinator";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((resolveFn, rejectFn) => {
    resolve = resolveFn;
    reject = rejectFn;
  });
  return { promise, resolve, reject };
}

describe("InFlightRefreshCoordinator", () => {
  it("runs one task for concurrent callers sharing a key", async () => {
    const coordinator = new InFlightRefreshCoordinator();
    const gate = deferred();
    let runs = 0;

    const first = coordinator.run(130, () => {
      runs += 1;
      return gate.promise;
    });
    const second = coordinator.run(130, () => {
      runs += 1;
      return gate.promise;
    });

    gate.resolve();
    await Promise.all([first, second]);

    expect(runs).toBe(1);
  });

  it("runs tasks for different keys independently", async () => {
    const coordinator = new InFlightRefreshCoordinator();
    const keys: number[] = [];

    await Promise.all([
      coordinator.run(130, async () => {
        keys.push(130);
      }),
      coordinator.run(8, async () => {
        keys.push(8);
      })
    ]);

    expect(keys.sort((a, b) => a - b)).toEqual([8, 130]);
  });

  it("allows a new run once the previous one settles", async () => {
    const coordinator = new InFlightRefreshCoordinator();
    let runs = 0;
    const task = async () => {
      runs += 1;
    };

    await coordinator.run(130, task);
    await coordinator.run(130, task);

    expect(runs).toBe(2);
  });

  it("propagates a rejection to every caller and clears the key", async () => {
    const coordinator = new InFlightRefreshCoordinator();
    const gate = deferred();
    const first = coordinator.run(130, () => gate.promise);
    const second = coordinator.run(130, () => gate.promise);

    gate.reject(new Error("upstream down"));

    await expect(first).rejects.toThrow("upstream down");
    await expect(second).rejects.toThrow("upstream down");
    // A failed refresh must not poison the key forever.
    await expect(coordinator.run(130, async () => undefined)).resolves
      .toBeUndefined();
  });

  it("clears the key when the task throws synchronously", async () => {
    const coordinator = new InFlightRefreshCoordinator();

    await expect(coordinator.run(130, () => {
      throw new Error("boom");
    })).rejects.toThrow("boom");

    await expect(coordinator.run(130, async () => undefined)).resolves
      .toBeUndefined();
  });
});
