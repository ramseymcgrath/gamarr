CREATE TABLE `qbittorrent_settings` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`base_url` text NOT NULL,
	`username` text NOT NULL,
	`password` text NOT NULL,
	`default_category` text,
	`last_test_status` text,
	`last_tested_at` integer,
	`config_revision` integer DEFAULT 1 NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "qbittorrent_singleton" CHECK("qbittorrent_settings"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE `download_attempts` ADD `torrent_hash` text;