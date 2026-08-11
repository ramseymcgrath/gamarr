import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createDatabase } from "@/db/client";
import { migrateDatabase } from "@/db/migrate";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function migratedDatabase() {
  const directory = mkdtempSync(path.join(tmpdir(), "gamarr-migrate-"));
  temporaryDirectories.push(directory);
  const database = createDatabase(path.join(directory, "gamarr.db"));
  migrateDatabase(database, path.resolve("drizzle"));
  return database;
}

describe("migrateDatabase", () => {
  it("creates the complete initial schema and can run twice", () => {
    const database = migratedDatabase();

    expect(() => migrateDatabase(database, path.resolve("drizzle"))).not.toThrow();
    const tables = database.$client
      .prepare("select name from sqlite_master where type = 'table' order by name")
      .all()
      .map((row) => (row as { name: string }).name);

    expect(tables).toEqual(expect.arrayContaining([
      "download_attempts",
      "games",
      "igdb_settings",
      "library_entries",
      "platform_categories",
      "platform_settings",
      "platforms",
      "prowlarr_settings",
      "release_candidates",
      "sabnzbd_settings"
    ]));

    database.$client.close();
  });

  it("enforces one library entry per game and platform", () => {
    const database = migratedDatabase();
    const sql = database.$client;
    sql.prepare("insert into games (id, title, slug, cached_at) values (1, 'Game', 'game', 1)").run();
    sql.prepare("insert into platforms (id, name, last_synced_at) values (2, 'Console', 1)").run();
    sql.prepare("insert into library_entries (id, game_id, platform_id, created_at, updated_at) values ('a', 1, 2, 1, 1)").run();

    expect(() => {
      sql.prepare("insert into library_entries (id, game_id, platform_id, created_at, updated_at) values ('b', 1, 2, 1, 1)").run();
    }).toThrow(/UNIQUE/);

    database.$client.close();
  });

  it("enforces attempt state, progress, and submission key constraints", () => {
    const database = migratedDatabase();
    const sql = database.$client;
    sql.prepare("insert into games (id, title, slug, cached_at) values (1, 'Game', 'game', 1)").run();
    sql.prepare("insert into platforms (id, name, last_synced_at) values (2, 'Console', 1)").run();
    sql.prepare("insert into library_entries (id, game_id, platform_id, created_at, updated_at) values ('library', 1, 2, 1, 1)").run();
    sql.prepare(`
      insert into download_attempts (
        id, library_entry_id, submission_key, request_fingerprint, status,
        release_title, indexer_name_snapshot, sabnzbd_config_revision,
        sab_marker, progress, created_at, updated_at
      ) values ('attempt', 'library', 'key', 'fingerprint', 'Pending',
        'Release', 'Indexer', 1, 'gamarr-attempt', 0, 1, 1)
    `).run();

    expect(() => {
      sql.prepare(`
        insert into download_attempts (
          id, library_entry_id, submission_key, request_fingerprint, status,
          release_title, indexer_name_snapshot, sabnzbd_config_revision,
          sab_marker, progress, created_at, updated_at
        ) values ('duplicate', 'library', 'key', 'other', 'Pending',
          'Release', 'Indexer', 1, 'gamarr-duplicate', 0, 1, 1)
      `).run();
    }).toThrow(/UNIQUE/);

    expect(() => {
      sql.prepare(`
        insert into download_attempts (
          id, library_entry_id, submission_key, request_fingerprint, status,
          release_title, indexer_name_snapshot, sabnzbd_config_revision,
          sab_marker, progress, created_at, updated_at
        ) values ('invalid', 'library', 'new-key', 'fingerprint', 'Impossible',
          'Release', 'Indexer', 1, 'gamarr-invalid', 101, 1, 1)
      `).run();
    }).toThrow(/CHECK/);

    database.$client.close();
  });

  it("reopens post-processing failures without touching genuine ones", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "gamarr-upgrade-"));
    temporaryDirectories.push(directory);

    // Migrate only as far as 0001 so the repair in 0002 has legacy rows to act
    // on, mirroring a real upgrade rather than a fresh install. Everything
    // after 0001 is filtered out — applying a later migration here would make
    // drizzle's migrator treat 0002 as out-of-order and skip it.
    const priorMigrations = path.join(directory, "drizzle");
    cpSync(path.resolve("drizzle"), priorMigrations, { recursive: true });
    const journalPath = path.join(priorMigrations, "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      entries: { tag: string }[];
    };
    journal.entries = journal.entries.filter((entry) => entry.tag < "0002");
    writeFileSync(journalPath, JSON.stringify(journal, null, 2));

    const database = createDatabase(path.join(directory, "gamarr.db"));
    migrateDatabase(database, priorMigrations);
    const sql = database.$client;
    sql.prepare("insert into games (id, title, slug, cached_at) values (1, 'Game', 'game', 1)").run();
    sql.prepare("insert into platforms (id, name, last_synced_at) values (2, 'Console', 1)").run();
    sql.prepare("insert into library_entries (id, game_id, platform_id, created_at, updated_at) values ('library', 1, 2, 1, 1)").run();
    const insertAttempt = sql.prepare(`
      insert into download_attempts (
        id, library_entry_id, submission_key, request_fingerprint, status,
        release_title, indexer_name_snapshot, sabnzbd_config_revision,
        sab_marker, progress, failure_detail, created_at, updated_at
      ) values (?, 'library', ?, 'fingerprint', 'Failed',
        'Release', 'Indexer', 1, ?, 0, ?, 1, 1)
    `);
    insertAttempt.run("mislabelled", "key-a", "gamarr-a", "Extracting");
    insertAttempt.run("genuine", "key-b", "gamarr-b", "Failed");

    migrateDatabase(database, path.resolve("drizzle"));

    expect(sql.prepare("select status, failure_detail from download_attempts where id = 'mislabelled'").get())
      .toEqual({ status: "Unknown", failure_detail: null });
    expect(sql.prepare("select status, failure_detail from download_attempts where id = 'genuine'").get())
      .toEqual({ status: "Failed", failure_detail: "Failed" });

    sql.close();
  });

  it("rolls back a failed transaction", () => {
    const database = migratedDatabase();

    expect(() => {
      database.$client.transaction(() => {
        database.$client.prepare("insert into games (id, title, slug, cached_at) values (1, 'Game', 'game', 1)").run();
        throw new Error("abort");
      })();
    }).toThrow("abort");

    expect(database.$client.prepare("select count(*) as count from games").get()).toEqual({ count: 0 });
    database.$client.close();
  });
});
