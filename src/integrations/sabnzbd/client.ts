import { z } from "zod";

import type {
  NzbUpload,
  SabJob
} from "@/features/downloads/models";
import type { SabnzbdPort } from "@/features/downloads/port";
import { AppError, validationError } from "@/lib/errors";

interface SabnzbdClientOptions {
  baseUrl: string;
  apiKey: string;
  maxNzbBytes: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

const acknowledgementSchema = z.object({
  status: z.literal(true),
  nzo_ids: z.array(z.string().min(1)).length(1)
});

const jobSchema = z.object({
  nzo_id: z.string().min(1),
  filename: z.string().optional(),
  name: z.string().optional(),
  status: z.string().default("Unknown"),
  percentage: z.union([z.string(), z.number()]).optional()
});

export class SabnzbdClient implements SabnzbdPort {
  private readonly request: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: SabnzbdClientOptions) {
    this.request = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async upload(input: NzbUpload): Promise<{ jobId: string }> {
    if (input.bytes.byteLength > this.options.maxNzbBytes) {
      throw validationError("NZB exceeds the configured upload limit");
    }
    const form = new FormData();
    form.set("mode", "addfile");
    form.set("output", "json");
    form.set("apikey", this.options.apiKey);
    form.set("nzbname", input.marker);
    if (input.category) form.set("cat", input.category);
    form.set(
      "nzbfile",
      new Blob([new Uint8Array(input.bytes)], { type: "application/x-nzb" }),
      input.filename
    );
    const response = await this.request(this.apiUrl(), {
      method: "POST",
      body: form,
      redirect: "manual",
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    if (!response.ok) {
      throw new AppError("UNAVAILABLE", 502, "SABnzbd rejected the upload");
    }
    const parsed = acknowledgementSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new AppError(
        "UNAVAILABLE",
        502,
        "SABnzbd returned an ambiguous upload acknowledgement"
      );
    }
    return { jobId: parsed.data.nzo_ids[0]! };
  }

  getQueue(limit?: number): Promise<SabJob[]> {
    return this.getJobs("queue", limit);
  }

  getHistory(): Promise<SabJob[]> {
    return this.getJobs("history");
  }

  async testConnection(): Promise<void> {
    await this.getQueue(0);
  }

  private apiUrl(): URL {
    const base = new URL(this.options.baseUrl);
    if (base.pathname.endsWith("/api")) return base;
    base.pathname = `${base.pathname.replace(/\/+$/, "")}/api`;
    return base;
  }

  private async getJobs(
    mode: "queue" | "history",
    limit?: number
  ): Promise<SabJob[]> {
    const url = this.apiUrl();
    url.searchParams.set("mode", mode);
    url.searchParams.set("output", "json");
    url.searchParams.set("apikey", this.options.apiKey);
    if (limit !== undefined) url.searchParams.set("limit", String(limit));
    const response = await this.request(url, {
      headers: { accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    if (!response.ok) {
      throw new AppError("UNAVAILABLE", 502, `SABnzbd ${mode} request failed`);
    }
    const payload = await response.json() as Record<string, unknown>;
    const container = payload[mode] as Record<string, unknown> | undefined;
    const parsed = z.array(jobSchema).safeParse(container?.slots ?? []);
    if (!parsed.success) {
      throw new AppError("UNAVAILABLE", 502, `SABnzbd returned an invalid ${mode}`);
    }
    return parsed.data.map((job) => ({
      jobId: job.nzo_id,
      marker: job.filename ?? job.name ?? "",
      status: job.status,
      progress: Math.max(
        0,
        Math.min(100, Math.round(Number(job.percentage ?? 0) || 0))
      )
    }));
  }
}
