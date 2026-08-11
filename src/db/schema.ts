import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex
} from "drizzle-orm/sqlite-core";

const jsonText = <T>(name: string) => text(name, { mode: "json" }).$type<T>();

export const games = sqliteTable("games", {
  id: integer("id").primaryKey(),
  title: text("title").notNull(),
  slug: text("slug").notNull(),
  summary: text("summary"),
  coverId: text("cover_id"),
  releaseYear: integer("release_year"),
  genres: jsonText<string[]>("genres").notNull().default([]),
  alternateTitles: jsonText<string[]>("alternate_titles").notNull().default([]),
  platformIds: jsonText<number[]>("platform_ids").notNull().default([]),
  cachedAt: integer("cached_at").notNull()
});

export const platforms = sqliteTable("platforms", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
  abbreviation: text("abbreviation"),
  generation: integer("generation"),
  providerChecksum: text("provider_checksum"),
  lastSyncedAt: integer("last_synced_at").notNull()
});

export const platformSettings = sqliteTable("platform_settings", {
  platformId: integer("platform_id")
    .primaryKey()
    .references(() => platforms.id, { onDelete: "cascade" }),
  visible: integer("visible", { mode: "boolean" }).notNull().default(false),
  aliases: jsonText<string[]>("aliases").notNull().default([]),
  categoryIds: jsonText<string[]>("category_ids").notNull().default([])
});

export const platformPopularGames = sqliteTable("platform_popular_games", {
  platformId: integer("platform_id")
    .primaryKey()
    .references(() => platforms.id, { onDelete: "cascade" }),
  gameIds: jsonText<number[]>("game_ids").notNull().default([]),
  fetchedAt: integer("fetched_at").notNull()
});

export const platformCategories = sqliteTable(
  "platform_categories",
  {
    platformId: integer("platform_id")
      .notNull()
      .references(() => platforms.id, { onDelete: "cascade" }),
    categoryId: text("category_id").notNull()
  },
  (table) => [
    primaryKey({ columns: [table.platformId, table.categoryId] })
  ]
);

export const igdbSettings = sqliteTable("igdb_settings", {
  id: integer("id").primaryKey().default(1),
  clientId: text("client_id").notNull(),
  clientSecret: text("client_secret").notNull(),
  lastTestStatus: text("last_test_status"),
  lastTestedAt: integer("last_tested_at"),
  configRevision: integer("config_revision").notNull().default(1),
  updatedAt: integer("updated_at").notNull()
}, (table) => [
  check("igdb_singleton", sql`${table.id} = 1`)
]);

export const sabnzbdSettings = sqliteTable("sabnzbd_settings", {
  id: integer("id").primaryKey().default(1),
  baseUrl: text("base_url").notNull(),
  apiKey: text("api_key").notNull(),
  defaultCategory: text("default_category"),
  maxNzbBytes: integer("max_nzb_bytes").notNull().default(20 * 1024 * 1024),
  lastTestStatus: text("last_test_status"),
  lastTestedAt: integer("last_tested_at"),
  configRevision: integer("config_revision").notNull().default(1),
  updatedAt: integer("updated_at").notNull()
}, (table) => [
  check("sabnzbd_singleton", sql`${table.id} = 1`),
  check(
    "sabnzbd_nzb_size_range",
    sql`${table.maxNzbBytes} between ${sql.raw("1048576")} and ${sql.raw("104857600")}`
  )
]);

export const prowlarrSettings = sqliteTable("prowlarr_settings", {
  id: integer("id").primaryKey().default(1),
  baseUrl: text("base_url").notNull(),
  apiKey: text("api_key").notNull(),
  timeoutMs: integer("timeout_ms").notNull().default(10_000),
  lastTestStatus: text("last_test_status"),
  lastTestedAt: integer("last_tested_at"),
  configRevision: integer("config_revision").notNull().default(1),
  updatedAt: integer("updated_at").notNull()
}, (table) => [
  check("prowlarr_singleton", sql`${table.id} = 1`),
  check(
    "prowlarr_timeout_range",
    sql`${table.timeoutMs} between 1000 and 30000`
  )
]);

export const qbittorrentSettings = sqliteTable("qbittorrent_settings", {
  id: integer("id").primaryKey().default(1),
  baseUrl: text("base_url").notNull(),
  username: text("username").notNull(),
  password: text("password").notNull(),
  defaultCategory: text("default_category"),
  lastTestStatus: text("last_test_status"),
  lastTestedAt: integer("last_tested_at"),
  configRevision: integer("config_revision").notNull().default(1),
  updatedAt: integer("updated_at").notNull()
}, (table) => [
  check("qbittorrent_singleton", sql`${table.id} = 1`)
]);

export const libraryEntries = sqliteTable(
  "library_entries",
  {
    id: text("id").primaryKey(),
    gameId: integer("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "restrict" }),
    platformId: integer("platform_id")
      .notNull()
      .references(() => platforms.id, { onDelete: "restrict" }),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull()
  },
  (table) => [
    uniqueIndex("library_game_platform_unique").on(table.gameId, table.platformId)
  ]
);

export const releaseCandidates = sqliteTable(
  "release_candidates",
  {
    id: text("id").primaryKey(),
    expiresAt: integer("expires_at").notNull(),
    protocol: text("protocol").notNull(),
    indexerId: text("indexer_id"),
    indexerConfigRevision: integer("indexer_config_revision").notNull(),
    guid: text("guid").notNull(),
    title: text("title").notNull(),
    size: integer("size"),
    seeders: integer("seeders"),
    downloadPath: text("download_path").notNull(),
    category: text("category"),
    sourceSnapshot: text("source_snapshot").notNull(),
    createdAt: integer("created_at").notNull()
  },
  (table) => [
    index("release_candidates_expiry_idx").on(table.expiresAt),
    check(
      "release_candidates_protocol_valid",
      sql`${table.protocol} in ('usenet', 'torrent')`
    )
  ]
);

export const downloadAttempts = sqliteTable(
  "download_attempts",
  {
    id: text("id").primaryKey(),
    libraryEntryId: text("library_entry_id")
      .notNull()
      .references(() => libraryEntries.id, { onDelete: "cascade" }),
    submissionKey: text("submission_key").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    status: text("status").notNull(),
    source: text("source").notNull().default("newznab"),
    releaseTitle: text("release_title").notNull(),
    indexerId: text("indexer_id"),
    indexerNameSnapshot: text("indexer_name_snapshot").notNull(),
    indexerUrlSnapshot: text("indexer_url_snapshot"),
    newznabGuid: text("newznab_guid"),
    iaFileName: text("ia_file_name"),
    torrentHash: text("torrent_hash"),
    selectedFiles: text("selected_files"),
    filesAppliedAt: integer("files_applied_at"),
    size: integer("size"),
    category: text("category"),
    sabnzbdConfigRevision: integer("sabnzbd_config_revision").notNull(),
    sabMarker: text("sab_marker").notNull(),
    sabJobId: text("sab_job_id"),
    progress: integer("progress").notNull().default(0),
    failureDetail: text("failure_detail"),
    sabRequestStartedAt: integer("sab_request_started_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    completedAt: integer("completed_at")
  },
  (table) => [
    uniqueIndex("download_attempts_submission_key_unique").on(table.submissionKey),
    uniqueIndex("download_attempts_marker_unique").on(table.sabMarker),
    uniqueIndex("download_attempts_sab_job_unique")
      .on(table.sabnzbdConfigRevision, table.sabJobId)
      .where(sql`${table.sabJobId} is not null`),
    index("download_attempts_library_idx").on(table.libraryEntryId),
    check(
      "download_attempts_status_valid",
      sql`${table.status} in ('Pending', 'Submitting', 'Queued', 'Downloading', 'Completed', 'Failed', 'Unknown')`
    ),
    check(
      "download_attempts_progress_range",
      sql`${table.progress} between 0 and 100`
    ),
    check(
      "download_attempts_size_nonnegative",
      sql`${table.size} is null or ${table.size} >= 0`
    ),
    check(
      "download_attempts_source_valid",
      sql`${table.source} in ('prowlarr-usenet', 'prowlarr-torrent', 'newznab', 'internet-archive', 'internet-archive-torrent')`
    )
  ]
);
