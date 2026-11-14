ALTER TABLE `download_verifications` ADD `export_status` text;--> statement-breakpoint
ALTER TABLE `download_verifications` ADD `export_path` text;--> statement-breakpoint
ALTER TABLE `download_verifications` ADD `export_detail` text;--> statement-breakpoint
ALTER TABLE `download_verifications` ADD `exported_at` integer;--> statement-breakpoint
CREATE INDEX `download_verifications_export_status_idx` ON `download_verifications` (`export_status`);