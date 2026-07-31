import "server-only";

import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

import * as schema from "@/db/schema";

export type Database = BetterSQLite3Database<typeof schema> & {
  $client: BetterSqlite3.Database;
};

export function createDatabase(databasePath: string): Database {
  const directory = path.dirname(databasePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);

  const client = new BetterSqlite3(databasePath);
  client.pragma("foreign_keys = ON");
  client.pragma("journal_mode = WAL");
  client.pragma("busy_timeout = 250");
  chmodSync(databasePath, 0o600);

  return drizzle(client, { schema }) as Database;
}

let singleton: Database | undefined;

export function getDatabase(): Database {
  singleton ??= createDatabase(
    process.env.GAMARR_DATABASE_PATH ?? "/config/gamarr.db"
  );
  return singleton;
}
