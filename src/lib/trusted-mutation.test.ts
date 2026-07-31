import { describe, expect, it } from "vitest";

import { AppError } from "@/lib/errors";
import {
  assertTrustedMutation,
  parseOriginPolicy
} from "@/lib/trusted-mutation";

function mutationRequest(origin: string, host: string, extraHeaders?: HeadersInit) {
  return new Request(`${origin}/api/settings/igdb`, {
    method: "PUT",
    headers: {
      host,
      origin,
      "content-type": "application/json",
      ...extraHeaders
    }
  });
}

describe("assertTrustedMutation", () => {
  const policy = parseOriginPolicy(
    "http://gamarr.local,http://192.168.1.20:3000"
  );

  it("accepts an exact allowed scheme, host, and port", () => {
    expect(() => assertTrustedMutation(
      mutationRequest("http://192.168.1.20:3000", "192.168.1.20:3000"),
      policy
    )).not.toThrow();
  });

  it("rejects a cross-origin request", () => {
    const request = new Request("http://gamarr.local/api/settings/igdb", {
      method: "PUT",
      headers: {
        host: "gamarr.local",
        origin: "http://attacker.test",
        "content-type": "application/json"
      }
    });

    expect(() => assertTrustedMutation(request, policy)).toThrowError(AppError);
  });

  it("rejects DNS rebinding when hostile origin and host match each other", () => {
    const request = mutationRequest(
      "http://rebind.attacker.test",
      "rebind.attacker.test"
    );

    expect(() => assertTrustedMutation(request, policy)).toThrowError(AppError);
  });

  it("rejects a scheme or port mismatch", () => {
    expect(() => assertTrustedMutation(
      mutationRequest("https://gamarr.local", "gamarr.local"),
      policy
    )).toThrowError(AppError);

    expect(() => assertTrustedMutation(
      mutationRequest("http://192.168.1.20:3001", "192.168.1.20:3001"),
      policy
    )).toThrowError(AppError);
  });

  it("ignores forwarded hosts unless trusted proxy mode is enabled", () => {
    const request = mutationRequest(
      "http://gamarr.local",
      "internal-container:3000",
      { "x-forwarded-host": "gamarr.local" }
    );

    expect(() => assertTrustedMutation(request, policy)).toThrowError(AppError);
  });
});
