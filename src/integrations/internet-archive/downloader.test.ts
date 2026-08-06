import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InternetArchiveDownloader } from "@/integrations/internet-archive/downloader";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function downloadDir() {
  const directory = mkdtempSync(path.join(tmpdir(), "gamarr-ia-"));
  temporaryDirectories.push(directory);
  return directory;
}

function streamResponse(
  chunks: Uint8Array[],
  headers: Record<string, string> = {},
  status = 200
) {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      }
    }),
    { status, headers }
  );
}

const baseInput = {
  identifier: "game-item",
  fileName: "Game (USA).zip",
  attemptId: "attempt-1",
  maxBytes: 1024
};

describe("InternetArchiveDownloader", () => {
  it("streams a file to the per-item directory and reports progress", async () => {
    const directory = downloadDir();
    const request = vi.fn<(input: RequestInfo | URL) => Promise<Response>>(
      async () => streamResponse(
      [new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])],
      { "content-length": "5" }
    ));
    const progress: Array<[number, number | null]> = [];
    const downloader = new InternetArchiveDownloader({ fetch: request });

    const result = await downloader.download({
      ...baseInput,
      destinationDir: directory,
      onProgress: (received, total) => progress.push([received, total])
    });

    const requestUrl = new URL(String(request.mock.calls[0]?.[0]));
    expect(requestUrl.origin).toBe("https://archive.org");
    expect(requestUrl.pathname).toBe("/download/game-item/Game%20(USA).zip");
    const filePath = path.join(directory, "game-item", "Game (USA).zip");
    expect(result).toEqual({ bytes: 5, filePath });
    expect(readFileSync(filePath)).toEqual(Buffer.from([1, 2, 3, 4, 5]));
    expect(readdirSync(path.join(directory, "game-item"))).toEqual([
      "Game (USA).zip"
    ]);
    expect(progress.at(-1)).toEqual([5, 5]);
  });

  it("follows a redirect to an archive.org node over HTTPS", async () => {
    const directory = downloadDir();
    const request = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === "archive.org") {
        return new Response(null, {
          status: 302,
          headers: {
            location: "https://ia800300.us.archive.org/0/items/game-item/x.bin"
          }
        });
      }
      return streamResponse([new Uint8Array([9])]);
    });
    const downloader = new InternetArchiveDownloader({ fetch: request });

    const result = await downloader.download({
      ...baseInput,
      fileName: "x.bin",
      destinationDir: directory
    });

    expect(result.bytes).toBe(1);
    expect(new URL(String(request.mock.calls[1]?.[0])).hostname)
      .toBe("ia800300.us.archive.org");
  });

  it("refuses a redirect away from archive.org", async () => {
    const directory = downloadDir();
    const request = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: "https://evil.example/steal" }
    }));
    const downloader = new InternetArchiveDownloader({ fetch: request });

    await expect(downloader.download({
      ...baseInput,
      destinationDir: directory
    })).rejects.toMatchObject({
      code: "UNAVAILABLE",
      message: "Internet Archive returned an unsafe redirect"
    });
    expect(readdirSync(path.join(directory, "game-item"))).toEqual([]);
  });

  it("rejects traversal file names before touching the network", async () => {
    const directory = downloadDir();
    const request = vi.fn(async () => streamResponse([new Uint8Array([1])]));
    const downloader = new InternetArchiveDownloader({ fetch: request });

    for (const fileName of ["../evil", "a/b", "a\\b", "..", ""]) {
      await expect(downloader.download({
        ...baseInput,
        fileName,
        destinationDir: directory
      })).rejects.toMatchObject({ code: "VALIDATION" });
    }
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects an oversized file from content-length before writing", async () => {
    const directory = downloadDir();
    const request = vi.fn(async () => streamResponse(
      [new Uint8Array([1])],
      { "content-length": "2048" }
    ));
    const downloader = new InternetArchiveDownloader({ fetch: request });

    await expect(downloader.download({
      ...baseInput,
      destinationDir: directory
    })).rejects.toMatchObject({
      code: "UNAVAILABLE",
      message: "Internet Archive file exceeded the size limit"
    });
    // Nothing was written. The per-item directory is deliberately left in
    // place — see the concurrency test below.
    expect(readdirSync(path.join(directory, "game-item"))).toEqual([]);
  });

  it("enforces the size ceiling mid-stream and removes the partial file", async () => {
    const directory = downloadDir();
    const request = vi.fn(async () => streamResponse([
      new Uint8Array(600),
      new Uint8Array(600)
    ]));
    const downloader = new InternetArchiveDownloader({ fetch: request });

    await expect(downloader.download({
      ...baseInput,
      destinationDir: directory
    })).rejects.toMatchObject({
      code: "UNAVAILABLE",
      message: "Internet Archive file exceeded the size limit"
    });
    expect(readdirSync(path.join(directory, "game-item"))).toEqual([]);
  });

  // A 255-byte name is legal per path-policy, and attempt ids are 36-character
  // UUIDs. A temp file derived from the file name would overflow the component
  // limit on both ext4 and APFS, so the temp name must not include it.
  const longFileName = `${"a".repeat(251)}.zip`;
  const uuidAttemptId = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

  it("downloads a file whose name reaches the 255-byte component limit", async () => {
    const directory = downloadDir();
    const request = vi.fn(async () => streamResponse([new Uint8Array([4, 2])]));
    const downloader = new InternetArchiveDownloader({ fetch: request });

    const result = await downloader.download({
      ...baseInput,
      fileName: longFileName,
      attemptId: uuidAttemptId,
      destinationDir: directory
    });

    const itemDir = path.join(directory, "game-item");
    expect(result.filePath).toBe(path.join(itemDir, longFileName));
    expect(readFileSync(result.filePath)).toEqual(Buffer.from([4, 2]));
    // Exactly one entry proves both that the rename landed and that no temp
    // file derived from the long name was ever left behind.
    expect(readdirSync(itemDir)).toEqual([longFileName]);
  });

  it("cleans up the temp file for a 255-byte name when the stream fails", async () => {
    const directory = downloadDir();
    const request = vi.fn(async () => new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.error(new Error("connection reset"));
        }
      })
    ));
    const downloader = new InternetArchiveDownloader({ fetch: request });

    await expect(downloader.download({
      ...baseInput,
      fileName: longFileName,
      attemptId: uuidAttemptId,
      destinationDir: directory
    })).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(readdirSync(path.join(directory, "game-item"))).toEqual([]);
  });

  it("removes the partial file when the archive node fails mid-stream", async () => {
    const directory = downloadDir();
    const request = vi.fn(async () => new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.error(new Error("connection reset"));
        }
      })
    ));
    const downloader = new InternetArchiveDownloader({ fetch: request });

    await expect(downloader.download({
      ...baseInput,
      destinationDir: directory
    })).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(readdirSync(path.join(directory, "game-item"))).toEqual([]);
  });

  it("fails the attempt when the body stalls between chunks", async () => {
    const directory = downloadDir();
    let delivered = false;
    const request = vi.fn(async () => new Response(
      new ReadableStream({
        async pull(controller) {
          if (delivered) {
            // A hung archive node: the connection stays open and no further
            // chunk ever arrives, so the stream neither errors nor closes.
            await new Promise<void>(() => undefined);
            return;
          }
          delivered = true;
          controller.enqueue(new Uint8Array([1, 2, 3]));
        }
      })
    ));
    const downloader = new InternetArchiveDownloader({
      fetch: request,
      idleTimeoutMs: 25
    });

    await expect(downloader.download({
      ...baseInput,
      destinationDir: directory
    })).rejects.toMatchObject({
      code: "UNAVAILABLE",
      message: "Internet Archive download stalled"
    });
    expect(readdirSync(path.join(directory, "game-item"))).toEqual([]);
  });

  it("does not delete the item directory out from under a concurrent attempt", async () => {
    const directory = downloadDir();
    let releaseSurvivor: (() => void) | undefined;
    const survivorHeaders = new Promise<void>((resolve) => {
      releaseSurvivor = resolve;
    });
    const request = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("survivor.bin")) {
        // Park the survivor between its mkdir and its first write. That is
        // the exact window in which a sibling failure could remove the
        // per-item directory and strand this attempt's later rename.
        await survivorHeaders;
        return streamResponse([new Uint8Array([7, 7, 7])]);
      }
      return new Response(new ReadableStream({
        start(controller) {
          controller.error(new Error("connection reset"));
        }
      }));
    });
    const downloader = new InternetArchiveDownloader({ fetch: request });

    const survivor = downloader.download({
      ...baseInput,
      fileName: "survivor.bin",
      attemptId: "11111111-1111-4111-8111-111111111111",
      destinationDir: directory
    });
    // The survivor's fetch having been entered proves its mkdir has landed.
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));

    await expect(downloader.download({
      ...baseInput,
      fileName: "doomed.bin",
      attemptId: "22222222-2222-4222-8222-222222222222",
      destinationDir: directory
    })).rejects.toMatchObject({ code: "UNAVAILABLE" });

    releaseSurvivor?.();
    const result = await survivor;

    expect(result.filePath).toBe(
      path.join(directory, "game-item", "survivor.bin")
    );
    expect(readFileSync(result.filePath)).toEqual(Buffer.from([7, 7, 7]));
  });
});
