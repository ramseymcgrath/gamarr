/**
 * Reads a response body while enforcing a byte ceiling.
 *
 * `content-length` is only an early-exit optimisation: it is optional, and a
 * chunked or dishonest response would otherwise stream an unbounded body into
 * memory before any check could run. The limit is therefore enforced against
 * bytes actually delivered, cancelling the stream as soon as it is exceeded.
 *
 * Callers receive bytes rather than text so that a limit landing inside a
 * multi-byte sequence rejects the body instead of decoding a truncated one.
 */
export async function readBoundedResponse(
  response: Response,
  maxBytes: number,
  createLimitError: () => Error
): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw createLimitError();
    }
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw createLimitError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * `readBoundedResponse` for JSON bodies. Throws like `Response.json()` when the
 * payload is not valid JSON, so callers keep their existing failure handling.
 */
export async function readBoundedJson(
  response: Response,
  maxBytes: number,
  createLimitError: () => Error
): Promise<unknown> {
  const bytes = await readBoundedResponse(response, maxBytes, createLimitError);
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}
