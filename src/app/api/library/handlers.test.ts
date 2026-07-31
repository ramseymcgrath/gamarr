import { describe, expect, it, vi } from "vitest";

import {
  handleDeleteLibraryEntry,
  handleGetLibraryEntry,
  handleListLibrary
} from "@/app/api/library/handlers";
import { parseOriginPolicy } from "@/lib/trusted-mutation";

const entry = {
  id: "library",
  gameId: 1,
  gameTitle: "Game",
  coverUrl: null,
  platformId: 130,
  platformName: "Switch",
  createdAt: 1,
  updatedAt: 1,
  attempts: []
};

describe("library HTTP handlers", () => {
  it("keeps GET handlers read-only", async () => {
    const service = {
      list: vi.fn(() => [{ ...entry, latestAttempt: null }]),
      get: vi.fn(() => entry),
      delete: vi.fn()
    };

    expect((await handleListLibrary({ service })).status).toBe(200);
    expect((await handleGetLibraryEntry("library", { service })).status).toBe(200);
    expect(service.delete).not.toHaveBeenCalled();
  });

  it("requires a guarded explicit title confirmation for deletion", async () => {
    const service = {
      list: vi.fn(),
      get: vi.fn(),
      delete: vi.fn()
    };
    const response = await handleDeleteLibraryEntry(
      "library",
      new Request("http://gamarr.local/api/library/library", {
        method: "DELETE",
        headers: {
          host: "gamarr.local",
          origin: "http://gamarr.local",
          "content-type": "application/json"
        },
        body: JSON.stringify({ confirmation: "Game" })
      }),
      {
        service,
        policy: parseOriginPolicy("http://gamarr.local")
      }
    );

    expect(response.status).toBe(204);
    expect(service.delete).toHaveBeenCalledWith("library", "Game");
  });
});
