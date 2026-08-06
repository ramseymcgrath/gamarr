import { describe, expect, it } from "vitest";

import { handleDbiFile, handleDbiIndex } from "@/app/api/dbi/handlers";
import type { SwitchLibraryEntry } from "@/features/switch-library/models";
import type { FileOpener } from "@/features/switch-library/ports";

const entry: SwitchLibraryEntry = {
  name: "Metroid Prime 4.xci",
  absolutePath: "/library/gamarr-abc/gamarr-abc.xci",
  sizeBytes: 1000
};

function serviceOf(entries: SwitchLibraryEntry[], enabled = true) {
  return {
    isEnabled: () => enabled,
    index: async () => entries,
    resolve: async (name: string) => entries.find((e) => e.name === name) ?? null
  };
}

function openerOf(sizeBytes: number): FileOpener & { closed: number; ranges: number[][] } {
  const state = {
    closed: 0,
    ranges: [] as number[][],
    async open() {
      return {
        sizeBytes,
        stream(start: number, end: number) {
          state.ranges.push([start, end]);
          return new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(end - start + 1));
              controller.close();
            }
          });
        },
        close: async () => { state.closed += 1; }
      };
    }
  };
  return state as FileOpener & { closed: number; ranges: number[][] };
}

describe("handleDbiIndex", () => {
  it("404s when the feature is disabled", async () => {
    const response = await handleDbiIndex({ service: serviceOf([], false) });
    expect(response.status).toBe(404);
  });

  it("renders one anchor per entry with a percent-encoded href", async () => {
    const response = await handleDbiIndex({ service: serviceOf([entry]) });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(body).toContain('<a href="Metroid%20Prime%204.xci">Metroid Prime 4.xci</a>');
  });

  it("escapes HTML metacharacters in a name", async () => {
    const response = await handleDbiIndex({
      service: serviceOf([{ ...entry, name: 'a&b"<c>.xci' }])
    });
    const body = await response.text();

    expect(body).not.toContain("<c>");
    expect(body).toContain("&amp;");
    expect(body).toContain("&lt;c&gt;");
  });

  it("renders an empty index without failing", async () => {
    const response = await handleDbiIndex({ service: serviceOf([]) });
    expect(response.status).toBe(200);
  });
});

describe("handleDbiFile", () => {
  it("404s when the feature is disabled", async () => {
    const response = await handleDbiFile(
      entry.name,
      new Request("http://x/"),
      { service: serviceOf([entry], false), opener: openerOf(1000) }
    );
    expect(response.status).toBe(404);
  });

  it("404s for an unknown name", async () => {
    const response = await handleDbiFile(
      "Nope.xci",
      new Request("http://x/"),
      { service: serviceOf([entry]), opener: openerOf(1000) }
    );
    expect(response.status).toBe(404);
  });

  it("404s when the file vanished between scan and open", async () => {
    const response = await handleDbiFile(
      entry.name,
      new Request("http://x/"),
      { service: serviceOf([entry]), opener: { open: async () => null } }
    );
    expect(response.status).toBe(404);
  });

  it("serves the whole file with Accept-Ranges when no range is asked for", async () => {
    const opener = openerOf(1000);
    const response = await handleDbiFile(
      entry.name,
      new Request("http://x/"),
      { service: serviceOf([entry]), opener }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-length")).toBe("1000");
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(opener.ranges).toEqual([[0, 999]]);
  });

  it("serves a 206 for a closed range", async () => {
    const opener = openerOf(1000);
    const response = await handleDbiFile(
      entry.name,
      new Request("http://x/", { headers: { range: "bytes=100-199" } }),
      { service: serviceOf([entry]), opener }
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 100-199/1000");
    expect(response.headers.get("content-length")).toBe("100");
    expect(opener.ranges).toEqual([[100, 199]]);
  });

  it("serves a 206 to the end for an open-ended resume range", async () => {
    const opener = openerOf(1000);
    const response = await handleDbiFile(
      entry.name,
      new Request("http://x/", { headers: { range: "bytes=900-" } }),
      { service: serviceOf([entry]), opener }
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 900-999/1000");
    expect(response.headers.get("content-length")).toBe("100");
  });

  it("416s an unsatisfiable range and closes the handle", async () => {
    const opener = openerOf(1000);
    const response = await handleDbiFile(
      entry.name,
      new Request("http://x/", { headers: { range: "bytes=5000-" } }),
      { service: serviceOf([entry]), opener }
    );

    expect(response.status).toBe(416);
    expect(response.headers.get("content-range")).toBe("bytes */1000");
    expect(opener.closed).toBe(1);
    expect(opener.ranges).toEqual([]);
  });

  it("never leaks an absolute path in an error body", async () => {
    const response = await handleDbiFile(
      "Nope.xci",
      new Request("http://x/"),
      { service: serviceOf([entry]), opener: openerOf(1000) }
    );

    expect(await response.text()).not.toContain("/library");
  });
});
