import { describe, expect, it } from "vitest";

import { collectionsDir } from "@/lib/collections-dir";

describe("collectionsDir", () => {
  it("defaults next to the database", () => {
    expect(collectionsDir({ GAMARR_DATABASE_PATH: "/config/gamarr.db" }))
      .toBe("/config/collections");
  });

  it("falls back to /config when no database path is set", () => {
    expect(collectionsDir({})).toBe("/config/collections");
  });

  it("lets the env override win", () => {
    expect(collectionsDir({
      GAMARR_DATABASE_PATH: "/config/gamarr.db",
      GAMARR_COLLECTIONS_DIR: "/data/collections"
    })).toBe("/data/collections");
  });
});
