import "server-only";

import { migrate } from "drizzle-orm/better-sqlite3/migrator";

import type { Database } from "@/db/client";

export function migrateDatabase(
  database: Database,
  migrationsFolder: string
): void {
  migrate(database, { migrationsFolder });
}
