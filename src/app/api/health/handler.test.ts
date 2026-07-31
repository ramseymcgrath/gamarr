import { describe, expect, it } from "vitest";

import { healthResponse } from "@/app/api/health/handler";

describe("healthResponse", () => {
  it("reports a healthy database", async () => {
    const response = await healthResponse({ probe: () => undefined });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", database: "ok" });
  });

  it("reports an unhealthy database without leaking the failure", async () => {
    const response = await healthResponse({
      probe: () => {
        throw new Error("disk path /secret/config");
      }
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "error", database: "error" });
  });
});
