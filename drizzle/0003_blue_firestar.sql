PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_release_candidates` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`source` text DEFAULT 'newznab' NOT NULL,
	`indexer_id` text,
	`indexer_config_revision` integer NOT NULL,
	`guid` text NOT NULL,
	`title` text NOT NULL,
	`size` integer,
	`download_path` text NOT NULL,
	`category` text,
	`source_snapshot` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`indexer_id`) REFERENCES `indexers`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "release_candidates_source_valid" CHECK("__new_release_candidates"."source" in ('newznab', 'internet-archive'))
);
--> statement-breakpoint
INSERT INTO `__new_release_candidates`("id", "expires_at", "indexer_id", "indexer_config_revision", "guid", "title", "size", "download_path", "category", "source_snapshot", "created_at") SELECT "id", "expires_at", "indexer_id", "indexer_config_revision", "guid", "title", "size", "download_path", "category", "source_snapshot", "created_at" FROM `release_candidates`;--> statement-breakpoint
DROP TABLE `release_candidates`;--> statement-breakpoint
ALTER TABLE `__new_release_candidates` RENAME TO `release_candidates`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `release_candidates_expiry_idx` ON `release_candidates` (`expires_at`);--> statement-breakpoint
ALTER TABLE `download_attempts` ADD `source` text DEFAULT 'newznab' NOT NULL;--> statement-breakpoint
ALTER TABLE `download_attempts` ADD `ia_file_name` text;