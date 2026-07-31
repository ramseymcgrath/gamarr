import { describe, expect, it, vi } from "vitest";

import { SabnzbdClient } from "@/integrations/sabnzbd/client";

describe("SabnzbdClient", () => {
  it("uploads bounded NZB bytes with a durable marker", async () => {
    const bytes = new TextEncoder().encode("<nzb>safe</nzb>");
    const capture: { submitted?: FormData } = {};
    const request = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capture.submitted = init?.body as FormData;
      return Response.json({ status: true, nzo_ids: ["SABnzbd_nzo_abc"] });
    });
    const client = new SabnzbdClient({
      baseUrl: "http://sab.test:8080/sabnzbd",
      apiKey: "sab-secret",
      maxNzbBytes: 1024 * 1024,
      fetch: request
    });

    await expect(client.upload({
      filename: "game.nzb",
      bytes,
      category: "games",
      marker: "gamarr-attempt-1"
    })).resolves.toEqual({ jobId: "SABnzbd_nzo_abc" });

    expect(capture.submitted?.get("nzbname")).toBe("gamarr-attempt-1");
    expect(capture.submitted?.get("cat")).toBe("games");
    const file = capture.submitted?.get("nzbfile") as File;
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
    expect(JSON.stringify([...capture.submitted!.entries()])).not.toContain("indexer");
  });

  it("rejects oversized uploads and ambiguous SAB acknowledgements", async () => {
    const client = new SabnzbdClient({
      baseUrl: "http://sab.test/api",
      apiKey: "secret",
      maxNzbBytes: 5,
      fetch: async () => Response.json({ status: true, nzo_ids: [] })
    });

    await expect(client.upload({
      filename: "large.nzb",
      bytes: new Uint8Array(6),
      category: null,
      marker: "gamarr-attempt-1"
    })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(client.upload({
      filename: "small.nzb",
      bytes: new Uint8Array(5),
      category: null,
      marker: "gamarr-attempt-1"
    })).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("normalizes queue and history jobs and tests with a zero-item queue", async () => {
    const seenModes: string[] = [];
    const client = new SabnzbdClient({
      baseUrl: "http://sab.test/api",
      apiKey: "secret",
      maxNzbBytes: 100,
      fetch: async (input) => {
        const url = new URL(String(input));
        const mode = url.searchParams.get("mode")!;
        seenModes.push(mode);
        if (mode === "queue") {
          return Response.json({
            queue: {
              slots: [{
                nzo_id: "queued",
                filename: "gamarr-a",
                status: "Downloading",
                percentage: "52.6"
              }]
            }
          });
        }
        return Response.json({
          history: {
            slots: [{
              nzo_id: "done",
              name: "gamarr-b",
              status: "Completed",
              percentage: "100"
            }]
          }
        });
      }
    });

    await expect(client.getQueue()).resolves.toEqual([{
      jobId: "queued",
      marker: "gamarr-a",
      status: "Downloading",
      progress: 53
    }]);
    await expect(client.getHistory()).resolves.toEqual([{
      jobId: "done",
      marker: "gamarr-b",
      status: "Completed",
      progress: 100
    }]);
    await client.testConnection();
    expect(seenModes).toEqual(["queue", "history", "queue"]);
  });
});
