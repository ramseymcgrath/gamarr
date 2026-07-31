import { describe, expect, it } from "vitest";

import { TwitchTokenManager } from "@/integrations/igdb/token-manager";

describe("TwitchTokenManager", () => {
  it("coalesces concurrent refreshes and refreshes after expiry", async () => {
    let calls = 0;
    let now = 1_000;
    const manager = new TwitchTokenManager({
      credentials: () => ({ clientId: "client", clientSecret: "secret" }),
      now: () => now,
      requestToken: async () => {
        calls += 1;
        return {
          accessToken: `token-${calls}`,
          expiresInSeconds: 120
        };
      }
    });

    expect(await Promise.all([
      manager.getAccessToken(),
      manager.getAccessToken(),
      manager.getAccessToken()
    ])).toEqual(["token-1", "token-1", "token-1"]);
    expect(calls).toBe(1);

    now += 61_000;
    expect(await manager.getAccessToken()).toBe("token-2");
    expect(calls).toBe(2);
  });

  it("can invalidate a revoked token", async () => {
    let calls = 0;
    const manager = new TwitchTokenManager({
      credentials: () => ({ clientId: "client", clientSecret: "secret" }),
      requestToken: async () => ({
        accessToken: `token-${++calls}`,
        expiresInSeconds: 3600
      })
    });

    expect(await manager.getAccessToken()).toBe("token-1");
    manager.invalidate();
    expect(await manager.getAccessToken()).toBe("token-2");
  });
});
