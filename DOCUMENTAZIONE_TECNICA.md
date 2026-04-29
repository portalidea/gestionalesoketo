# Documentazione Tecnica — Sucketo Inventory Manager

**Versione:** 1.0.0  
**Data:** Aprile 2026  
**Progetto:** Piattaforma centralizzata per la gestione del magazzino della rete rivenditori Sucketo  
**URL di produzione:** `https://foodappdash-gpwq8jmv.manus.space`

---

## Indice

1. [Stack Tecnologico](#1-stack-tecnologico)
2. [Struttura Cartelle](#2-struttura-cartelle)
3. [Schema Database](#3-schema-database)
4. [Endpoint tRPC](#4-endpoint-trpc)
5. [Variabili d'Ambiente](#5-variabili-dambiente)
6. [Integrazioni Esterne](#6-integrazioni-esterne)
7. [Logica di Autenticazione](#7-logica-di-autenticazione)
8. [Route HTTP Express](#8-route-http-express)

---

## 1. Stack Tecnologico

| Livello | Tecnologia | Versione |
|---|---|---|
| Frontend | React | 19.x |
| Linguaggio | TypeScript | 5.9.x |
| Stile | Tailwind CSS | 4.x |
| Componenti UI | shadcn/ui + Radix UI | — |
| Routing frontend | Wouter | 3.x |
| Backend | Node.js + Express | 4.x |
| API layer | tRPC | 11.x |
| ORM | Drizzle ORM | 0.44.x |
| Database | MySQL / TiDB | — |
| Build tool | Vite | 7.x |
| Runtime server | tsx (watch) / esbuild (prod) | — |
| Test | Vitest | 2.x |
| Gestione pacchetti | pnpm | 10.x |

---

## 2. Struttura Cartelle

```
foodapps4all2026_dashboard/
│
├── client/                         # Frontend React
│   ├── index.html                  # Entry point HTML con import Google Fonts
│   ├── public/                     # Asset statici serviti verbatim
│   └── src/
│       ├── main.tsx                # Bootstrap React con provider tRPC e QueryClient
│       ├── App.tsx                 # Router principale (wouter) e ThemeProvider
│       ├── index.css               # Variabili CSS globali, tema scuro Sucketo
│       ├── const.ts                # Costanti frontend (getLoginUrl, redirect)
│       ├── _core/
│       │   └── hooks/useAuth.ts    # Hook autenticazione (stato utente, login/logout)
│       ├── components/
│       │   ├── DashboardLayout.tsx # Layout sidebar con navigazione principale
│       │   ├── FattureInCloudSync.tsx # Componente UI gestione sincronizzazione FIC
│       │   ├── ErrorBoundary.tsx   # Gestione errori React
│       │   └── ui/                 # Componenti shadcn/ui (button, card, table, ecc.)
│       ├── contexts/
│       │   └── ThemeContext.tsx    # Provider tema chiaro/scuro
│       ├── hooks/                  # Hook React custom (useMobile, useComposition)
│       ├── lib/
│       │   ├── trpc.ts             # Client tRPC tipizzato
│       │   └── utils.ts            # Utility (cn per classnames)
│       └── pages/
│           ├── Home.tsx            # Dashboard principale con KPI aggregati
│           ├── Retailers.tsx       # Lista e gestione rivenditori
│           ├── RetailerDetail.tsx  # Dettaglio rivenditore (inventario, movimenti, sync)
│           ├── Products.tsx        # Catalogo prodotti centralizzato
│           ├── Alerts.tsx          # Gestione alert attivi
│           ├── Reports.tsx         # Reportistica (placeholder)
│           └── NotFound.tsx        # Pagina 404
│
├── server/                         # Backend Node.js
│   ├── routers.ts                  # Definizione procedure tRPC (entry point API)
│   ├── db.ts                       # Query helpers Drizzle ORM
│   ├── storage.ts                  # Helper S3 per file storage
│   ├── fattureincloud-oauth.ts     # Modulo OAuth2 Fatture in Cloud
│   ├── fattureincloud-api.ts       # Client API Fatture in Cloud (prodotti, stock, documenti)
│   ├── fattureincloud-sync.ts      # Servizio sincronizzazione dati
│   ├── fattureincloud-routes.ts    # Route Express (OAuth callback, webhook)
│   ├── auth.logout.test.ts         # Test logout sessione
│   ├── routers.test.ts             # Test procedure tRPC principali
│   ├── retailer-details.test.ts    # Test endpoint dettaglio rivenditore
│   ├── fattureincloud-sync.test.ts # Test OAuth e mapping dati FIC
│   └── _core/                      # Infrastruttura framework (non modificare)
│       ├── index.ts                # Entry point server Express
│       ├── context.ts              # Creazione contesto tRPC (autenticazione)
│       ├── trpc.ts                 # Definizione publicProcedure e protectedProcedure
│       ├── oauth.ts                # Route callback Manus OAuth
│       ├── sdk.ts                  # SDK Manus (autenticazione, sessioni)
│       ├── env.ts                  # Centralizzazione variabili d'ambiente
│       ├── cookies.ts              # Opzioni cookie di sessione
│       ├── llm.ts                  # Helper LLM (Manus AI)
│       ├── imageGeneration.ts      # Helper generazione immagini
│       ├── notification.ts         # Helper notifiche owner
│       ├── map.ts                  # Helper Google Maps proxy
│       ├── systemRouter.ts         # Router di sistema (notifiche owner)
│       └── vite.ts                 # Integrazione Vite dev server
│
├── drizzle/                        # Migrazioni e schema database
│   ├── schema.ts                   # Definizione tabelle (source of truth)
│   ├── relations.ts                # Relazioni Drizzle
│   ├── 0000_*.sql                  # Migrazione iniziale (users, retailers, products)
│   ├── 0001_*.sql                  # Migrazione inventario, movimenti, alert, syncLogs
│   ├── 0002_*.sql                  # Migrazione campi OAuth Fatture in Cloud
│   └── meta/                       # Snapshot Drizzle per generazione migrazioni
│
├── shared/                         # Costanti condivise frontend/backend
│   └── const.ts                    # COOKIE_NAME, ONE_YEAR_MS
│
├── todo.md                         # Tracciamento funzionalità e bug
├── DOCUMENTAZIONE_TECNICA.md       # Questo file
├── package.json                    # Dipendenze e script npm
├── drizzle.config.ts               # Configurazione Drizzle Kit
├── vite.config.ts                  # Configurazione Vite
└── tsconfig.json                   # Configurazione TypeScript
```

---

## 3. Schema Database

Il database è MySQL/TiDB gestito dalla piattaforma Manus. Tutte le tabelle usano `int autoincrement` come chiave primaria. I timestamp sono in UTC. Le foreign key sono implicite (Drizzle ORM non le genera esplicitamente su MySQL, ma i vincoli sono applicati a livello applicativo).

### 3.1 Tabella `users`

Tabella core per il sistema di autenticazione Manus OAuth.

| Colonna | Tipo | Vincoli | Descrizione |
|---|---|---|---|
| `id` | `INT` | PK, AUTO_INCREMENT | Identificatore interno |
| `openId` | `VARCHAR(64)` | NOT NULL, UNIQUE | Identificatore Manus OAuth (immutabile) |
| `name` | `TEXT` | nullable | Nome visualizzato |
| `email` | `VARCHAR(320)` | nullable | Email utente |
| `loginMethod` | `VARCHAR(64)` | nullable | Metodo di login (es. `google`, `email`) |
| `role` | `ENUM('user','admin')` | NOT NULL, DEFAULT `user` | Ruolo per controllo accessi |
| `createdAt` | `TIMESTAMP` | NOT NULL, DEFAULT NOW() | Data creazione |
| `updatedAt` | `TIMESTAMP` | NOT NULL, ON UPDATE NOW() | Ultima modifica |
| `lastSignedIn` | `TIMESTAMP` | NOT NULL, DEFAULT NOW() | Ultimo accesso |

### 3.2 Tabella `retailers`

Anagrafica dei punti vendita (ristoranti, farmacie, negozi) che distribuiscono i prodotti Sucketo.

| Colonna | Tipo | Vincoli | Descrizione |
|---|---|---|---|
| `id` | `INT` | PK, AUTO_INCREMENT | Identificatore interno |
| `name` | `VARCHAR(255)` | NOT NULL | Ragione sociale / nome punto vendita |
| `businessType` | `VARCHAR(100)` | nullable | Tipo attività (ristorante, farmacia, negozio, ecc.) |
| `address` | `TEXT` | nullable | Indirizzo completo |
| `city` | `VARCHAR(100)` | nullable | Città |
| `province` | `VARCHAR(2)` | nullable | Sigla provincia (es. `MI`, `RM`) |
| `postalCode` | `VARCHAR(10)` | nullable | CAP |
| `phone` | `VARCHAR(50)` | nullable | Telefono |
| `email` | `VARCHAR(320)` | nullable | Email di contatto |
| `contactPerson` | `VARCHAR(255)` | nullable | Nome referente |
| `fattureInCloudCompanyId` | `VARCHAR(100)` | nullable | ID azienda su Fatture in Cloud |
| `fattureInCloudAccessToken` | `TEXT` | nullable | Access token OAuth2 FIC (cifrato a livello DB) |
| `fattureInCloudRefreshToken` | `TEXT` | nullable | Refresh token OAuth2 FIC |
| `fattureInCloudTokenExpiresAt` | `TIMESTAMP` | nullable | Scadenza access token |
| `lastSyncAt` | `TIMESTAMP` | nullable | Timestamp ultima sincronizzazione riuscita |
| `syncEnabled` | `INT` | NOT NULL, DEFAULT `0` | Flag abilitazione sync (0=disabilitato, 1=abilitato) |
| `notes` | `TEXT` | nullable | Note interne |
| `createdAt` | `TIMESTAMP` | NOT NULL, DEFAULT NOW() | Data creazione |
| `updatedAt` | `TIMESTAMP` | NOT NULL, ON UPDATE NOW() | Ultima modifica |

### 3.3 Tabella `products`

Catalogo centralizzato dei prodotti Sucketo con caratteristiche nutrizionali specifiche.

| Colonna | Tipo | Vincoli | Descrizione |
|---|---|---|---|
| `id` | `INT` | PK, AUTO_INCREMENT | Identificatore interno |
| `sku` | `VARCHAR(100)` | NOT NULL, UNIQUE | Codice prodotto univoco |
| `name` | `VARCHAR(255)` | NOT NULL | Nome prodotto |
| `description` | `TEXT` | nullable | Descrizione estesa |
| `category` | `VARCHAR(100)` | nullable | Categoria (pane, pasta, dolci, ecc.) |
| `isLowCarb` | `INT` | NOT NULL, DEFAULT `1` | Flag low carb (0/1) |
| `isGlutenFree` | `INT` | NOT NULL, DEFAULT `1` | Flag senza glutine (0/1) |
| `isKeto` | `INT` | NOT NULL, DEFAULT `1` | Flag keto (0/1) |
| `sugarContent` | `VARCHAR(50)` | DEFAULT `'0%'` | Contenuto zuccheri (es. `0%`, `<0.5g`) |
| `supplierId` | `INT` | nullable | FK implicita verso fornitore |
| `supplierName` | `VARCHAR(255)` | nullable | Nome fornitore (denormalizzato) |
| `unitPrice` | `VARCHAR(20)` | nullable | Prezzo unitario (stringa per evitare arrotondamenti) |
| `unit` | `VARCHAR(50)` | nullable | Unità di misura (kg, pz, confezione, ecc.) |
| `minStockThreshold` | `INT` | DEFAULT `10` | Soglia minima scorte per alert |
| `expiryWarningDays` | `INT` | DEFAULT `30` | Giorni prima della scadenza per generare alert |
| `imageUrl` | `TEXT` | nullable | URL immagine prodotto |
| `createdAt` | `TIMESTAMP` | NOT NULL, DEFAULT NOW() | Data creazione |
| `updatedAt` | `TIMESTAMP` | NOT NULL, ON UPDATE NOW() | Ultima modifica |

### 3.4 Tabella `inventory`

Stato del magazzino di ogni rivenditore per ogni prodotto. Una riga rappresenta una specifica combinazione rivenditore + prodotto (+ eventuale lotto/scadenza).

| Colonna | Tipo | Vincoli | Descrizione |
|---|---|---|---|
| `id` | `INT` | PK, AUTO_INCREMENT | Identificatore interno |
| `retailerId` | `INT` | NOT NULL | FK → `retailers.id` |
| `productId` | `INT` | NOT NULL | FK → `products.id` |
| `quantity` | `INT` | NOT NULL, DEFAULT `0` | Quantità disponibile |
| `expirationDate` | `TIMESTAMP` | nullable | Data di scadenza del lotto |
| `batchNumber` | `VARCHAR(100)` | nullable | Numero lotto |
| `lastUpdated` | `TIMESTAMP` | NOT NULL, ON UPDATE NOW() | Ultima modifica quantità |
| `createdAt` | `TIMESTAMP` | NOT NULL, DEFAULT NOW() | Data creazione riga |

### 3.5 Tabella `stockMovements`

Log immutabile di tutti i movimenti di magazzino (entrate, uscite, rettifiche). Ogni modifica all'inventario deve generare una riga in questa tabella.

| Colonna | Tipo | Vincoli | Descrizione |
|---|---|---|---|
| `id` | `INT` | PK, AUTO_INCREMENT | Identificatore interno |
| `inventoryId` | `INT` | NOT NULL | FK → `inventory.id` |
| `retailerId` | `INT` | NOT NULL | FK → `retailers.id` (denormalizzato per query) |
| `productId` | `INT` | NOT NULL | FK → `products.id` (denormalizzato per query) |
| `type` | `ENUM('IN','OUT','ADJUSTMENT')` | NOT NULL | Tipo movimento |
| `quantity` | `INT` | NOT NULL | Quantità movimentata (sempre positiva) |
| `previousQuantity` | `INT` | nullable | Quantità prima del movimento |
| `newQuantity` | `INT` | nullable | Quantità dopo il movimento |
| `sourceDocument` | `VARCHAR(255)` | nullable | Numero documento sorgente (es. `FAT-2024-001`) |
| `sourceDocumentType` | `VARCHAR(50)` | nullable | Tipo documento (`invoice`, `delivery_note`, `manual`) |
| `notes` | `TEXT` | nullable | Note libere |
| `timestamp` | `TIMESTAMP` | NOT NULL, DEFAULT NOW() | Timestamp movimento |
| `createdBy` | `INT` | nullable | FK → `users.id` (utente che ha creato il movimento) |

### 3.6 Tabella `alerts`

Alert generati automaticamente o manualmente per scorte basse, prodotti in scadenza o già scaduti.

| Colonna | Tipo | Vincoli | Descrizione |
|---|---|---|---|
| `id` | `INT` | PK, AUTO_INCREMENT | Identificatore interno |
| `retailerId` | `INT` | NOT NULL | FK → `retailers.id` |
| `productId` | `INT` | NOT NULL | FK → `products.id` |
| `type` | `ENUM('LOW_STOCK','EXPIRING','EXPIRED')` | NOT NULL | Tipo alert |
| `status` | `ENUM('ACTIVE','ACKNOWLEDGED','RESOLVED')` | NOT NULL, DEFAULT `ACTIVE` | Stato gestione alert |
| `message` | `TEXT` | nullable | Messaggio descrittivo |
| `currentQuantity` | `INT` | nullable | Quantità attuale al momento della creazione |
| `thresholdQuantity` | `INT` | nullable | Soglia che ha scatenato l'alert |
| `expirationDate` | `TIMESTAMP` | nullable | Data scadenza (per alert EXPIRING/EXPIRED) |
| `createdAt` | `TIMESTAMP` | NOT NULL, DEFAULT NOW() | Data creazione alert |
| `acknowledgedAt` | `TIMESTAMP` | nullable | Data presa in carico |
| `acknowledgedBy` | `INT` | nullable | FK → `users.id` |
| `resolvedAt` | `TIMESTAMP` | nullable | Data risoluzione |

### 3.7 Tabella `syncLogs`

Log delle sincronizzazioni con Fatture in Cloud per ogni rivenditore.

| Colonna | Tipo | Vincoli | Descrizione |
|---|---|---|---|
| `id` | `INT` | PK, AUTO_INCREMENT | Identificatore interno |
| `retailerId` | `INT` | NOT NULL | FK → `retailers.id` |
| `syncType` | `VARCHAR(50)` | NOT NULL | Tipo sync (`products`, `stock`, `full`) |
| `status` | `ENUM('SUCCESS','FAILED','PARTIAL')` | NOT NULL | Esito sincronizzazione |
| `recordsProcessed` | `INT` | DEFAULT `0` | Numero record elaborati con successo |
| `recordsFailed` | `INT` | DEFAULT `0` | Numero record con errori |
| `errorMessage` | `TEXT` | nullable | Messaggio di errore (se FAILED/PARTIAL) |
| `startedAt` | `TIMESTAMP` | NOT NULL | Inizio sincronizzazione |
| `completedAt` | `TIMESTAMP` | nullable | Fine sincronizzazione |
| `duration` | `INT` | nullable | Durata in secondi |

---

## 4. Endpoint tRPC

Tutte le procedure sono accessibili via `POST /api/trpc/<router>.<procedure>`. Le procedure `protectedProcedure` richiedono un cookie di sessione valido (`app_session_id`). Le procedure `publicProcedure` sono accessibili senza autenticazione.

Il client tRPC è configurato in `client/src/lib/trpc.ts` e utilizza `superjson` come transformer per la serializzazione di `Date` e altri tipi complessi.

### 4.1 Router `auth`

| Procedura | Tipo | Auth | Input | Output | Descrizione |
|---|---|---|---|---|---|
| `auth.me` | query | public | — | `User \| null` | Restituisce l'utente corrente dalla sessione |
| `auth.logout` | mutation | public | — | `{ success: true }` | Cancella il cookie di sessione |

### 4.2 Router `retailers`

| Procedura | Tipo | Auth | Input | Output | Descrizione |
|---|---|---|---|---|---|
| `retailers.list` | query | protected | — | `Retailer[]` | Lista completa rivenditori |
| `retailers.getById` | query | protected | `{ id: number }` | `Retailer \| undefined` | Singolo rivenditore per ID |
| `retailers.getDetails` | query | protected | `{ id: number }` | `RetailerDetailsResponse \| null` | Dettaglio completo con inventario arricchito, movimenti recenti (max 50), alert e statistiche calcolate |
| `retailers.create` | mutation | protected | `RetailerInput` | `Retailer` | Crea nuovo rivenditore |
| `retailers.update` | mutation | protected | `{ id: number } & Partial<RetailerInput>` | `{ success: true }` | Aggiorna dati rivenditore |
| `retailers.delete` | mutation | protected | `{ id: number }` | `{ success: true }` | Elimina rivenditore |

**Schema `RetailerInput`:**

```typescript
{
  name: string,                        // obbligatorio
  businessType?: string,
  address?: string,
  city?: string,
  province?: string,                   // max 2 caratteri
  postalCode?: string,
  phone?: string,
  email?: string,                      // validazione email
  contactPerson?: string,
  fattureInCloudCompanyId?: string,
  notes?: string,
}
```

**Schema `RetailerDetailsResponse`:**

```typescript
{
  retailer: Retailer,
  inventory: (Inventory & { product: Product | undefined })[],
  recentMovements: (StockMovement & { product: Product | undefined })[],
  alerts: Alert[],
  stats: {
    totalValue: string,        // valore inventario in €
    totalItems: number,        // numero righe inventario
    lowStockCount: number,     // prodotti sotto soglia minima
    expiringCount: number,     // prodotti in scadenza entro 30 giorni
    activeAlertsCount: number, // alert con status ACTIVE
  }
}
```

### 4.3 Router `products`

| Procedura | Tipo | Auth | Input | Output | Descrizione |
|---|---|---|---|---|---|
| `products.list` | query | protected | — | `Product[]` | Catalogo completo prodotti |
| `products.getById` | query | protected | `{ id: number }` | `Product \| undefined` | Prodotto per ID |
| `products.getBySku` | query | protected | `{ sku: string }` | `Product \| undefined` | Prodotto per SKU |
| `products.create` | mutation | protected | `ProductInput` | `Product` | Crea nuovo prodotto |
| `products.update` | mutation | protected | `{ id: number } & Partial<ProductInput>` | `{ success: true }` | Aggiorna prodotto |
| `products.delete` | mutation | protected | `{ id: number }` | `{ success: true }` | Elimina prodotto |

**Schema `ProductInput`:**

```typescript
{
  sku: string,                   // obbligatorio, univoco
  name: string,                  // obbligatorio
  description?: string,
  category?: string,
  isLowCarb?: number,            // 0 o 1
  isGlutenFree?: number,         // 0 o 1
  isKeto?: number,               // 0 o 1
  sugarContent?: string,         // es. "0%"
  supplierId?: number,
  supplierName?: string,
  unitPrice?: string,            // es. "5.99"
  unit?: string,                 // es. "pz", "kg"
  minStockThreshold?: number,    // default 10
  expiryWarningDays?: number,    // default 30
  imageUrl?: string,
}
```

### 4.4 Router `inventory`

| Procedura | Tipo | Auth | Input | Output | Descrizione |
|---|---|---|---|---|---|
| `inventory.getByRetailer` | query | protected | `{ retailerId: number }` | `Inventory[]` | Inventario di un rivenditore |
| `inventory.upsert` | mutation | protected | `InventoryUpsertInput` | `Inventory` | Crea o aggiorna riga inventario (upsert per retailerId + productId) |

**Schema `InventoryUpsertInput`:**

```typescript
{
  retailerId: number,
  productId: number,
  quantity: number,
  expirationDate?: Date,
  batchNumber?: string,
}
```

### 4.5 Router `stockMovements`

| Procedura | Tipo | Auth | Input | Output | Descrizione |
|---|---|---|---|---|---|
| `stockMovements.create` | mutation | protected | `StockMovementInput` | `StockMovement` | Registra movimento magazzino |
| `stockMovements.getByRetailer` | query | protected | `{ retailerId: number, limit?: number }` | `StockMovement[]` | Movimenti per rivenditore (default tutti) |
| `stockMovements.getByProduct` | query | protected | `{ productId: number, limit?: number }` | `StockMovement[]` | Movimenti per prodotto |

**Schema `StockMovementInput`:**

```typescript
{
  inventoryId: number,
  retailerId: number,
  productId: number,
  type: "IN" | "OUT" | "ADJUSTMENT",
  quantity: number,
  previousQuantity?: number,
  newQuantity?: number,
  sourceDocument?: string,
  sourceDocumentType?: string,
  notes?: string,
}
```

### 4.6 Router `alerts`

| Procedura | Tipo | Auth | Input | Output | Descrizione |
|---|---|---|---|---|---|
| `alerts.getActive` | query | protected | — | `Alert[]` | Tutti gli alert con status `ACTIVE` |
| `alerts.getByRetailer` | query | protected | `{ retailerId: number }` | `Alert[]` | Alert per rivenditore |
| `alerts.create` | mutation | protected | `AlertInput` | `Alert` | Crea nuovo alert |
| `alerts.updateStatus` | mutation | protected | `{ id: number, status: AlertStatus }` | `{ success: true }` | Aggiorna stato alert (ACKNOWLEDGED / RESOLVED) |

**Schema `AlertInput`:**

```typescript
{
  retailerId: number,
  productId: number,
  type: "LOW_STOCK" | "EXPIRING" | "EXPIRED",
  message?: string,
  currentQuantity?: number,
  thresholdQuantity?: number,
  expirationDate?: Date,
}
```

### 4.7 Router `dashboard`

| Procedura | Tipo | Auth | Input | Output | Descrizione |
|---|---|---|---|---|---|
| `dashboard.getStats` | query | protected | — | `DashboardStats` | KPI aggregati per la dashboard principale |

**Schema `DashboardStats`:**

```typescript
{
  totalRetailers: number,
  totalProducts: number,
  activeAlerts: number,
  totalInventoryValue: string,   // valore totale in € (stringa)
  lowStockItems: number,         // totale articoli sotto soglia su tutti i rivenditori
  expiringItems: number,         // totale articoli in scadenza entro 30 giorni
}
```

### 4.8 Router `sync`

| Procedura | Tipo | Auth | Input | Output | Descrizione |
|---|---|---|---|---|---|
| `sync.syncRetailer` | mutation | protected | `{ retailerId: number }` | `SyncResult` | Avvia sincronizzazione manuale completa con Fatture in Cloud |
| `sync.getAuthUrl` | query | protected | `{ retailerId: number }` | `{ url: string }` | Genera URL per flusso OAuth2 FIC. Lancia errore se le credenziali non sono configurate |
| `sync.disconnect` | mutation | protected | `{ retailerId: number }` | `{ success: true }` | Revoca accesso FIC (cancella token e disabilita sync) |
| `sync.getLogs` | query | protected | `{ retailerId: number, limit?: number }` | `SyncLog[]` | Log sincronizzazioni (default ultimi 20) |

**Schema `SyncResult`:**

```typescript
{
  success: boolean,
  productsSync: number,    // prodotti sincronizzati
  inventorySync: number,   // righe inventario aggiornate
  movementsSync: number,   // movimenti registrati
  errors: string[],        // lista errori non fatali
}
```

### 4.9 Router `system`

Router di sistema Manus (non modificare). Espone `system.notifyOwner` per inviare notifiche push al proprietario del progetto.

---

## 5. Variabili d'Ambiente

### 5.1 Variabili iniettate automaticamente dalla piattaforma Manus

Queste variabili sono gestite dalla piattaforma e non richiedono configurazione manuale.

| Variabile | Descrizione |
|---|---|
| `DATABASE_URL` | Stringa di connessione MySQL/TiDB |
| `JWT_SECRET` | Segreto per firma cookie di sessione |
| `VITE_APP_ID` | ID applicazione Manus OAuth |
| `OAUTH_SERVER_URL` | URL backend Manus OAuth (server-side) |
| `VITE_OAUTH_PORTAL_URL` | URL portale login Manus (frontend) |
| `OWNER_OPEN_ID` | OpenID del proprietario del progetto |
| `OWNER_NAME` | Nome del proprietario |
| `BUILT_IN_FORGE_API_URL` | URL API built-in Manus (LLM, storage, notifiche) |
| `BUILT_IN_FORGE_API_KEY` | Bearer token per API Manus (server-side) |
| `VITE_FRONTEND_FORGE_API_KEY` | Bearer token per API Manus (frontend) |
| `VITE_FRONTEND_FORGE_API_URL` | URL API Manus per frontend |
| `VITE_ANALYTICS_ENDPOINT` | Endpoint analytics |
| `VITE_ANALYTICS_WEBSITE_ID` | ID sito per analytics |
| `VITE_APP_LOGO` | URL logo applicazione |
| `VITE_APP_TITLE` | Titolo applicazione |

### 5.2 Variabili da configurare manualmente

Queste variabili devono essere inserite tramite Management UI → Settings → Secrets.

| Variabile | Obbligatoria | Descrizione | Come ottenerla |
|---|---|---|---|
| `FATTUREINCLOUD_CLIENT_ID` | Sì (per sync FIC) | Client ID applicazione OAuth Fatture in Cloud | Portale sviluppatori FIC → Applicazioni → Crea nuova app |
| `FATTUREINCLOUD_CLIENT_SECRET` | Sì (per sync FIC) | Client Secret applicazione OAuth Fatture in Cloud | Stesso portale |
| `FATTUREINCLOUD_REDIRECT_URI` | Sì (per sync FIC) | URI di redirect OAuth. Deve essere `https://foodappdash-gpwq8jmv.manus.space/api/fattureincloud/callback` | Configurare nel portale FIC |

---

## 6. Integrazioni Esterne

### 6.1 Manus OAuth (autenticazione utenti)

Manus OAuth è il sistema di autenticazione principale per gli utenti della piattaforma (amministratori Sucketo). Non è usato per i rivenditori.

**Flusso:** Authorization Code Flow standard OAuth2. Il frontend reindirizza l'utente al portale Manus, che dopo il login restituisce un `code` all'endpoint `/api/oauth/callback`. Il server scambia il code con un access token, recupera le informazioni utente e crea una sessione locale firmata con JWT.

**Endpoint:** `GET /api/oauth/callback` (gestito da `server/_core/oauth.ts`)

### 6.2 Fatture in Cloud API v2

Integrazione per sincronizzare prodotti, inventario e movimenti stock dai gestionali dei rivenditori.

**API Base URL:** `https://api-v2.fattureincloud.it`  
**Autenticazione:** OAuth2 Authorization Code Flow per-rivenditore  
**Documentazione ufficiale:** https://developers.fattureincloud.it/

**Endpoint utilizzati:**

| Endpoint FIC | Metodo | Utilizzo |
|---|---|---|
| `/oauth/authorize` | GET (redirect) | Avvio flusso OAuth rivenditore |
| `/oauth/token` | POST | Scambio code/token e refresh |
| `/c/{companyId}/products` | GET | Lista prodotti del rivenditore |
| `/c/{companyId}/issued_documents` | GET | Fatture emesse (per movimenti OUT) |
| `/c/{companyId}/received_documents` | GET | Documenti ricevuti (per movimenti IN) |

**Webhook ricevuti:** `POST /api/fattureincloud/webhook`

Fatture in Cloud invia notifiche HTTP per eventi su documenti e prodotti. I tipi di evento gestiti sono: `issued_document.created`, `issued_document.updated`, `issued_document.deleted`, `product.created`, `product.updated`, `product.deleted`. Alla ricezione di un evento, viene avviata automaticamente una sincronizzazione completa per il rivenditore corrispondente (identificato tramite `company_id`).

### 6.3 Manus Built-in APIs

La piattaforma Manus espone API built-in per LLM, generazione immagini, storage S3 e notifiche. Attualmente non utilizzate in produzione, ma i moduli helper sono disponibili in `server/_core/`.

---

## 7. Logica di Autenticazione

### 7.1 Login con Manus Auth

Il sistema di autenticazione è basato su **Manus OAuth 2.0** con sessione lato server firmata tramite JWT.

**Flusso completo:**

```
1. Utente clicca "Accedi"
   └─► Frontend chiama getLoginUrl() [client/src/const.ts]
       └─► Costruisce URL: {VITE_OAUTH_PORTAL_URL}/login?
               app_id={VITE_APP_ID}
               &redirect_uri={window.location.origin}/api/oauth/callback
               &state={base64(origin + returnPath)}

2. Utente si autentica sul portale Manus

3. Portale Manus reindirizza a /api/oauth/callback?code=XXX&state=YYY

4. Server [server/_core/oauth.ts]:
   a. Estrae code e state dalla query string
   b. Chiama sdk.exchangeCodeForToken(code, state)
      └─► POST a OAUTH_SERVER_URL per ottenere access token Manus
   c. Chiama sdk.getUserInfo(accessToken)
      └─► Recupera openId, name, email, loginMethod
   d. Chiama db.upsertUser() per creare/aggiornare utente nel DB
      └─► Se openId == OWNER_OPEN_ID → role = 'admin'
   e. Chiama sdk.createSessionToken(openId, { expiresInMs: ONE_YEAR_MS })
      └─► Genera JWT firmato con JWT_SECRET
   f. Imposta cookie HttpOnly: app_session_id = sessionToken
      (secure: true, sameSite: 'none', path: '/', maxAge: 1 anno)
   g. Redirect 302 a /
```

### 7.2 Verifica sessione per ogni richiesta tRPC

Ad ogni chiamata tRPC, il middleware `createContext` [server/_core/context.ts] esegue:

```
1. Legge cookie app_session_id dalla request
2. Chiama sdk.authenticateRequest(req)
   └─► Verifica firma JWT con JWT_SECRET
   └─► Estrae openId dal payload
   └─► Carica utente da DB tramite openId
3. Popola ctx.user con l'oggetto User (o null se non autenticato)
4. Le protectedProcedure verificano ctx.user !== null
   └─► Se null → TRPCError { code: 'UNAUTHORIZED' }
```

### 7.3 Controllo ruoli

Il campo `role` nella tabella `users` supporta due valori: `user` e `admin`. Il proprietario del progetto (identificato da `OWNER_OPEN_ID`) viene automaticamente promosso ad `admin` al primo accesso.

Per proteggere procedure solo per admin, il pattern raccomandato è:

```typescript
const adminProcedure = protectedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== 'admin') {
    throw new TRPCError({ code: 'FORBIDDEN' });
  }
  return next({ ctx });
});
```

Attualmente tutte le procedure applicative usano `protectedProcedure` senza distinzione di ruolo (qualsiasi utente autenticato può accedere). La distinzione admin/user è predisposta ma non ancora applicata.

### 7.4 Logout

La procedura `auth.logout` cancella il cookie `app_session_id` impostando `maxAge: -1`. Non è necessaria una chiamata al server Manus perché la sessione è stateless (JWT verificato localmente).

### 7.5 Autenticazione Fatture in Cloud (per-rivenditore)

I token OAuth di Fatture in Cloud sono memorizzati nella tabella `retailers` (colonne `fattureInCloudAccessToken`, `fattureInCloudRefreshToken`, `fattureInCloudTokenExpiresAt`). Prima di ogni chiamata API, il servizio di sincronizzazione verifica la scadenza del token tramite `isTokenExpired()` e, se necessario, esegue il refresh automatico chiamando `refreshAccessToken()` e aggiornando i valori nel database.

---

## 8. Route HTTP Express

Oltre alle procedure tRPC su `/api/trpc`, il server espone le seguenti route HTTP dirette:

| Metodo | Path | File | Descrizione |
|---|---|---|---|
| `GET` | `/api/oauth/callback` | `server/_core/oauth.ts` | Callback Manus OAuth (login utenti) |
| `GET` | `/api/fattureincloud/callback` | `server/fattureincloud-routes.ts` | Callback OAuth Fatture in Cloud. Riceve `code` e `state`, scambia token, salva nel DB, avvia sync iniziale, mostra pagina HTML di conferma |
| `POST` | `/api/fattureincloud/webhook` | `server/fattureincloud-routes.ts` | Webhook Fatture in Cloud. Riceve eventi JSON, identifica rivenditore tramite `company_id`, avvia sincronizzazione asincrona. Risponde sempre `200 OK` |

---

*Documentazione generata automaticamente da Manus AI — Aprile 2026*
