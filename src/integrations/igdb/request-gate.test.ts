import { describe, expect, it } from "vitest";

import { IgdbRequestGate } from "@/integrations/igdb/request-gate";

describe("IgdbRequestGate", () => {
  it("serializes concurrent requests at four per second", async () => {
    let now = 1_000;
    const waits: number[] = [];
    const gate = new IgdbRequestGate(
      () => now,
      async (milliseconds) => {
        waits.push(milliseconds);
        now += milliseconds;
      }
    );

    await Promise.all([gate.wait(), gate.wait(), gate.wait()]);

    expect(waits).toEqual([250, 250]);
  });
});
