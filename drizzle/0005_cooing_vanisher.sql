CREATE TABLE `platform_popular_games` (
	`platform_id` integer PRIMARY KEY NOT NULL,
	`game_ids` text DEFAULT '[]' NOT NULL,
	`fetched_at` integer NOT NULL,
	FOREIGN KEY (`platform_id`) REFERENCES `platforms`(`id`) ON UPDATE no action ON DELETE cascade
);
