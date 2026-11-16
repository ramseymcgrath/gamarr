PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_download_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`library_entry_id` text NOT NULL,
	`submission_key` text NOT NULL,
	`request_fingerprint` text NOT NULL,
	`status` text NOT NULL,
	`source` text DEFAULT 'newznab' NOT NULL,
	`release_title` text NOT NULL,
	`indexer_id` text,
	`indexer_name_snapshot` text NOT NULL,
	`indexer_url_snapshot` text,
	`newznab_guid` text,
	`ia_file_name` text,
	`torrent_hash` text,
	`selected_files` text,
	`files_applied_at` integer,
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
	CONSTRAINT "download_attempts_status_valid" CHECK("__new_download_attempts"."status" in ('Pending', 'Submitting', 'Queued', 'Downloading', 'Completed', 'Failed', 'Unknown')),
	CONSTRAINT "download_attempts_progress_range" CHECK("__new_download_attempts"."progress" between 0 and 100),
	CONSTRAINT "download_attempts_size_nonnegative" CHECK("__new_download_attempts"."size" is null or "__new_download_attempts"."size" >= 0),
	CONSTRAINT "download_attempts_source_valid" CHECK("__new_download_attempts"."source" in ('prowlarr-usenet', 'prowlarr-torrent', 'newznab', 'internet-archive', 'internet-archive-torrent', 'collection-torrent'))
);
--> statement-breakpoint
INSERT INTO `__new_download_attempts`("id", "library_entry_id", "submission_key", "request_fingerprint", "status", "source", "release_title", "indexer_id", "indexer_name_snapshot", "indexer_url_snapshot", "newznab_guid", "ia_file_name", "torrent_hash", "selected_files", "files_applied_at", "size", "category", "sabnzbd_config_revision", "sab_marker", "sab_job_id", "progress", "failure_detail", "sab_request_started_at", "created_at", "updated_at", "completed_at") SELECT "id", "library_entry_id", "submission_key", "request_fingerprint", "status", "source", "release_title", "indexer_id", "indexer_name_snapshot", "indexer_url_snapshot", "newznab_guid", "ia_file_name", "torrent_hash", "selected_files", "files_applied_at", "size", "category", "sabnzbd_config_revision", "sab_marker", "sab_job_id", "progress", "failure_detail", "sab_request_started_at", "created_at", "updated_at", "completed_at" FROM `download_attempts`;--> statement-breakpoint
DROP TABLE `download_attempts`;--> statement-breakpoint
ALTER TABLE `__new_download_attempts` RENAME TO `download_attempts`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `download_attempts_submission_key_unique` ON `download_attempts` (`submission_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `download_attempts_marker_unique` ON `download_attempts` (`sab_marker`);--> statement-breakpoint
CREATE UNIQUE INDEX `download_attempts_sab_job_unique` ON `download_attempts` (`sabnzbd_config_revision`,`sab_job_id`) WHERE "download_attempts"."sab_job_id" is not null;--> statement-breakpoint
CREATE INDEX `download_attempts_library_idx` ON `download_attempts` (`library_entry_id`);