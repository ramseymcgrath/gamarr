import { describe, expect, it, vi } from "vitest";

import { InternetArchiveClient } from "@/integrations/internet-archive/client";

const jsonResponse = (payload: unknown, status = 200) => new Response(
  JSON.stringify(payload),
  { status, headers: { "content-type": "application/json" } }
);

describe("InternetArchiveClient search", () => {
  it("builds a bounded software query and maps documents", async () => {
    const request = vi.fn<(input: RequestInfo | URL) => Promise<Response>>(
      async () => jsonResponse({
      response: {
        docs: [{
          identifier: "game-name-usa",
          title: "Game Name (USA)",
          date: "1993-11-30T00:00:00Z",
          downloads: 1234,
          item_size: 4_194_304
        }]
      }
    }));
    const client = new InternetArchiveClient({ fetch: request });

    const result = await client.search({ title: "Game: Name!" });

    const url = new URL(String(request.mock.calls[0]?.[0]));
    expect(url.origin).toBe("https://archive.org");
    expect(url.pathname).toBe("/advancedsearch.php");
    expect(url.searchParams.get("q")).toBe(
      'title:("Game Name") AND mediatype:software'
    );
    expect(url.searchParams.getAll("fl[]")).toEqual(
      expect.arrayContaining(["identifier", "title", "item_size"])
    );
    expect(result).toEqual({
      warnings: [],
      items: [{
        identifier: "game-name-usa",
        title: "Game Name (USA)",
        detailsUrl: "https://archive.org/details/game-name-usa",
        publishedAt: Date.parse("1993-11-30T00:00:00Z"),
        size: 4_194_304,
        downloads: 1234
      }]
    });
  });

  it("tolerates array facets and falls back to the year", async () => {
    const request = vi.fn(async () => jsonResponse({
      response: {
        docs: [{
          identifier: "multi",
          title: ["Game Name", "Alt Name"],
          year: "1991"
        }]
      }
    }));
    const client = new InternetArchiveClient({ fetch: request });

    const { items } = await client.search({ title: "Game Name" });

    expect(items[0]).toMatchObject({
      title: "Game Name Alt Name",
      publishedAt: Date.UTC(1991, 0, 1),
      size: null,
      downloads: 0
    });
  });

  it("reports an undated item as null rather than the epoch", async () => {
    const request = vi.fn(async () => jsonResponse({
      response: { docs: [{ identifier: "undated", title: "Game Name" }] }
    }));
    const client = new InternetArchiveClient({ fetch: request });

    const { items } = await client.search({ title: "Game Name" });

    expect(items[0]?.publishedAt).toBeNull();
  });

  it("reports an unparseable date and implausible year as null", async () => {
    const request = vi.fn(async () => jsonResponse({
      response: {
        docs: [{
          identifier: "nonsense",
          title: "Game Name",
          date: "not a date",
          year: "1200"
        }]
      }
    }));
    const client = new InternetArchiveClient({ fetch: request });

    const { items } = await client.search({ title: "Game Name" });

    expect(items[0]?.publishedAt).toBeNull();
  });

  it("skips results with unsafe identifiers instead of trusting them", async () => {
    const request = vi.fn(async () => jsonResponse({
      response: {
        docs: [
          { identifier: "../escape", title: "Bad" },
          { identifier: "fine-item", title: "Good" }
        ]
      }
    }));
    const client = new InternetArchiveClient({ fetch: request });

    const result = await client.search({ title: "Game" });

    expect(result.items.map((item) => item.identifier)).toEqual(["fine-item"]);
    expect(result.warnings).toHaveLength(1);
  });

  it("rejects an unexpected payload instead of returning partial data", async () => {
    const request = vi.fn(async () => jsonResponse({ unexpected: true }));
    const client = new InternetArchiveClient({ fetch: request });

    await expect(client.search({ title: "Game" })).rejects.toMatchObject({
      code: "UNAVAILABLE"
    });
  });

  it("returns nothing for a title with no searchable content", async () => {
    const request = vi.fn(async () => jsonResponse({}));
    const client = new InternetArchiveClient({ fetch: request });

    expect(await client.search({ title: "!!!" })).toEqual({
      items: [],
      warnings: []
    });
    expect(request).not.toHaveBeenCalled();
  });
});

describe("InternetArchiveClient metadata", () => {
  it("maps file sizes from strings and keeps provenance", async () => {
    const request = vi.fn<(input: RequestInfo | URL) => Promise<Response>>(
      async () => jsonResponse({
      files: [
        { name: "Game.zip", size: "1048576", format: "ZIP", source: "original" },
        { name: "Game_thumb.jpg", format: "JPEG", source: "derivative" },
        { name: "game_files.xml", format: "Metadata", source: "metadata" }
      ]
    }));
    const client = new InternetArchiveClient({ fetch: request });

    const files = await client.listFiles("game-item");

    const url = new URL(String(request.mock.calls[0]?.[0]));
    expect(url.pathname).toBe("/metadata/game-item");
    expect(files).toEqual([
      { name: "Game.zip", size: 1_048_576, format: "ZIP", source: "original" },
      { name: "Game_thumb.jpg", size: null, format: "JPEG", source: "derivative" },
      { name: "game_files.xml", size: null, format: "Metadata", source: "metadata" }
    ]);
  });

  it("finds one file by exact name", async () => {
    const request = vi.fn(async () => jsonResponse({
      files: [
        { name: "Game (USA).zip", size: "100", source: "original" },
        { name: "Game (Europe).zip", size: "200", source: "original" }
      ]
    }));
    const client = new InternetArchiveClient({ fetch: request });

    expect(await client.getFileInfo("item", "Game (Europe).zip"))
      .toMatchObject({ name: "Game (Europe).zip", size: 200 });
    expect(await client.getFileInfo("item", "Game (Japan).zip")).toBeNull();
  });

  it("rejects an unsafe identifier before any request", async () => {
    const request = vi.fn(async () => jsonResponse({}));
    const client = new InternetArchiveClient({ fetch: request });

    await expect(client.listFiles("../bad")).rejects.toMatchObject({
      code: "VALIDATION"
    });
    expect(request).not.toHaveBeenCalled();
  });
});

/**
 * A manifest entry is roughly 300 bytes, so the old shared 2 MiB ceiling broke
 * around 6,800 files and made large items rank in search but fail in the file
 * picker. The byteLength guard keeps the fixture honest: if the payload ever
 * shrinks below the old ceiling it stops covering the bug.
 */
function largeManifest(fileCount: number): { files: unknown[] } {
  const padding = "segment".repeat(20);
  return {
    files: Array.from({ length: fileCount }, (_, index) => ({
      name: `disc-${String(index).padStart(6, "0")}-${padding}.bin`,
      size: "1048576",
      format: "Binary",
      source: "original"
    }))
  };
}

describe("InternetArchiveClient response ceilings", () => {
  it("lists an item whose manifest exceeds the search ceiling", async () => {
    const payload = largeManifest(12_000);
    const encoded = new TextEncoder().encode(JSON.stringify(payload));
    expect(encoded.byteLength).toBeGreaterThan(2 * 1024 * 1024);
    const request = vi.fn(async () => jsonResponse(payload));
    const client = new InternetArchiveClient({ fetch: request });

    const files = await client.listFiles("huge-item");

    expect(files).toHaveLength(12_000);
  });

  it("names the metadata knob when an item is too large to list", async () => {
    const request = vi.fn(async () => jsonResponse(largeManifest(50)));
    const client = new InternetArchiveClient({
      fetch: request,
      maxMetadataBytes: 1024
    });

    const error = await client.listFiles("huge-item").catch((cause) => cause);

    expect(error).toMatchObject({ code: "UNAVAILABLE", status: 502 });
    expect(error.message).toMatch(/too many files to list/);
    expect(error.message).toContain("GAMARR_IA_METADATA_MAX_BYTES");
    expect(error.message).not.toContain("archive.org");
  });

  it("applies the metadata ceiling to the submit path too", async () => {
    const request = vi.fn(async () => jsonResponse(largeManifest(50)));
    const client = new InternetArchiveClient({
      fetch: request,
      maxMetadataBytes: 1024
    });

    await expect(client.getFileInfo("huge-item", "any.bin")).rejects
      .toMatchObject({
        code: "UNAVAILABLE",
        message: expect.stringContaining("GAMARR_IA_METADATA_MAX_BYTES")
      });
  });

  it("keeps the search and metadata ceilings independent", async () => {
    const payload = largeManifest(12_000);
    const request = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes("/metadata/")
        ? jsonResponse(payload)
        : jsonResponse({ response: { docs: [] } }));
    const client = new InternetArchiveClient({
      fetch: request,
      maxSearchBytes: 8
    });

    const error = await client.search({ title: "Game" }).catch((cause) => cause);

    expect(error).toMatchObject({
      code: "UNAVAILABLE",
      message: "Internet Archive response is too large"
    });
    await expect(client.listFiles("huge-item")).resolves.toHaveLength(12_000);
  });
});
