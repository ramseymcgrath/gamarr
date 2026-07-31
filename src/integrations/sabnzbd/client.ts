import { z } from "zod";

import type {
  NzbUpload,
  SabJob
} from "@/features/downloads/models";
import {
  SabnzbdUploadError,
  type SabnzbdPort
} from "@/features/downloads/port";
import { readBoundedJson } from "@/integrations/read-bounded-response";
import { AppError, validationError } from "@/lib/errors";

interface SabnzbdClientOptions {
  baseUrl: string;
  apiKey: string;
  maxNzbBytes: number;
  timeoutMs?: number;
  /** Ceiling for SABnzbd's own JSON replies, not for uploaded NZBs. */
  maxResponseBytes?: number;
  fetch?: typeof fetch;
}

/** Large enough for a queue or history with many slots, small enough to bound. */
const defaultMaxResponseBytes = 8 * 1024 * 1024;

// SABnzbd signals an application-level refusal as a 2xx body with
// `status: false`, so both branches must parse — accepting only `true` made a
// definite rejection indistinguishable from an unreadable response.
const acknowledgementSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal(true),
    nzo_ids: z.array(z.string().min(1)).length(1)
  }),
  z.object({
    status: z.literal(false),
    error: z.string().min(1).optional()
  })
]);

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
  private readonly maxResponseBytes: number;

  constructor(private readonly options: SabnzbdClientOptions) {
    this.request = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxResponseBytes = options.maxResponseBytes ?? defaultMaxResponseBytes;
  }

  private readBody(response: Response, operation: string): Promise<unknown> {
    return readBoundedJson(
      response,
      this.maxResponseBytes,
      () => new AppError(
        "UNAVAILABLE",
        502,
        `SABnzbd ${operation} response is too large`
      )
    );
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
      // A 4xx means SABnzbd refused the request outright; a 5xx may have
      // failed after the job was already accepted, so it stays ambiguous.
      throw response.status < 500
        ? new SabnzbdUploadError("rejected", "SABnzbd rejected the upload")
        : new SabnzbdUploadError(
          "ambiguous",
          "SABnzbd did not confirm the upload"
        );
    }
    const parsed = acknowledgementSchema.safeParse(
      await this.readBody(response, "upload")
    );
    if (!parsed.success) {
      throw new SabnzbdUploadError(
        "ambiguous",
        "SABnzbd returned an ambiguous upload acknowledgement"
      );
    }
    if (!parsed.data.status) {
      throw new SabnzbdUploadError(
        "rejected",
        parsed.data.error ?? "SABnzbd rejected the upload"
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
    const payload = await this.readBody(response, mode) as Record<string, unknown>;
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
