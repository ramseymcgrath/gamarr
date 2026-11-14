import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { RedumpDatSource } from "@/integrations/redump/source";
import { GAMARR_USER_AGENT } from "@/lib/user-agent";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function cacheDir(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "gamarr-redump-"));
  directories.push(directory);
  return directory;
}

/** A plausible list: the source rejects anything under 100 roms. */
function dat(label: string, roms = 120): string {
  const games = Array.from({ length: roms }, (_, n) => {
    const sha1 = n.toString(16).padStart(40, "0");
    return `game (\n\tname "${label} ${n}"\n\trom ( name "${label} ${n}.iso" size ${1000 + n} crc 0 md5 0 sha1 ${sha1} )\n)`;
  });
  return `clrmamepro (\n\tversion "${label}"\n)\n${games.join("\n")}\n`;
}

const DAY = 24 * 60 * 60 * 1000;

describe("RedumpDatSource", () => {
  it("downloads with the gamarr User-Agent and caches to disk", async () => {
    const directory = cacheDir();
    const request = vi.fn<(url: URL | string, init?: RequestInit) => Promise<Response>>(
      async () => new Response(dat("fresh"))
    );
    const source = new RedumpDatSource({
      cacheDir: directory,
      fetch: request as unknown as typeof fetch
    });
    const index = await source.load("Sony - PlayStation 2");
    expect(index.version).toBe("fresh");
    expect(String(request.mock.calls[0]![0])).toBe(
      "https://raw.githubusercontent.com/libretro/libretro-database/master/metadat/redump/Sony%20-%20PlayStation%202.dat"
    );
    expect(new Headers(request.mock.calls[0]![1]!.headers).get("user-agent"))
      .toBe(GAMARR_USER_AGENT);
    expect(readFileSync(path.join(directory, "Sony - PlayStation 2.dat"), "utf8"))
      .toContain('version "fresh"');

    await source.load("Sony - PlayStation 2");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("uses a fresh disk cache without downloading", async () => {
    const directory = cacheDir();
    writeFileSync(path.join(directory, "Sony - PlayStation 2.dat"), dat("disk"));
    const request = vi.fn();
    const index = await new RedumpDatSource({
      cacheDir: directory,
      fetch: request as unknown as typeof fetch
    }).load("Sony - PlayStation 2");
    expect(index.version).toBe("disk");
    expect(request).not.toHaveBeenCalled();
  });

  it("refreshes a stale cache, and falls back to it when the refresh fails", async () => {
    const directory = cacheDir();
    const file = path.join(directory, "Sony - PlayStation 2.dat");
    writeFileSync(file, dat("stale"));
    const old = (Date.now() - 8 * DAY) / 1000;
    utimesSync(file, old, old);

    const failing = vi.fn(async () => new Response("down", { status: 503 }));
    const index = await new RedumpDatSource({
      cacheDir: directory,
      fetch: failing as unknown as typeof fetch
    }).load("Sony - PlayStation 2");
    expect(failing).toHaveBeenCalledTimes(1);
    expect(index.version).toBe("stale");
  });

  it("refuses an implausibly small list and keeps the old cache", async () => {
    const directory = cacheDir();
    const request = vi.fn(async () => new Response(dat("tiny", 3)));
    await expect(new RedumpDatSource({
      cacheDir: directory,
      fetch: request as unknown as typeof fetch
    }).load("Sony - PlayStation 2")).rejects.toThrow("looks incomplete");
  });

  it("fails clearly with no cache and no network", async () => {
    const request = vi.fn(async () => {
      throw new Error("ECONNREFUSED secret-host");
    });
    const failure = new RedumpDatSource({
      cacheDir: cacheDir(),
      fetch: request as unknown as typeof fetch
    }).load("Sony - PlayStation 2");
    await expect(failure).rejects.toThrow("Couldn't download the Redump checksum list");
    await expect(failure).rejects.not.toThrow(/secret-host/);
  });
});
