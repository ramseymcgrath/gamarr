import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

const databasePath = process.env.GAMARR_DATABASE_PATH ?? "/config/gamarr.db";
const migrationsFolder = process.env.GAMARR_MIGRATIONS_PATH ??
  path.resolve("drizzle");
const directory = path.dirname(databasePath);

mkdirSync(directory, { recursive: true, mode: 0o700 });
chmodSync(directory, 0o700);

const client = new BetterSqlite3(databasePath);
try {
  client.pragma("foreign_keys = ON");
  client.pragma("journal_mode = WAL");
  client.pragma("busy_timeout = 250");
  migrate(drizzle(client), { migrationsFolder });
  chmodSync(databasePath, 0o600);
} finally {
  client.close();
}
