ALTER TABLE `retailers` MODIFY COLUMN `syncEnabled` int NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE `retailers` ADD `fattureInCloudAccessToken` text;--> statement-breakpoint
ALTER TABLE `retailers` ADD `fattureInCloudRefreshToken` text;--> statement-breakpoint
ALTER TABLE `retailers` ADD `fattureInCloudTokenExpiresAt` timestamp;--> statement-breakpoint
ALTER TABLE `retailers` DROP COLUMN `fattureInCloudApiKey`;