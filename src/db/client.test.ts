import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createDatabase } from "@/db/client";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("createDatabase", () => {
  it("enables foreign keys, WAL, and a bounded busy timeout", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "gamarr-db-"));
    temporaryDirectories.push(directory);

    const database = createDatabase(path.join(directory, "gamarr.db"));

    expect(database.$client.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(database.$client.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(database.$client.pragma("busy_timeout", { simple: true })).toBe(250);

    database.$client.close();
  });
});
