import { describe, expect, it, vi } from "vitest";

import { handleSetPlatform } from "@/app/api/platforms/handlers";
import { parseOriginPolicy } from "@/lib/trusted-mutation";

function request(
  origin = "http://gamarr.local",
  body: Record<string, unknown> = {
    id: 130,
    visible: true,
    aliases: ["Switch", "NSW"],
    categoryIds: ["1000", "1080"]
  }
) {
  return new Request("http://gamarr.local/api/platforms", {
    method: "PUT",
    headers: {
      host: "gamarr.local",
      origin,
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

describe("platform settings HTTP handler", () => {
  it("updates visibility without touching categories when none are sent", async () => {
    const setPlatformVisibility = vi.fn();
    const savePlatformCategories = vi.fn();

    // The visibility checkbox sends only id/visible/aliases. Requiring
    // categoryIds here 400s every toggle, and defaulting it to [] would wipe
    // a platform's categories as a side effect of showing or hiding it.
    const response = await handleSetPlatform(
      request("http://gamarr.local", {
        id: 130,
        visible: true,
        aliases: ["Switch", "NSW"]
      }),
      {
        catalog: { setPlatformVisibility },
        settings: { savePlatformCategories },
        policy: parseOriginPolicy("http://gamarr.local")
      }
    );

    expect(response.status).toBe(200);
    expect(setPlatformVisibility).toHaveBeenCalledWith(
      130,
      true,
      ["Switch", "NSW"]
    );
    expect(savePlatformCategories).not.toHaveBeenCalled();
  });

  it("saves platform categories with visibility and aliases", async () => {
    const setPlatformVisibility = vi.fn();
    const savePlatformCategories = vi.fn();

    const response = await handleSetPlatform(request(), {
      catalog: { setPlatformVisibility },
      settings: { savePlatformCategories },
      policy: parseOriginPolicy("http://gamarr.local")
    });

    expect(response.status).toBe(200);
    expect(setPlatformVisibility).toHaveBeenCalledWith(
      130,
      true,
      ["Switch", "NSW"]
    );
    expect(savePlatformCategories).toHaveBeenCalledWith(
      130,
      ["1000", "1080"]
    );
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("rejects a cross-origin mutation", async () => {
    const setPlatformVisibility = vi.fn();
    const savePlatformCategories = vi.fn();

    const response = await handleSetPlatform(request("http://attacker.test"), {
      catalog: { setPlatformVisibility },
      settings: { savePlatformCategories },
      policy: parseOriginPolicy("http://gamarr.local")
    });

    expect(response.status).toBe(403);
    expect(setPlatformVisibility).not.toHaveBeenCalled();
    expect(savePlatformCategories).not.toHaveBeenCalled();
  });

  it("rejects malformed category ids before either write", async () => {
    const setPlatformVisibility = vi.fn();
    const savePlatformCategories = vi.fn();
    const malformed = new Request("http://gamarr.local/api/platforms", {
      method: "PUT",
      headers: {
        host: "gamarr.local",
        origin: "http://gamarr.local",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        id: 130,
        visible: true,
        aliases: ["Switch"],
        categoryIds: ["1080", 4000]
      })
    });

    const response = await handleSetPlatform(malformed, {
      catalog: { setPlatformVisibility },
      settings: { savePlatformCategories },
      policy: parseOriginPolicy("http://gamarr.local")
    });

    expect(response.status).toBe(400);
    expect(setPlatformVisibility).not.toHaveBeenCalled();
    expect(savePlatformCategories).not.toHaveBeenCalled();
  });
});
