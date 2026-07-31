import type { NzbFetcherPort } from "@/features/downloads/port";
import { AppError } from "@/lib/errors";

export class NewznabNzbFetcher implements NzbFetcherPort {
  constructor(private readonly request: typeof fetch = fetch) {}

  async fetch(
    input: Parameters<NzbFetcherPort["fetch"]>[0]
  ): Promise<Uint8Array> {
    const configured = new URL(input.indexer.baseUrl);
    let target = new URL(input.candidate.downloadPath, configured);
    if (target.origin !== configured.origin) {
      throw new AppError("UNAVAILABLE", 502, "NZB URL left the configured indexer");
    }

    for (let redirects = 0; redirects <= 3; redirects += 1) {
      target.searchParams.set("apikey", input.indexer.apiKey);
      const response = await this.request(target, {
        headers: {
          accept: "application/x-nzb, application/xml, text/xml"
        },
        redirect: "manual",
        signal: AbortSignal.timeout(Math.min(input.indexer.timeoutMs, 10_000))
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location || redirects === 3) {
          throw new AppError("UNAVAILABLE", 502, "Indexer returned an invalid redirect");
        }
        const redirected = new URL(location, target);
        if (redirected.origin !== configured.origin) {
          throw new AppError(
            "UNAVAILABLE",
            502,
            "Indexer redirected the NZB to another origin"
          );
        }
        target = redirected;
        continue;
      }
      if (!response.ok || !response.body) {
        throw new AppError("UNAVAILABLE", 502, "Indexer NZB retrieval failed");
      }
      const length = Number(response.headers.get("content-length"));
      if (Number.isFinite(length) && length > input.maxBytes) {
        throw new AppError("UNAVAILABLE", 502, "Indexer NZB exceeded the size limit");
      }
      return this.readBounded(response.body, input.maxBytes);
    }
    throw new AppError("UNAVAILABLE", 502, "Indexer redirect limit exceeded");
  }

  private async readBounded(
    stream: ReadableStream<Uint8Array>,
    maxBytes: number
  ): Promise<Uint8Array> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new AppError("UNAVAILABLE", 502, "Indexer NZB exceeded the size limit");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }
}
