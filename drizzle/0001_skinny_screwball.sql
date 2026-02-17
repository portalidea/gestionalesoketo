CREATE TABLE `alerts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`retailerId` int NOT NULL,
	`productId` int NOT NULL,
	`type` enum('LOW_STOCK','EXPIRING','EXPIRED') NOT NULL,
	`status` enum('ACTIVE','ACKNOWLEDGED','RESOLVED') NOT NULL DEFAULT 'ACTIVE',
	`message` text,
	`currentQuantity` int,
	`thresholdQuantity` int,
	`expirationDate` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`acknowledgedAt` timestamp,
	`acknowledgedBy` int,
	`resolvedAt` timestamp,
	CONSTRAINT `alerts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `inventory` (
	`id` int AUTO_INCREMENT NOT NULL,
	`retailerId` int NOT NULL,
	`productId` int NOT NULL,
	`quantity` int NOT NULL DEFAULT 0,
	`expirationDate` timestamp,
	`batchNumber` varchar(100),
	`lastUpdated` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `inventory_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `products` (
	`id` int AUTO_INCREMENT NOT NULL,
	`sku` varchar(100) NOT NULL,
	`name` varchar(255) NOT NULL,
	`description` text,
	`category` varchar(100),
	`isLowCarb` int NOT NULL DEFAULT 1,
	`isGlutenFree` int NOT NULL DEFAULT 1,
	`isKeto` int NOT NULL DEFAULT 1,
	`sugarContent` varchar(50) DEFAULT '0%',
	`supplierId` int,
	`supplierName` varchar(255),
	`unitPrice` varchar(20),
	`unit` varchar(50),
	`minStockThreshold` int DEFAULT 10,
	`expiryWarningDays` int DEFAULT 30,
	`imageUrl` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `products_id` PRIMARY KEY(`id`),
	CONSTRAINT `products_sku_unique` UNIQUE(`sku`)
);
--> statement-breakpoint
CREATE TABLE `retailers` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` varchar(255) NOT NULL,
	`businessType` varchar(100),
	`address` text,
	`city` varchar(100),
	`province` varchar(2),
	`postalCode` varchar(10),
	`phone` varchar(50),
	`email` varchar(320),
	`contactPerson` varchar(255),
	`fattureInCloudCompanyId` varchar(100),
	`fattureInCloudApiKey` text,
	`lastSyncAt` timestamp,
	`syncEnabled` int NOT NULL DEFAULT 1,
	`notes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `retailers_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `stockMovements` (
	`id` int AUTO_INCREMENT NOT NULL,
	`inventoryId` int NOT NULL,
	`retailerId` int NOT NULL,
	`productId` int NOT NULL,
	`type` enum('IN','OUT','ADJUSTMENT') NOT NULL,
	`quantity` int NOT NULL,
	`previousQuantity` int,
	`newQuantity` int,
	`sourceDocument` varchar(255),
	`sourceDocumentType` varchar(50),
	`notes` text,
	`timestamp` timestamp NOT NULL DEFAULT (now()),
	`createdBy` int,
	CONSTRAINT `stockMovements_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `syncLogs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`retailerId` int NOT NULL,
	`syncType` varchar(50) NOT NULL,
	`status` enum('SUCCESS','FAILED','PARTIAL') NOT NULL,
	`recordsProcessed` int DEFAULT 0,
	`recordsFailed` int DEFAULT 0,
	`errorMessage` text,
	`startedAt` timestamp NOT NULL,
	`completedAt` timestamp,
	`duration` int,
	CONSTRAINT `syncLogs_id` PRIMARY KEY(`id`)
);
