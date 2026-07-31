PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_sabnzbd_settings` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`base_url` text NOT NULL,
	`api_key` text NOT NULL,
	`default_category` text,
	`max_nzb_bytes` integer DEFAULT 20971520 NOT NULL,
	`last_test_status` text,
	`last_tested_at` integer,
	`config_revision` integer DEFAULT 1 NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "sabnzbd_singleton" CHECK("__new_sabnzbd_settings"."id" = 1),
	CONSTRAINT "sabnzbd_nzb_size_range" CHECK("__new_sabnzbd_settings"."max_nzb_bytes" between 1048576 and 104857600)
);
--> statement-breakpoint
INSERT INTO `__new_sabnzbd_settings`("id", "base_url", "api_key", "default_category", "max_nzb_bytes", "last_test_status", "last_tested_at", "config_revision", "updated_at") SELECT "id", "base_url", "api_key", "default_category", "max_nzb_bytes", "last_test_status", "last_tested_at", "config_revision", "updated_at" FROM `sabnzbd_settings`;--> statement-breakpoint
DROP TABLE `sabnzbd_settings`;--> statement-breakpoint
ALTER TABLE `__new_sabnzbd_settings` RENAME TO `sabnzbd_settings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
ALTER TABLE `games` ADD `platform_ids` text DEFAULT '[]' NOT NULL;