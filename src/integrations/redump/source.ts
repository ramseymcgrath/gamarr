import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { RedumpSourcePort } from "@/features/verification/ports";
import { parseRedumpDat, type RedumpIndex } from "@/features/verification/redump";
import { readBoundedResponse } from "@/integrations/read-bounded-response";
import { AppError } from "@/lib/errors";
import { GAMARR_USER_AGENT } from "@/lib/user-agent";

/**
 * redump.org refuses connections from this network, so the lists come from
 * libretro-database's mirror of the Redump DATs (CC-BY-SA-4.0), which also
 * carries each disc's serial. Read-only use; nothing is redistributed.
 */
const DEFAULT_BASE_URL =
  "https://raw.githubusercontent.com/libretro/libretro-database/master/metadat/redump/";
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** The PS2 list is ~4 MB; 32 MiB is generous headroom for growth. */
const MAX_DAT_BYTES = 32 * 1024 * 1024;
/** Anything smaller is an error page or truncated file, not a Redump list. */
const MIN_PLAUSIBLE_ROMS = 100;

interface RedumpDatSourceOptions {
  cacheDir: string;
  baseUrl?: string;
  maxAgeMs?: number;
  timeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

/**
 * Loads a system's checksum list: memory, then the on-disk cache while it is
 * fresher than `maxAgeMs`, then a download. A failed refresh falls back to a
 * stale cached copy rather than failing verification.
 */
export class RedumpDatSource implements RedumpSourcePort {
  private readonly memory = new Map<string, { index: RedumpIndex; loadedAt: number }>();
  private readonly request: typeof fetch;
  private readonly now: () => number;
  private readonly maxAgeMs: number;

  constructor(private readonly options: RedumpDatSourceOptions) {
    this.request = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  }

  async load(datName: string): Promise<RedumpIndex> {
    const cached = this.memory.get(datName);
    if (cached && this.now() - cached.loadedAt < this.maxAgeMs) return cached.index;

    const file = join(this.options.cacheDir, `${datName}.dat`);
    const diskAge = await stat(file)
      .then((info) => this.now() - info.mtimeMs)
      .catch(() => null);

    if (diskAge !== null && diskAge < this.maxAgeMs) {
      const index = parseRedumpDat(await readFile(file, "utf8"));
      if (index.romCount >= MIN_PLAUSIBLE_ROMS) {
        return this.remember(datName, index);
      }
    }

    try {
      const text = await this.download(datName);
      const index = parseRedumpDat(text);
      if (index.romCount < MIN_PLAUSIBLE_ROMS) {
        throw new AppError("UNAVAILABLE", 502, "The Redump checksum list looks incomplete");
      }
      await mkdir(this.options.cacheDir, { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      await writeFile(temporary, text, "utf8");
      await rename(temporary, file);
      return this.remember(datName, index);
    } catch (error) {
      if (diskAge !== null) {
        const stale = parseRedumpDat(await readFile(file, "utf8"));
        if (stale.romCount >= MIN_PLAUSIBLE_ROMS) return this.remember(datName, stale);
      }
      if (error instanceof AppError) throw error;
      throw new AppError(
        "UNAVAILABLE",
        502,
        "Couldn't download the Redump checksum list",
        { cause: error }
      );
    }
  }

  private remember(datName: string, index: RedumpIndex): RedumpIndex {
    this.memory.set(datName, { index, loadedAt: this.now() });
    return index;
  }

  private async download(datName: string): Promise<string> {
    const url = new URL(
      `${encodeURIComponent(datName)}.dat`,
      this.options.baseUrl ?? DEFAULT_BASE_URL
    );
    const response = await this.request(url, {
      headers: { "user-agent": GAMARR_USER_AGENT, accept: "text/plain" },
      redirect: "error",
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 60_000)
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new AppError("UNAVAILABLE", 502, "Couldn't download the Redump checksum list");
    }
    const bytes = await readBoundedResponse(
      response,
      MAX_DAT_BYTES,
      () => new AppError("UNAVAILABLE", 502, "The Redump checksum list is too large")
    );
    return new TextDecoder().decode(bytes);
  }
}
