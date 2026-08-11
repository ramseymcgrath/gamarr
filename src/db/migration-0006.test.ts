import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let directory: string;
let databasePath: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "gamarr-migration-"));
  databasePath = join(directory, "gamarr.db");
  applied = new Set();
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

/** Tags already applied to the current temp database. Reset per test. */
let applied: Set<string>;

/**
 * Applies not-yet-applied migrations in journal order, stopping after
 * `through` (inclusive). Resumable on purpose: a test seeds at 0005, then
 * calls this again for 0006, and replaying 0000 would fail on
 * "table download_attempts already exists".
 */
function applyMigrations(through: string): void {
  const journal = JSON.parse(
    readFileSync(join(process.cwd(), "drizzle/meta/_journal.json"), "utf8")
  ) as { entries: Array<{ tag: string }> };
  const database = new Database(databasePath);
  database.pragma("foreign_keys = ON");
  for (const entry of journal.entries) {
    if (!applied.has(entry.tag)) {
      const sql = readFileSync(
        join(process.cwd(), "drizzle", `${entry.tag}.sql`),
        "utf8"
      );
      for (const statement of sql.split("--> statement-breakpoint")) {
        const trimmed = statement.trim();
        if (trimmed.length > 0) database.exec(trimmed);
      }
      applied.add(entry.tag);
    }
    if (entry.tag.startsWith(through)) break;
  }
  database.close();
}

function open(): Database.Database {
  const database = new Database(databasePath);
  database.pragma("foreign_keys = ON");
  return database;
}

const legacySources = [
  "newznab",
  "internet-archive",
  "internet-archive-torrent"
] as const;

function seedAttempts(): void {
  const database = open();
  database.exec(`
    INSERT INTO platforms (id, name, last_synced_at)
      VALUES (1, 'Switch', 1000);
    INSERT INTO games (id, title, slug, cached_at)
      VALUES (1, 'Metroid Prime', 'metroid-prime', 1000);
    INSERT INTO library_entries (id, game_id, platform_id, created_at, updated_at)
      VALUES ('lib-1', 1, 1, 1000, 1000);
  `);
  const insert = database.prepare(`
    INSERT INTO download_attempts (
      id, library_entry_id, submission_key, request_fingerprint, status, source,
      release_title, indexer_name_snapshot, sabnzbd_config_revision, sab_marker,
      progress, created_at, updated_at, completed_at
    ) VALUES (?, 'lib-1', ?, ?, ?, ?, ?, ?, 1, ?, ?, 1000, 2000, ?)
  `);
  legacySources.forEach((source, index) => {
    insert.run(
      `attempt-${index}`,
      `key-${index}`,
      `fingerprint-${index}`,
      index === 0 ? "Completed" : "Downloading",
      source,
      `Release ${index}`,
      `Indexer ${index}`,
      `marker-${index}`,
      index * 10,
      index === 0 ? 3000 : null
    );
  });
  database.close();
}

const preservedColumns = [
  "id", "source", "status", "release_title", "indexer_name_snapshot",
  "sab_marker", "progress", "created_at", "completed_at"
].join(", ");

describe("migration 0006", () => {
  it("preserves every download attempt across the rebuild", () => {
    applyMigrations("0005");
    seedAttempts();

    const before = open();
    const expected = before
      .prepare(`SELECT ${preservedColumns} FROM download_attempts ORDER BY id`)
      .all();
    before.close();
    expect(expected).toHaveLength(3);

    applyMigrations("0006");

    const after = open();
    const actual = after
      .prepare(`SELECT ${preservedColumns} FROM download_attempts ORDER BY id`)
      .all();
    const blanks = after
      .prepare(
        "SELECT selected_files, files_applied_at FROM download_attempts"
      )
      .all() as Array<{ selected_files: unknown; files_applied_at: unknown }>;
    after.close();

    expect(actual).toEqual(expected);
    for (const row of blanks) {
      expect(row.selected_files).toBeNull();
      expect(row.files_applied_at).toBeNull();
    }
  });

  it("folds platform indexer categories into platform categories", () => {
    applyMigrations("0005");
    const seed = open();
    seed.exec(`
      INSERT INTO platforms (id, name, last_synced_at)
        VALUES (1, 'Switch', 1000);
      INSERT INTO indexers (
        id, name, base_url, api_key, enabled, timeout_ms,
        config_revision, created_at, updated_at
      ) VALUES
        ('a', 'A', 'http://a.test/api', 'k', 1, 10000, 1, 1000, 1000),
        ('b', 'B', 'http://b.test/api', 'k', 1, 10000, 1, 1000, 1000);
      INSERT INTO platform_indexer_categories (platform_id, indexer_id, category_id)
        VALUES (1, 'a', '1080'), (1, 'b', '1080'), (1, 'a', '4000');
    `);
    seed.close();

    applyMigrations("0006");

    const database = open();
    const rows = database
      .prepare(
        "SELECT category_id FROM platform_categories WHERE platform_id = 1"
        + " ORDER BY category_id"
      )
      .all() as Array<{ category_id: string }>;
    database.close();
    expect(rows.map((row) => row.category_id)).toEqual(["1080", "4000"]);
  });

  it("drops the indexers table", () => {
    applyMigrations("0006");
    const database = open();
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>;
    const names = tables.map((row) => row.name);
    database.close();
    expect(names).not.toContain("indexers");
    expect(names).not.toContain("platform_indexer_categories");
    expect(names).toContain("prowlarr_settings");
    expect(names).toContain("platform_categories");
  });
});
