import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

export default function globalSetup() {
  const directory = path.resolve("test-results/e2e");
  const databasePath = path.join(directory, "gamarr.db");
  mkdirSync(directory, { recursive: true });
  rmSync(databasePath, { force: true });
  rmSync(`${databasePath}-shm`, { force: true });
  rmSync(`${databasePath}-wal`, { force: true });
  const client = new BetterSqlite3(databasePath);
  try {
    migrate(drizzle(client), { migrationsFolder: path.resolve("drizzle") });
  } finally {
    client.close();
  }
}
