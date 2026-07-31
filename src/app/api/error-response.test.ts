import { describe, expect, it } from "vitest";

import { errorResponse } from "@/app/api/error-response";
import { AppError } from "@/lib/errors";

function corrupt(status: unknown): AppError {
  return Object.assign(
    new AppError("UNAVAILABLE", 502, "IGDB request failed"),
    { status }
  );
}

describe("errorResponse", () => {
  it("clamps a missing status to 500 rather than defaulting to 200", async () => {
    const response = errorResponse(corrupt(undefined));

    expect(response.status).toBe(500);
    expect(response.ok).toBe(false);
    await expect(response.json()).resolves.toEqual({
      error: { code: "UNAVAILABLE", message: "IGDB request failed" }
    });
  });

  it.each([200, 204, 302, 399, 600, Number.NaN, 1.5])(
    "clamps out-of-range status %p to 500",
    (status) => {
      expect(errorResponse(corrupt(status)).status).toBe(500);
    }
  );

  it.each([400, 401, 403, 404, 409, 502, 599])(
    "preserves valid error status %p",
    (status) => {
      expect(errorResponse(corrupt(status)).status).toBe(status);
    }
  );

  it("falls back to INTERNAL 500 for a non-AppError", async () => {
    const response = errorResponse(new Error("boom"));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: { code: "INTERNAL", message: "Unexpected server error" }
    });
  });

  it("uses the supplied fallback for a non-AppError", async () => {
    const response = errorResponse(new Error("boom"), {
      code: "UNAVAILABLE",
      message: "IGDB connection failed",
      status: 502
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: { code: "UNAVAILABLE", message: "IGDB connection failed" }
    });
  });

  it("ignores the supplied fallback when the error is an AppError", async () => {
    const response = errorResponse(
      new AppError("NOT_FOUND", 404, "Indexer does not exist"),
      { code: "UNAVAILABLE", message: "IGDB connection failed", status: 502 }
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { code: "NOT_FOUND", message: "Indexer does not exist" }
    });
  });
});
