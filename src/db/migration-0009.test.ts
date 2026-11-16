import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createDatabase } from "@/db/client";
import { migrateDatabase } from "@/db/migrate";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("migration 0009", () => {
  it("keeps download_verifications rows through the download_attempts rebuild", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "gamarr-mig-0009-"));
    directories.push(directory);
    const full = path.resolve("drizzle");
    const partial = path.join(directory, "drizzle-0008");
    cpSync(full, partial, { recursive: true });
    const journalPath = path.join(partial, "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      entries: Array<{ tag: string }>;
    };
    const index = journal.entries.findIndex((e) => e.tag.startsWith("0009"));
    expect(index).toBeGreaterThan(0);
    journal.entries = journal.entries.slice(0, index);
    writeFileSync(journalPath, JSON.stringify(journal));

    // Same client and migrator path as the app: foreign_keys = ON.
    const database = createDatabase(path.join(directory, "gamarr.db"));
    const client = database.$client;
    expect(client.pragma("foreign_keys", { simple: true })).toBe(1);
    migrateDatabase(database, partial);

    client.exec(`
      INSERT INTO games (id, title, slug, cached_at) VALUES (1, 'Game', 'game', 1);
      INSERT INTO platforms (id, name, last_synced_at) VALUES (130, 'Switch', 1);
      INSERT INTO library_entries (id, game_id, platform_id, created_at, updated_at)
        VALUES ('lib', 1, 130, 1, 1);
      INSERT INTO download_attempts (id, library_entry_id, submission_key, request_fingerprint,
        status, source, release_title, indexer_name_snapshot, sabnzbd_config_revision,
        sab_marker, created_at, updated_at)
        VALUES ('a1', 'lib', 'k', 'f', 'Completed', 'newznab', 'T', 'I', 1, 'm', 1, 1);
      INSERT INTO download_verifications (attempt_id, status, file_name, sha1, serial,
        redump_name, detail, requested_at, checked_at, updated_at,
        export_status, export_path, export_detail, exported_at)
        VALUES ('a1', 'Verified', 'g.iso', 'abc', 'SLUS-1', 'Game (USA)', 'ok', 5, 6, 7,
        'Exported', '/ps2/g.iso', 'done', 8);
    `);
    const before = client.prepare("SELECT * FROM download_verifications").all();
    expect(before).toHaveLength(1);

    migrateDatabase(database, full);

    expect(client.prepare("SELECT * FROM download_verifications").all()).toEqual(before);
    expect(client.prepare("SELECT id FROM download_attempts").all()).toEqual([{ id: "a1" }]);
    expect(client.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    client.exec(`
      INSERT INTO download_attempts (id, library_entry_id, submission_key, request_fingerprint,
        status, source, release_title, indexer_name_snapshot, sabnzbd_config_revision,
        sab_marker, created_at, updated_at)
        VALUES ('a2', 'lib', 'k2', 'f2', 'Queued', 'collection-torrent', 'T', 'I', 1, 'm2', 1, 1);
    `);
    client.close();
  });
});
