import { afterEach, describe, expect, it } from "vitest";

import { proxy } from "@/proxy";

const originalOrigins = process.env.GAMARR_ALLOWED_ORIGINS;
const originalToken = process.env.GAMARR_API_TOKEN;

function request(
  method: string,
  origin?: string,
  host = "gamarr.local"
) {
  const headers = new Headers({ host });
  if (origin) headers.set("origin", origin);
  return new Request(`http://${host}/api/platforms/sync`, {
    method,
    headers
  });
}

afterEach(() => {
  if (originalOrigins === undefined) {
    delete process.env.GAMARR_ALLOWED_ORIGINS;
  } else {
    process.env.GAMARR_ALLOWED_ORIGINS = originalOrigins;
  }
  if (originalToken === undefined) {
    delete process.env.GAMARR_API_TOKEN;
  } else {
    process.env.GAMARR_API_TOKEN = originalToken;
  }
});

describe("API mutation proxy", () => {
  it("rejects a hostile origin before route dependencies are initialized", async () => {
    process.env.GAMARR_ALLOWED_ORIGINS = "http://gamarr.local";

    const response = proxy(request("POST", "http://attacker.invalid"));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "FORBIDDEN",
        message: "Request origin is not allowed"
      }
    });
  });

  it("rejects a browserless mutation without the automation token", () => {
    process.env.GAMARR_ALLOWED_ORIGINS = "http://gamarr.local";

    expect(proxy(request("POST")).status).toBe(403);
  });

  it("allows an exact browser origin", () => {
    process.env.GAMARR_ALLOWED_ORIGINS = "http://gamarr.local";

    const response = proxy(request("POST", "http://gamarr.local"));

    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("does not require mutation policy for safe API reads", () => {
    delete process.env.GAMARR_ALLOWED_ORIGINS;

    const response = proxy(request("GET"));

    expect(response.headers.get("x-middleware-next")).toBe("1");
  });
});
