-- ============================================================
-- SUCKETO INVENTORY MANAGER — DUMP DATABASE COMPLETO
-- ============================================================
-- Generato il:   2026-04-29
-- Server:        TiDB v8.5.3-serverless (compatibile MySQL 8.0)
-- Database orig: GPWQ8JmvMDUPgcYEuSTjiB
--
-- ISTRUZIONI PER LA MIGRAZIONE:
--   1. Sostituire "GPWQ8JmvMDUPgcYEuSTjiB" con il nome del
--      database di destinazione (cerca e sostituisci nel file).
--   2. MySQL/MariaDB:  mysql -u USER -p TARGET_DB < dump_manus_DATA.sql
--   3. TiDB:           mysql -h HOST -P 4000 -u USER -p < dump_manus_DATA.sql
--   4. Il dump include DROP TABLE IF EXISTS: i dati esistenti
--      verranno sovrascritti. Fare un backup prima di importare.
--
-- TABELLE INCLUSE (struttura + dati):
--   __drizzle_migrations  — Storico migrazioni Drizzle ORM
--   users                 — Utenti autenticati (Manus OAuth)
--   retailers             — Anagrafica rivenditori Sucketo (13 record)
--   products              — Catalogo prodotti centralizzato (8 record)
--   inventory             — Stato magazzino per rivenditore (2 record)
--   stockMovements        — Log movimenti magazzino (0 record)
--   alerts                — Alert scorte e scadenze (0 record)
--   syncLogs              — Log sincronizzazioni Fatture in Cloud (0 record)
--
-- VISTE/FUNZIONI/EVENTI: nessuno presente nel database corrente.
-- ============================================================
-- MySQL dump 10.13  Distrib 8.0.45, for Linux (x86_64)
--
-- Host: gateway04.us-east-1.prod.aws.tidbcloud.com    Database: GPWQ8JmvMDUPgcYEuSTjiB
-- ------------------------------------------------------
-- Server version	8.0.11-TiDB-v8.5.3-serverless

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!50503 SET NAMES utf8mb4 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;

--
-- Current Database: `GPWQ8JmvMDUPgcYEuSTjiB`
--

/*!40000 DROP DATABASE IF EXISTS `GPWQ8JmvMDUPgcYEuSTjiB`*/;

CREATE DATABASE IF NOT EXISTS `GPWQ8JmvMDUPgcYEuSTjiB` /*!40100 DEFAULT CHARACTER SET utf8mb4 */;

USE `GPWQ8JmvMDUPgcYEuSTjiB`;

--
-- Table structure for table `__drizzle_migrations`
--

DROP TABLE IF EXISTS `__drizzle_migrations`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `__drizzle_migrations` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `hash` text NOT NULL,
  `created_at` bigint DEFAULT NULL,
  PRIMARY KEY (`id`) /*T![clustered_index] CLUSTERED */,
  UNIQUE KEY `id` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin AUTO_INCREMENT=2030001;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `__drizzle_migrations`
--

LOCK TABLES `__drizzle_migrations` WRITE;
/*!40000 ALTER TABLE `__drizzle_migrations` DISABLE KEYS */;
INSERT INTO `__drizzle_migrations` VALUES (1,'814a08e40d7fc2bcfd458759d18319198ca8ae394f2fa15617a78678e9c9c93b',1771328799216),(2,'0666694658304710f932e4935e39ccc7397a039adfa2b79c79d7757be76a7d16',1771328965215),(2000001,'0d0b99de2c1bf3dc1d24fb19793dba3943d885be4192993316873d3c047092dc',1771359963245);
/*!40000 ALTER TABLE `__drizzle_migrations` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `alerts`
--

DROP TABLE IF EXISTS `alerts`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `alerts` (
  `id` int NOT NULL AUTO_INCREMENT,
  `retailerId` int NOT NULL,
  `productId` int NOT NULL,
  `type` enum('LOW_STOCK','EXPIRING','EXPIRED') NOT NULL,
  `status` enum('ACTIVE','ACKNOWLEDGED','RESOLVED') NOT NULL DEFAULT 'ACTIVE',
  `message` text DEFAULT NULL,
  `currentQuantity` int DEFAULT NULL,
  `thresholdQuantity` int DEFAULT NULL,
  `expirationDate` timestamp NULL DEFAULT NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `acknowledgedAt` timestamp NULL DEFAULT NULL,
  `acknowledgedBy` int DEFAULT NULL,
  `resolvedAt` timestamp NULL DEFAULT NULL,
  PRIMARY KEY (`id`) /*T![clustered_index] CLUSTERED */
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `alerts`
--

LOCK TABLES `alerts` WRITE;
/*!40000 ALTER TABLE `alerts` DISABLE KEYS */;
/*!40000 ALTER TABLE `alerts` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `inventory`
--

DROP TABLE IF EXISTS `inventory`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `inventory` (
  `id` int NOT NULL AUTO_INCREMENT,
  `retailerId` int NOT NULL,
  `productId` int NOT NULL,
  `quantity` int NOT NULL DEFAULT '0',
  `expirationDate` timestamp NULL DEFAULT NULL,
  `batchNumber` varchar(100) DEFAULT NULL,
  `lastUpdated` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`) /*T![clustered_index] CLUSTERED */
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin AUTO_INCREMENT=30001;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `inventory`
--

LOCK TABLES `inventory` WRITE;
/*!40000 ALTER TABLE `inventory` DISABLE KEYS */;
INSERT INTO `inventory` VALUES (1,30008,30005,3,NULL,NULL,'2026-02-17 20:05:05','2026-02-17 20:05:05'),(2,30011,30007,3,NULL,NULL,'2026-02-17 20:32:45','2026-02-17 20:32:45');
/*!40000 ALTER TABLE `inventory` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `products`
--

DROP TABLE IF EXISTS `products`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `products` (
  `id` int NOT NULL AUTO_INCREMENT,
  `sku` varchar(100) NOT NULL,
  `name` varchar(255) NOT NULL,
  `description` text DEFAULT NULL,
  `category` varchar(100) DEFAULT NULL,
  `isLowCarb` int NOT NULL DEFAULT '1',
  `isGlutenFree` int NOT NULL DEFAULT '1',
  `isKeto` int NOT NULL DEFAULT '1',
  `sugarContent` varchar(50) DEFAULT '0%',
  `supplierId` int DEFAULT NULL,
  `supplierName` varchar(255) DEFAULT NULL,
  `unitPrice` varchar(20) DEFAULT NULL,
  `unit` varchar(50) DEFAULT NULL,
  `minStockThreshold` int DEFAULT '10',
  `expiryWarningDays` int DEFAULT '30',
  `imageUrl` text DEFAULT NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`) /*T![clustered_index] CLUSTERED */,
  UNIQUE KEY `products_sku_unique` (`sku`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin AUTO_INCREMENT=60001;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `products`
--

LOCK TABLES `products` WRITE;
/*!40000 ALTER TABLE `products` DISABLE KEYS */;
INSERT INTO `products` VALUES (1,'TEST-001','Pane Keto Test',NULL,'Pane',1,1,1,'0%',NULL,NULL,'5.99','pz',10,30,NULL,'2026-02-17 11:57:26','2026-02-17 11:57:26'),(30001,'TEST-STATS-001','Prodotto Test Stats',NULL,NULL,1,1,1,'0%',NULL,NULL,'10.00','pz',5,30,NULL,'2026-02-17 20:03:42','2026-02-17 20:03:42'),(30003,'TEST-STATS-1771358668855','Prodotto Test Stats',NULL,NULL,1,1,1,'0%',NULL,NULL,'10.00','pz',5,30,NULL,'2026-02-17 20:04:28','2026-02-17 20:04:28'),(30004,'TEST-1771358668912','Pane Keto Test',NULL,'Pane',1,1,1,'0%',NULL,NULL,'5.99','pz',10,30,NULL,'2026-02-17 20:04:28','2026-02-17 20:04:28'),(30005,'TEST-STATS-1771358705397','Prodotto Test Stats',NULL,NULL,1,1,1,'0%',NULL,NULL,'10.00','pz',5,30,NULL,'2026-02-17 20:05:05','2026-02-17 20:05:05'),(30006,'TEST-1771358705434','Pane Keto Test',NULL,'Pane',1,1,1,'0%',NULL,NULL,'5.99','pz',10,30,NULL,'2026-02-17 20:05:05','2026-02-17 20:05:05'),(30007,'TEST-STATS-1771360365559','Prodotto Test Stats',NULL,NULL,1,1,1,'0%',NULL,NULL,'10.00','pz',5,30,NULL,'2026-02-17 20:32:45','2026-02-17 20:32:45'),(30008,'TEST-1771360365598','Pane Keto Test',NULL,'Pane',1,1,1,'0%',NULL,NULL,'5.99','pz',10,30,NULL,'2026-02-17 20:32:45','2026-02-17 20:32:45');
/*!40000 ALTER TABLE `products` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `retailers`
--

DROP TABLE IF EXISTS `retailers`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `retailers` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(255) NOT NULL,
  `businessType` varchar(100) DEFAULT NULL,
  `address` text DEFAULT NULL,
  `city` varchar(100) DEFAULT NULL,
  `province` varchar(2) DEFAULT NULL,
  `postalCode` varchar(10) DEFAULT NULL,
  `phone` varchar(50) DEFAULT NULL,
  `email` varchar(320) DEFAULT NULL,
  `contactPerson` varchar(255) DEFAULT NULL,
  `fattureInCloudCompanyId` varchar(100) DEFAULT NULL,
  `lastSyncAt` timestamp NULL DEFAULT NULL,
  `syncEnabled` int NOT NULL DEFAULT '0',
  `notes` text DEFAULT NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `fattureInCloudAccessToken` text DEFAULT NULL,
  `fattureInCloudRefreshToken` text DEFAULT NULL,
  `fattureInCloudTokenExpiresAt` timestamp NULL DEFAULT NULL,
  PRIMARY KEY (`id`) /*T![clustered_index] CLUSTERED */
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin AUTO_INCREMENT=60001;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `retailers`
--

LOCK TABLES `retailers` WRITE;
/*!40000 ALTER TABLE `retailers` DISABLE KEYS */;
INSERT INTO `retailers` VALUES (1,'Test Farmacia','Farmacia',NULL,'Milano','MI',NULL,NULL,'test@farmacia.it',NULL,NULL,NULL,1,NULL,'2026-02-17 11:57:26','2026-02-17 11:57:26',NULL,NULL,NULL),(30001,'Test Farmacia Details','Farmacia',NULL,'Milano','MI',NULL,NULL,'details@test.it',NULL,NULL,NULL,1,NULL,'2026-02-17 20:03:42','2026-02-17 20:03:42',NULL,NULL,NULL),(30002,'Test Farmacia','Farmacia',NULL,'Milano','MI',NULL,NULL,'test@farmacia.it',NULL,NULL,NULL,1,NULL,'2026-02-17 20:03:42','2026-02-17 20:03:42',NULL,NULL,NULL),(30003,'Test Stats Retailer','Ristorante',NULL,'Roma',NULL,NULL,NULL,NULL,NULL,NULL,NULL,1,NULL,'2026-02-17 20:03:42','2026-02-17 20:03:42',NULL,NULL,NULL),(30004,'Test Farmacia Details','Farmacia',NULL,'Milano','MI',NULL,NULL,'details@test.it',NULL,NULL,NULL,1,NULL,'2026-02-17 20:04:28','2026-02-17 20:04:28',NULL,NULL,NULL),(30005,'Test Stats Retailer','Ristorante',NULL,'Roma',NULL,NULL,NULL,NULL,NULL,NULL,NULL,1,NULL,'2026-02-17 20:04:28','2026-02-17 20:04:28',NULL,NULL,NULL),(30006,'Test Farmacia','Farmacia',NULL,'Milano','MI',NULL,NULL,'test@farmacia.it',NULL,NULL,NULL,1,NULL,'2026-02-17 20:04:28','2026-02-17 20:04:28',NULL,NULL,NULL),(30007,'Test Farmacia Details','Farmacia',NULL,'Milano','MI',NULL,NULL,'details@test.it',NULL,NULL,NULL,1,NULL,'2026-02-17 20:05:05','2026-02-17 20:05:05',NULL,NULL,NULL),(30008,'Test Stats Retailer','Ristorante',NULL,'Roma',NULL,NULL,NULL,NULL,NULL,NULL,NULL,1,NULL,'2026-02-17 20:05:05','2026-02-17 20:05:05',NULL,NULL,NULL),(30009,'Test Farmacia','Farmacia',NULL,'Milano','MI',NULL,NULL,'test@farmacia.it',NULL,NULL,NULL,1,NULL,'2026-02-17 20:05:05','2026-02-17 20:05:05',NULL,NULL,NULL),(30010,'Test Farmacia Details','Farmacia',NULL,'Milano','MI',NULL,NULL,'details@test.it',NULL,NULL,NULL,0,NULL,'2026-02-17 20:32:45','2026-02-17 20:32:45',NULL,NULL,NULL),(30011,'Test Stats Retailer','Ristorante',NULL,'Roma',NULL,NULL,NULL,NULL,NULL,NULL,NULL,0,NULL,'2026-02-17 20:32:45','2026-02-17 20:32:45',NULL,NULL,NULL),(30012,'Test Farmacia','Farmacia',NULL,'Milano','MI',NULL,NULL,'test@farmacia.it',NULL,NULL,NULL,0,NULL,'2026-02-17 20:32:45','2026-02-17 20:32:45',NULL,NULL,NULL);
/*!40000 ALTER TABLE `retailers` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `stockMovements`
--

DROP TABLE IF EXISTS `stockMovements`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `stockMovements` (
  `id` int NOT NULL AUTO_INCREMENT,
  `inventoryId` int NOT NULL,
  `retailerId` int NOT NULL,
  `productId` int NOT NULL,
  `type` enum('IN','OUT','ADJUSTMENT') NOT NULL,
  `quantity` int NOT NULL,
  `previousQuantity` int DEFAULT NULL,
  `newQuantity` int DEFAULT NULL,
  `sourceDocument` varchar(255) DEFAULT NULL,
  `sourceDocumentType` varchar(50) DEFAULT NULL,
  `notes` text DEFAULT NULL,
  `timestamp` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `createdBy` int DEFAULT NULL,
  PRIMARY KEY (`id`) /*T![clustered_index] CLUSTERED */
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `stockMovements`
--

LOCK TABLES `stockMovements` WRITE;
/*!40000 ALTER TABLE `stockMovements` DISABLE KEYS */;
/*!40000 ALTER TABLE `stockMovements` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `syncLogs`
--

DROP TABLE IF EXISTS `syncLogs`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `syncLogs` (
  `id` int NOT NULL AUTO_INCREMENT,
  `retailerId` int NOT NULL,
  `syncType` varchar(50) NOT NULL,
  `status` enum('SUCCESS','FAILED','PARTIAL') NOT NULL,
  `recordsProcessed` int DEFAULT '0',
  `recordsFailed` int DEFAULT '0',
  `errorMessage` text DEFAULT NULL,
  `startedAt` timestamp NOT NULL,
  `completedAt` timestamp NULL DEFAULT NULL,
  `duration` int DEFAULT NULL,
  PRIMARY KEY (`id`) /*T![clustered_index] CLUSTERED */
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `syncLogs`
--

LOCK TABLES `syncLogs` WRITE;
/*!40000 ALTER TABLE `syncLogs` DISABLE KEYS */;
/*!40000 ALTER TABLE `syncLogs` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `users`
--

DROP TABLE IF EXISTS `users`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `users` (
  `id` int NOT NULL AUTO_INCREMENT,
  `openId` varchar(64) NOT NULL,
  `name` text DEFAULT NULL,
  `email` varchar(320) DEFAULT NULL,
  `loginMethod` varchar(64) DEFAULT NULL,
  `role` enum('user','admin') NOT NULL DEFAULT 'user',
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `lastSignedIn` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`) /*T![clustered_index] CLUSTERED */,
  UNIQUE KEY `users_openId_unique` (`openId`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin AUTO_INCREMENT=270001;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `users`
--

LOCK TABLES `users` WRITE;
/*!40000 ALTER TABLE `users` DISABLE KEYS */;
INSERT INTO `users` VALUES (1,'TQRdJVzH3rBU2jRyt9sDvx','PortaCow','portacow74@gmail.com','google','admin','2026-02-17 11:54:35','2026-04-29 14:26:16','2026-04-29 14:26:17');
/*!40000 ALTER TABLE `users` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Dumping events for database 'GPWQ8JmvMDUPgcYEuSTjiB'
--

--
-- Dumping routines for database 'GPWQ8JmvMDUPgcYEuSTjiB'
--
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;

-- Dump completed on 2026-04-29 10:30:27
