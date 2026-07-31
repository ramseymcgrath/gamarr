import { beforeEach, describe, expect, it, vi } from "vitest";

import { SdkIgdbExecutor, type IgdbRequest } from "@/integrations/igdb/client";
import { AppError } from "@/lib/errors";

const { requestMock } = vi.hoisted(() => ({ requestMock: vi.fn() }));

vi.mock("igdb-api-node", () => ({
  default: () => {
    const chain: Record<string, unknown> = {
      fields: () => chain,
      limit: () => chain,
      offset: () => chain,
      search: () => chain,
      where: () => chain,
      request: requestMock
    };
    return chain;
  }
}));

const request: IgdbRequest = {
  endpoint: "/games",
  fields: ["id"],
  limit: 1,
  offset: 0
};

async function executeRejection(cause: unknown) {
  requestMock.mockRejectedValueOnce(cause);
  const executor = new SdkIgdbExecutor({ clientId: "client" });
  return executor.execute("token", { ...request }).then(
    () => {
      throw new Error("expected the executor to reject");
    },
    (error: AppError & { upstreamStatus?: number }) => error
  );
}

describe("SdkIgdbExecutor", () => {
  beforeEach(() => {
    requestMock.mockReset();
  });

  it("reports a transport failure with no upstream status as 502", async () => {
    const error = await executeRejection(new Error("ECONNREFUSED"));

    expect(error).toBeInstanceOf(AppError);
    expect(error.code).toBe("UNAVAILABLE");
    expect(error.status).toBe(502);
    expect(error.upstreamStatus).toBeUndefined();
  });

  it("maps an upstream 500 to a public 502 while retaining the upstream status", async () => {
    const error = await executeRejection({ response: { status: 500 } });

    expect(error.status).toBe(502);
    expect(error.upstreamStatus).toBe(500);
  });

  it("preserves 401 as the public status", async () => {
    const error = await executeRejection({ response: { status: 401 } });

    expect(error.status).toBe(401);
    expect(error.upstreamStatus).toBe(401);
  });

  it("keeps 429 available for retry without exposing it publicly", async () => {
    const error = await executeRejection({ response: { status: 429 } });

    expect(error.status).toBe(502);
    expect(error.upstreamStatus).toBe(429);
  });

  it("reads a top-level status when the SDK omits the response envelope", async () => {
    const error = await executeRejection({ status: 401 });

    expect(error.status).toBe(401);
    expect(error.upstreamStatus).toBe(401);
  });
});
