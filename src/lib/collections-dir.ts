import path from "node:path";

/** Where operators drop collection `.torrent` files, one folder per platform. */
export function collectionsDir(
  env: Record<string, string | undefined> = process.env
): string {
  const override = env.GAMARR_COLLECTIONS_DIR?.trim();
  if (override) return override;
  const databasePath = env.GAMARR_DATABASE_PATH ?? "/config/gamarr.db";
  return path.join(path.dirname(databasePath), "collections");
}
