import { describe, expect, it, vi } from "vitest";

import { handleTestIndexer } from "@/app/api/settings/indexers/test-handler";
import type { IndexerRecord } from "@/features/settings/models";
import { parseOriginPolicy } from "@/lib/trusted-mutation";

const indexer: IndexerRecord = {
  id: "indexer",
  name: "Indexer",
  baseUrl: "https://indexer.test/api",
  apiKey: "secret",
  enabled: true,
  categoryIds: [],
  timeoutMs: 10_000,
  configRevision: 1,
  lastTestStatus: null,
  lastTestedAt: null,
  deletedAt: null,
  createdAt: 1,
  updatedAt: 1
};

describe("indexer test handler", () => {
  it("returns redacted capabilities from the selected indexer", async () => {
    const getCapabilities = vi.fn(async () => ({
      serverTitle: "Indexer",
      serverVersion: "1",
      searchAvailable: true,
      categories: [{ id: "4050", name: "Games", parentId: "4000" }]
    }));
    const response = await handleTestIndexer(
      "indexer",
      new Request("http://gamarr.local/api/settings/indexers/indexer/test", {
        method: "POST",
        headers: {
          host: "gamarr.local",
          origin: "http://gamarr.local"
        }
      }),
      {
        policy: parseOriginPolicy("http://gamarr.local"),
        findIndexer: () => indexer,
        clientFactory: () => ({ getCapabilities })
      }
    );

    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      searchAvailable: true,
      categories: [{ id: "4050" }]
    });
    expect(JSON.stringify(body)).not.toContain("secret");
  });
});
