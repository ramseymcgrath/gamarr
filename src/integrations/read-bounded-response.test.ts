import { describe, expect, it } from "vitest";

import { readBoundedResponse } from "@/integrations/read-bounded-response";

const limitError = () => new Error("too large");

function trackedStream(chunks: Uint8Array[]) {
  const pulled: number[] = [];
  let cancelled = 0;
  let index = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      pulled.push(index);
      controller.enqueue(chunks[index]!);
      index += 1;
    },
    cancel() {
      cancelled += 1;
    }
  }, { highWaterMark: 0 });
  return {
    stream,
    pulled,
    get cancelled() {
      return cancelled;
    }
  };
}

describe("readBoundedResponse", () => {
  it("returns a body that fits within the limit", async () => {
    const source = trackedStream([new Uint8Array([1, 2, 3])]);

    await expect(readBoundedResponse(new Response(source.stream), 10, limitError))
      .resolves.toEqual(new Uint8Array([1, 2, 3]));
  });

  it("stops reading a chunked body once it exceeds the limit", async () => {
    const source = trackedStream([
      new Uint8Array(6),
      new Uint8Array(6),
      new Uint8Array(6)
    ]);
    const response = new Response(source.stream);

    await expect(readBoundedResponse(response, 10, limitError))
      .rejects.toThrow("too large");
    expect(source.pulled).toEqual([0, 1]);
    expect(source.cancelled).toBe(1);
  });

  it("enforces the limit even when content-length understates the body", async () => {
    const source = trackedStream([new Uint8Array(6), new Uint8Array(6)]);
    const response = new Response(source.stream, {
      headers: { "content-length": "1" }
    });

    await expect(readBoundedResponse(response, 10, limitError))
      .rejects.toThrow("too large");
    expect(source.cancelled).toBe(1);
  });

  it("rejects an oversized declared length without reading the body", async () => {
    const source = trackedStream([new Uint8Array(6)]);
    const response = new Response(source.stream, {
      headers: { "content-length": "999" }
    });

    await expect(readBoundedResponse(response, 10, limitError))
      .rejects.toThrow("too large");
    expect(source.pulled).toEqual([]);
  });

  it("preserves a multi-byte sequence split across chunks", async () => {
    const encoded = new TextEncoder().encode("A🎮B");
    const source = trackedStream([
      encoded.slice(0, 3),
      encoded.slice(3)
    ]);

    const bytes = await readBoundedResponse(
      new Response(source.stream),
      encoded.byteLength,
      limitError
    );

    expect(new TextDecoder().decode(bytes)).toBe("A🎮B");
  });

  it("rejects rather than truncating when the limit splits a character", async () => {
    const encoded = new TextEncoder().encode("A🎮B");
    const source = trackedStream([encoded]);

    await expect(readBoundedResponse(
      new Response(source.stream),
      2,
      limitError
    )).rejects.toThrow("too large");
  });
});
