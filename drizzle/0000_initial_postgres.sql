CREATE TYPE "public"."alert_status" AS ENUM('ACTIVE', 'ACKNOWLEDGED', 'RESOLVED');--> statement-breakpoint
CREATE TYPE "public"."alert_type" AS ENUM('LOW_STOCK', 'EXPIRING', 'EXPIRED');--> statement-breakpoint
CREATE TYPE "public"."stock_movement_type" AS ENUM('IN', 'OUT', 'ADJUSTMENT');--> statement-breakpoint
CREATE TYPE "public"."sync_status" AS ENUM('SUCCESS', 'FAILED', 'PARTIAL');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('user', 'admin');--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"retailerId" uuid NOT NULL,
	"productId" uuid NOT NULL,
	"type" "alert_type" NOT NULL,
	"status" "alert_status" DEFAULT 'ACTIVE' NOT NULL,
	"message" text,
	"currentQuantity" integer,
	"thresholdQuantity" integer,
	"expirationDate" timestamp with time zone,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledgedAt" timestamp with time zone,
	"acknowledgedBy" uuid,
	"resolvedAt" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "inventory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"retailerId" uuid NOT NULL,
	"productId" uuid NOT NULL,
	"quantity" integer DEFAULT 0 NOT NULL,
	"expirationDate" timestamp with time zone,
	"batchNumber" varchar(100),
	"lastUpdated" timestamp with time zone DEFAULT now() NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sku" varchar(100) NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"category" varchar(100),
	"isLowCarb" integer DEFAULT 1 NOT NULL,
	"isGlutenFree" integer DEFAULT 1 NOT NULL,
	"isKeto" integer DEFAULT 1 NOT NULL,
	"sugarContent" varchar(50) DEFAULT '0%',
	"supplierId" integer,
	"supplierName" varchar(255),
	"unitPrice" varchar(20),
	"unit" varchar(50),
	"minStockThreshold" integer DEFAULT 10,
	"expiryWarningDays" integer DEFAULT 30,
	"imageUrl" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_sku_unique" UNIQUE("sku")
);
--> statement-breakpoint
CREATE TABLE "retailers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"businessType" varchar(100),
	"address" text,
	"city" varchar(100),
	"province" varchar(2),
	"postalCode" varchar(10),
	"phone" varchar(50),
	"email" varchar(320),
	"contactPerson" varchar(255),
	"fattureInCloudCompanyId" varchar(100),
	"fattureInCloudAccessToken" text,
	"fattureInCloudRefreshToken" text,
	"fattureInCloudTokenExpiresAt" timestamp with time zone,
	"lastSyncAt" timestamp with time zone,
	"syncEnabled" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stockMovements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"inventoryId" uuid NOT NULL,
	"retailerId" uuid NOT NULL,
	"productId" uuid NOT NULL,
	"type" "stock_movement_type" NOT NULL,
	"quantity" integer NOT NULL,
	"previousQuantity" integer,
	"newQuantity" integer,
	"sourceDocument" varchar(255),
	"sourceDocumentType" varchar(50),
	"notes" text,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL,
	"createdBy" uuid
);
--> statement-breakpoint
CREATE TABLE "syncLogs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"retailerId" uuid NOT NULL,
	"syncType" varchar(50) NOT NULL,
	"status" "sync_status" NOT NULL,
	"recordsProcessed" integer DEFAULT 0,
	"recordsFailed" integer DEFAULT 0,
	"errorMessage" text,
	"startedAt" timestamp with time zone NOT NULL,
	"completedAt" timestamp with time zone,
	"duration" integer
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"openId" varchar(64) NOT NULL,
	"name" text,
	"email" varchar(320),
	"loginMethod" varchar(64),
	"role" "user_role" DEFAULT 'user' NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"lastSignedIn" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_openId_unique" UNIQUE("openId")
);
