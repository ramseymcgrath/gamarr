CREATE TABLE `download_verifications` (
	`attempt_id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`file_name` text,
	`sha1` text,
	`serial` text,
	`redump_name` text,
	`detail` text,
	`requested_at` integer NOT NULL,
	`checked_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`attempt_id`) REFERENCES `download_attempts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "download_verifications_status_valid" CHECK("download_verifications"."status" in ('Pending', 'Running', 'Verified', 'Mismatch', 'Unknown', 'Unsupported', 'Failed'))
);
--> statement-breakpoint
CREATE INDEX `download_verifications_status_idx` ON `download_verifications` (`status`);