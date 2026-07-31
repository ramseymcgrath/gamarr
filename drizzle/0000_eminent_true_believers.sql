CREATE TABLE `download_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`library_entry_id` text NOT NULL,
	`submission_key` text NOT NULL,
	`request_fingerprint` text NOT NULL,
	`status` text NOT NULL,
	`release_title` text NOT NULL,
	`indexer_id` text,
	`indexer_name_snapshot` text NOT NULL,
	`indexer_url_snapshot` text,
	`newznab_guid` text,
	`size` integer,
	`category` text,
	`sabnzbd_config_revision` integer NOT NULL,
	`sab_marker` text NOT NULL,
	`sab_job_id` text,
	`progress` integer DEFAULT 0 NOT NULL,
	`failure_detail` text,
	`sab_request_started_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`library_entry_id`) REFERENCES `library_entries`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`indexer_id`) REFERENCES `indexers`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "download_attempts_status_valid" CHECK("download_attempts"."status" in ('Pending', 'Submitting', 'Queued', 'Downloading', 'Completed', 'Failed', 'Unknown')),
	CONSTRAINT "download_attempts_progress_range" CHECK("download_attempts"."progress" between 0 and 100),
	CONSTRAINT "download_attempts_size_nonnegative" CHECK("download_attempts"."size" is null or "download_attempts"."size" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `download_attempts_submission_key_unique` ON `download_attempts` (`submission_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `download_attempts_marker_unique` ON `download_attempts` (`sab_marker`);--> statement-breakpoint
CREATE UNIQUE INDEX `download_attempts_sab_job_unique` ON `download_attempts` (`sabnzbd_config_revision`,`sab_job_id`) WHERE "download_attempts"."sab_job_id" is not null;--> statement-breakpoint
CREATE INDEX `download_attempts_library_idx` ON `download_attempts` (`library_entry_id`);--> statement-breakpoint
CREATE TABLE `games` (
	`id` integer PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`slug` text NOT NULL,
	`summary` text,
	`cover_id` text,
	`release_year` integer,
	`genres` text DEFAULT '[]' NOT NULL,
	`alternate_titles` text DEFAULT '[]' NOT NULL,
	`cached_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `igdb_settings` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`client_id` text NOT NULL,
	`client_secret` text NOT NULL,
	`last_test_status` text,
	`last_tested_at` integer,
	`config_revision` integer DEFAULT 1 NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "igdb_singleton" CHECK("igdb_settings"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `indexers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`base_url` text NOT NULL,
	`api_key` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`category_ids` text DEFAULT '[]' NOT NULL,
	`timeout_ms` integer DEFAULT 10000 NOT NULL,
	`config_revision` integer DEFAULT 1 NOT NULL,
	`last_test_status` text,
	`last_tested_at` integer,
	`deleted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "indexers_timeout_range" CHECK("indexers"."timeout_ms" between 1000 and 30000)
);
--> statement-breakpoint
CREATE TABLE `library_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`game_id` integer NOT NULL,
	`platform_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`platform_id`) REFERENCES `platforms`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `library_game_platform_unique` ON `library_entries` (`game_id`,`platform_id`);--> statement-breakpoint
CREATE TABLE `platform_indexer_categories` (
	`platform_id` integer NOT NULL,
	`indexer_id` text NOT NULL,
	`category_id` text NOT NULL,
	PRIMARY KEY(`platform_id`, `indexer_id`, `category_id`),
	FOREIGN KEY (`platform_id`) REFERENCES `platforms`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`indexer_id`) REFERENCES `indexers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `platform_settings` (
	`platform_id` integer PRIMARY KEY NOT NULL,
	`visible` integer DEFAULT false NOT NULL,
	`aliases` text DEFAULT '[]' NOT NULL,
	`category_ids` text DEFAULT '[]' NOT NULL,
	FOREIGN KEY (`platform_id`) REFERENCES `platforms`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `platforms` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`abbreviation` text,
	`generation` integer,
	`provider_checksum` text,
	`last_synced_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `release_candidates` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`indexer_id` text NOT NULL,
	`indexer_config_revision` integer NOT NULL,
	`guid` text NOT NULL,
	`title` text NOT NULL,
	`size` integer,
	`download_path` text NOT NULL,
	`category` text,
	`source_snapshot` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`indexer_id`) REFERENCES `indexers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `release_candidates_expiry_idx` ON `release_candidates` (`expires_at`);--> statement-breakpoint
CREATE TABLE `sabnzbd_settings` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`base_url` text NOT NULL,
	`api_key` text NOT NULL,
	`default_category` text,
	`max_nzb_bytes` integer DEFAULT 20971520 NOT NULL,
	`last_test_status` text,
	`last_tested_at` integer,
	`config_revision` integer DEFAULT 1 NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "sabnzbd_singleton" CHECK("sabnzbd_settings"."id" = 1),
	CONSTRAINT "sabnzbd_nzb_size_range" CHECK("sabnzbd_settings"."max_nzb_bytes" between 1048576 and 104857600)
);
