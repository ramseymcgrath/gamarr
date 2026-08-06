import { mkdirSync } from "node:fs";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

/**
 * Migrates the e2e fixture database.
 *
 * This must NOT delete the database file. Playwright starts `webServer` before
 * `globalSetup` (see createGlobalSetupTasks: output-dir cleanup, then plugin
 * setup which launches webServer, then globalSetup). The dev server answers the
 * /api/health readiness probe by calling getDatabase(), which opens — and, when
 * the file is absent, creates — the database and caches the connection in a
 * module singleton.
 *
 * Deleting the file here therefore unlinks the inode the running server already
 * holds open. The server keeps reading an orphaned, empty database and every
 * query fails with "no such table", surfacing as an opaque 500.
 *
 * Freshness is already guaranteed: Playwright removes the output directory
 * (test-results/) before any server starts, so the file this migrates is always
 * new. Migrating it in place keeps the server's existing handle valid.
 */
export default function globalSetup() {
  const directory = path.resolve("test-results/e2e");
  const databasePath = path.join(directory, "gamarr.db");
  mkdirSync(directory, { recursive: true });
  const client = new BetterSqlite3(databasePath);
  try {
    migrate(drizzle(client), { migrationsFolder: path.resolve("drizzle") });
  } finally {
    client.close();
  }
}
