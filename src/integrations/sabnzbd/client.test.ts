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

  it("rejects an oversized upload before contacting SABnzbd", async () => {
    const request = vi.fn(async () => Response.json({ status: true }));
    const client = new SabnzbdClient({
      baseUrl: "http://sab.test/api",
      apiKey: "secret",
      maxNzbBytes: 5,
      fetch: request
    });

    await expect(client.upload({
      filename: "large.nzb",
      bytes: new Uint8Array(6),
      category: null,
      marker: "gamarr-attempt-1"
    })).rejects.toMatchObject({ code: "VALIDATION" });
    expect(request).not.toHaveBeenCalled();
  });

  it("treats an explicit SABnzbd refusal as a rejection", async () => {
    const client = new SabnzbdClient({
      baseUrl: "http://sab.test/api",
      apiKey: "secret",
      maxNzbBytes: 100,
      fetch: async () => Response.json({ status: false, error: "nzb rejected" })
    });

    await expect(client.upload({
      filename: "small.nzb",
      bytes: new Uint8Array(5),
      category: null,
      marker: "gamarr-attempt-1"
    })).rejects.toMatchObject({ outcome: "rejected", message: "nzb rejected" });
  });

  it("treats a client error response as a rejection", async () => {
    const client = new SabnzbdClient({
      baseUrl: "http://sab.test/api",
      apiKey: "secret",
      maxNzbBytes: 100,
      fetch: async () => new Response("forbidden", { status: 403 })
    });

    await expect(client.upload({
      filename: "small.nzb",
      bytes: new Uint8Array(5),
      category: null,
      marker: "gamarr-attempt-1"
    })).rejects.toMatchObject({ outcome: "rejected" });
  });

  it("treats a server error response as ambiguous", async () => {
    const client = new SabnzbdClient({
      baseUrl: "http://sab.test/api",
      apiKey: "secret",
      maxNzbBytes: 100,
      fetch: async () => new Response("boom", { status: 500 })
    });

    await expect(client.upload({
      filename: "small.nzb",
      bytes: new Uint8Array(5),
      category: null,
      marker: "gamarr-attempt-1"
    })).rejects.toMatchObject({ outcome: "ambiguous" });
  });

  it("treats an unreadable acknowledgement as ambiguous", async () => {
    const client = new SabnzbdClient({
      baseUrl: "http://sab.test/api",
      apiKey: "secret",
      maxNzbBytes: 100,
      fetch: async () => Response.json({ status: true, nzo_ids: [] })
    });

    await expect(client.upload({
      filename: "small.nzb",
      bytes: new Uint8Array(5),
      category: null,
      marker: "gamarr-attempt-1"
    })).rejects.toMatchObject({ code: "UNAVAILABLE", outcome: "ambiguous" });
  });

  it("stops reading an oversized queue response", async () => {
    const chunk = new TextEncoder().encode("x".repeat(64));
    const pulled: number[] = [];
    let index = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index >= 100) {
          controller.close();
          return;
        }
        pulled.push(index);
        controller.enqueue(chunk);
        index += 1;
      }
    }, { highWaterMark: 0 });
    const client = new SabnzbdClient({
      baseUrl: "http://sab.test/api",
      apiKey: "secret",
      maxNzbBytes: 100,
      maxResponseBytes: 100,
      fetch: async () => new Response(stream)
    });

    await expect(client.getQueue()).rejects.toMatchObject({
      code: "UNAVAILABLE",
      message: "SABnzbd queue response is too large"
    });
    expect(pulled.length).toBeLessThanOrEqual(2);
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
