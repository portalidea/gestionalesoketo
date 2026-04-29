# CLAUDE.md — SoKeto Inventory Manager

> Riferimento operativo per Claude Code. Riassume architettura corrente,
> obiettivo della migrazione, dipendenze critiche e punti di attenzione.

---

## 1. Cos'è il progetto

Piattaforma B2B per la gestione centralizzata del magazzino della rete
rivenditori SoKeto (ristoranti, farmacie, negozi che distribuiscono i
prodotti low-carb / gluten-free / keto).

Funzionalità principali:
- Anagrafica rivenditori e prodotti centralizzata
- Inventario per coppia (rivenditore, prodotto)
- Movimenti di magazzino (IN/OUT/ADJUSTMENT) con log immutabile
- Alert automatici per scorte basse, scadenze, prodotti scaduti
- Sincronizzazione bidirezionale con Fatture in Cloud (OAuth2 + webhook)
- Dashboard KPI aggregata per il proprietario

Volume dati attuale (vedi `dump_manus_DATA.sql`): 13 retailers, 8 products,
2 inventory rows, 1 user, 0 movements/alerts/syncLogs.

---

## 2. Stack attuale (origine: Manus.im)

| Livello | Tecnologia | Note migrazione |
|---|---|---|
| Frontend | React 19 + TypeScript 5.9 + Tailwind 4 + shadcn/ui + Wouter 3 | Resta uguale |
| Backend | Node.js + Express 4 + tRPC 11 + superjson | Resta in larga parte; cambia il deploy |
| ORM | Drizzle ORM 0.44 (dialect MySQL) | Cambia dialect → PostgreSQL |
| DB | MySQL/TiDB serverless | → **Supabase Postgres** |
| Auth | Manus OAuth + JWT cookie HttpOnly (`app_session_id`) | → **Supabase Auth** |
| Storage / LLM / Notifications | Manus Forge API (`BUILT_IN_FORGE_*`) | Helper non usati in prod, da rimuovere |
| Hosting | Manus Cloud | → **Vercel Hobby** (serverless) |
| Build | Vite 7 + esbuild | Resta; rimuoviamo plugin `vite-plugin-manus-runtime` e `@builder.io/vite-plugin-jsx-loc` |
| Pacchetti | pnpm 10 | Resta |

---

## 3. Struttura cartelle (estratto rilevante)

```
client/src/                     # Frontend React (alias @/*)
├── main.tsx                    # tRPC client, QueryClient, redirect-on-401 → getLoginUrl()
├── App.tsx                     # Router wouter, ThemeProvider (dark default)
├── const.ts                    # getLoginUrl() ← USA VARIABILI MANUS, da riscrivere per Supabase
├── _core/hooks/useAuth.ts      # Hook auth (legge auth.me, esegue logout)
├── lib/trpc.ts                 # createTRPCReact<AppRouter>
└── pages/                      # Home, Retailers, RetailerDetail, Products, Alerts, Reports, NotFound

server/                         # Backend Express + tRPC
├── routers.ts                  # Tutte le procedure (retailers, products, inventory, stockMovements, alerts, dashboard, sync, auth)
├── db.ts                       # Drizzle helper functions (mysql2)  ← DA CONVERTIRE A POSTGRES
├── storage.ts                  # Manus Forge proxy storage (non usato)
├── fattureincloud-*.ts         # Integrazione FIC (oauth, api, sync, routes)
└── _core/                      # Infrastruttura framework
    ├── index.ts                # Express boot + tRPC adapter + FIC routes + Vite/static
    ├── oauth.ts                # Callback /api/oauth/callback (Manus)  ← DA RIMUOVERE
    ├── sdk.ts                  # Verifica JWT, exchange code, getUserInfo Manus  ← DA SOSTITUIRE
    ├── context.ts              # createContext tRPC: chiama sdk.authenticateRequest
    ├── trpc.ts                 # publicProcedure / protectedProcedure / adminProcedure
    ├── cookies.ts              # getSessionCookieOptions (sameSite none, secure)
    ├── env.ts                  # Centralizza process.env  ← DA RISCRIVERE (rimuovere variabili Manus)
    ├── llm.ts / imageGeneration.ts / dataApi.ts / notification.ts / voiceTranscription.ts / map.ts  ← Manus helpers, NON USATI in prod
    ├── systemRouter.ts         # health + notifyOwner (admin)  ← notifyOwner usa Manus, da stub o rimuovere
    └── vite.ts                 # Vite middleware in dev / express.static in prod

drizzle/                        # Schema + migrazioni
├── schema.ts                   # 7 tabelle: users, retailers, products, inventory, stockMovements, alerts, syncLogs (drizzle-orm/mysql-core)  ← DA CONVERTIRE
├── relations.ts                # vuoto
├── 0000_*.sql / 0001_*.sql / 0002_*.sql  # Migrazioni MySQL  ← DA RIGENERARE

shared/                         # Costanti/tipi condivisi front+back
├── const.ts                    # COOKIE_NAME, ONE_YEAR_MS, AXIOS_TIMEOUT_MS, error msgs
├── types.ts                    # Re-export schema + errors
└── _core/errors.ts             # ForbiddenError ecc.

drizzle.config.ts               # dialect: "mysql"  ← DA CAMBIARE
vite.config.ts                  # Plugin Manus, hosts allowedHosts manus.computer  ← DA RIPULIRE
```

---

## 4. Dipendenze critiche per la migrazione

### 4.1 ORM Drizzle (MySQL → Postgres)

Differenze concrete che impattano il codice:

| MySQL (attuale) | Postgres (target) |
|---|---|
| `drizzle-orm/mysql-core` (`mysqlTable`, `mysqlEnum`, `int`, `varchar`, `text`, `timestamp`) | `drizzle-orm/pg-core` (`pgTable`, `pgEnum`, `integer`, `serial`, `varchar`, `text`, `timestamp`) |
| `drizzle-orm/mysql2` runtime + `mysql2` driver | `drizzle-orm/postgres-js` + `postgres` (oppure `node-postgres`) |
| `int().autoincrement().primaryKey()` | `serial().primaryKey()` o `integer().generatedAlwaysAsIdentity().primaryKey()` |
| `timestamp().onUpdateNow()` | **non esiste**: gestire `updatedAt` da app o con trigger PG |
| `mysqlEnum("type", [...])` | `pgEnum("type", [...])` definito separatamente, oppure `varchar` con `check` |
| `db.insert(t).values(v)` poi leggere `result[0].insertId` | `db.insert(t).values(v).returning({ id: t.id })` |
| `.onDuplicateKeyUpdate({ set })` | `.onConflictDoUpdate({ target, set })` |

**File impattati:** `drizzle/schema.ts`, `server/db.ts`, `drizzle.config.ts`,
tutte le migrazioni in `drizzle/`.

### 4.2 Autenticazione (Manus OAuth → Supabase Auth)

Flusso attuale (riassunto):
1. Frontend genera URL Manus con `getLoginUrl()`, redirect al portale Manus.
2. Manus redirect a `/api/oauth/callback?code&state` (`server/_core/oauth.ts`).
3. Backend scambia `code` con access token Manus, recupera userInfo (`openId`),
   upsert tabella `users`, firma JWT HS256 con `JWT_SECRET`, setta cookie
   HttpOnly `app_session_id` per 1 anno.
4. `createContext` tRPC verifica il JWT del cookie a ogni request, popola
   `ctx.user`. `protectedProcedure` rifiuta se `ctx.user == null`.

Flusso target con Supabase:
1. Frontend usa `@supabase/supabase-js` per login (email/password,
   magic link o OAuth Google se vogliamo). Supabase emette JWT.
2. Backend verifica il JWT (firmato da Supabase) con `SUPABASE_JWT_SECRET`
   o tramite la public key, oppure usa il client Supabase server-side con
   `@supabase/ssr`. Il JWT contiene `sub` (UUID utente in `auth.users`).
3. Tabella `users` applicativa: `openId VARCHAR(64)` → `supabaseId UUID`
   (oppure rinominato `id` se vogliamo allineare). Manteniamo l'upsert su
   primo accesso (trigger Postgres oppure logica in middleware).
4. Cookie / session: con Supabase SSR helpers oppure Authorization header
   Bearer. Il pattern HttpOnly cookie è più sicuro, lo manteniamo.

**Decisione strategica da chiedere all'utente:**
- Quali metodi di login abilitare? (email+password, magic link, Google)
- Mantenere `openId` come campo testo o passare a UUID nativo?

### 4.3 Hosting (Manus Cloud → Vercel Hobby)

Manus Cloud è long-running. Vercel Hobby è serverless function-based.
Implicazioni:

- L'attuale `server/_core/index.ts` avvia un server Express persistente. Su
  Vercel va trasformato in una **serverless function** che esporta un
  handler Express (pattern `api/index.ts` con `export default app`).
- Il dev locale può continuare a girare con `tsx watch` (Express puro).
- Build separato: frontend (`vite build`) → `dist/public`, servito come
  statico da Vercel; backend → bundle esbuild → handler serverless.
- Cold start: per Hobby è accettabile (poche richieste/min).
- Limite di esecuzione: 10s (Hobby). I sync FIC potrebbero superarlo se il
  retailer ha tanti prodotti → da valutare offload (queue) o aumentare
  budget; per ora nessun retailer ha sync attivo.
- File serverless da creare: `api/[[...path]].ts` che intercetta tutto
  `/api/*` e delega all'handler Express; oppure `api/trpc/[trpc].ts` +
  `api/oauth/*` separati. Da decidere in fase di implementazione.

### 4.4 Integrazione Fatture in Cloud (resta uguale, ma cambia URI)

- `FATTUREINCLOUD_REDIRECT_URI` deve passare da
  `https://foodappdash-gpwq8jmv.manus.space/api/fattureincloud/callback`
  al nuovo dominio Vercel (es. `https://app-soketo.vercel.app/...`).
- Va aggiornato anche nel pannello sviluppatori FIC.
- Webhook URL idem.
- Nessun retailer ha attualmente sync attivo (`syncEnabled = 0` su tutti),
  quindi la finestra di rischio è bassa.

### 4.5 Helper Manus (Forge API)

Files che dipendono da `BUILT_IN_FORGE_API_URL` / `BUILT_IN_FORGE_API_KEY`:
- `server/storage.ts` (S3 proxy)
- `server/_core/dataApi.ts`
- `server/_core/llm.ts`
- `server/_core/imageGeneration.ts`
- `server/_core/notification.ts` (usato da `systemRouter.notifyOwner`)
- `server/_core/voiceTranscription.ts`
- `server/_core/map.ts`

**Tutti questi non sono usati in produzione** (verificato cercando
import attivi: solo `notifyOwner` è chiamato da `systemRouter`, che a sua
volta non è mai chiamato da UI). Possiamo:
- Rimuoverli dal bundle (`server/_core/{llm,imageGeneration,notification,
  voiceTranscription,map,dataApi}.ts`, `server/storage.ts`).
- Stub `systemRouter` con solo `health` (oppure rimuoverlo).

### 4.6 Plugin Vite Manus

`vite.config.ts` carica:
- `@builder.io/vite-plugin-jsx-loc` (per debug Manus)
- `vite-plugin-manus-runtime`
- Custom plugin `vitePluginManusDebugCollector` (loga browser console su file)

Tutti vanno **rimossi**. Anche gli `allowedHosts` `*.manus.computer` ecc.

---

## 5. Variabili d'ambiente

### Da rimuovere (Manus-specific)

`VITE_APP_ID`, `OAUTH_SERVER_URL`, `VITE_OAUTH_PORTAL_URL`, `OWNER_OPEN_ID`,
`OWNER_NAME`, `BUILT_IN_FORGE_API_URL`, `BUILT_IN_FORGE_API_KEY`,
`VITE_FRONTEND_FORGE_API_KEY`, `VITE_FRONTEND_FORGE_API_URL`,
`VITE_ANALYTICS_ENDPOINT`, `VITE_ANALYTICS_WEBSITE_ID`, `VITE_APP_LOGO`,
`VITE_APP_TITLE`, `JWT_SECRET` (sostituito da Supabase JWT secret).

### Da aggiungere (Supabase + Vercel)

| Variabile | Lato | Sorgente |
|---|---|---|
| `DATABASE_URL` | server | Supabase → Settings → Database → Connection string (mode: `Transaction` con pgbouncer per serverless) |
| `SUPABASE_URL` | entrambi (`VITE_SUPABASE_URL` per frontend) | Project URL |
| `SUPABASE_ANON_KEY` | frontend (`VITE_SUPABASE_ANON_KEY`) | Project API keys |
| `SUPABASE_SERVICE_ROLE_KEY` | server (mai esposto al client) | Project API keys |
| `SUPABASE_JWT_SECRET` | server | Settings → API → JWT Settings |
| `OWNER_EMAIL` (sostituisce `OWNER_OPEN_ID`) | server | Decisione manuale: email dell'admin |

### Restano

`FATTUREINCLOUD_CLIENT_ID`, `FATTUREINCLOUD_CLIENT_SECRET`,
`FATTUREINCLOUD_REDIRECT_URI` (nuovo URL).

---

## 6. Punti di attenzione (rischio alto/medio)

1. **Auth è il pezzo più invasivo.** Tocca: schema `users`, `server/_core/oauth.ts`,
   `sdk.ts`, `context.ts`, `cookies.ts`, `client/src/_core/hooks/useAuth.ts`,
   `client/src/const.ts`, `client/src/main.tsx` (redirect 401), tutta la
   logica `protectedProcedure`. Va testata accuratamente prima del cutover.

2. **`onUpdateNow()` su Postgres.** Le colonne `updatedAt` e `lastUpdated`
   in `users`, `retailers`, `products`, `inventory` perdono l'auto-update
   al cambio dialect. Va replicato con trigger PG o aggiornando esplicitamente
   il campo nei `db.update()` (preferito perché esplicito).

3. **`insertId` MySQL → `RETURNING` Postgres.** Le funzioni
   `createRetailer`, `createProduct`, `upsertInventory`, `createStockMovement`,
   `createAlert`, `createSyncLog` in `server/db.ts` usano `result[0].insertId`.
   Devono passare a `.returning({ id: t.id })`.

4. **`onDuplicateKeyUpdate` in `upsertUser`.** Da convertire a
   `.onConflictDoUpdate({ target: users.openId, set: ... })`.

5. **Cookie SameSite=None.** Il flusso attuale richiede `sameSite: 'none'`
   perché Manus serviva backend e frontend su domini diversi. Su Vercel
   il dominio è unico, possiamo passare a `sameSite: 'lax'` (più sicuro).

6. **Vercel function timeout 10s su Hobby.** Sync FIC iniziale potrebbe
   eccedere. Mitigazione: sync sempre fire-and-forget (già fatto
   nel webhook); per il sync manuale via tRPC, considerare di spostarlo a
   un endpoint dedicato con `maxDuration` configurato in `vercel.json`.

7. **Migrazione dati.** Il dump è MySQL syntax. Va riscritto in Postgres
   (no backtick, `ENUM` come tipo PG creato a parte, niente `AUTO_INCREMENT`).
   Strategia: ricreare schema con Drizzle migrate, poi `INSERT` data-only
   (i record sono pochi: 13 retailers + 8 products + 2 inventory + 1 user).
   Lo user attuale (Manus openId) potrebbe non avere senso in Supabase →
   meglio ripartire con un nuovo admin user creato via Supabase Auth.

8. **Patch `wouter@3.7.1`.** In `patches/wouter@3.7.1.patch`. Va verificato
   che la patch resti compatibile dopo la migrazione (probabilmente sì,
   non c'entra con auth/db).

9. **Test esistenti.** `*.test.ts` mockano probabilmente Manus SDK / mysql.
   Vanno aggiornati o ne valutiamo la rimozione/sostituzione.

10. **CORS / dominio FIC.** Il redirect URI Fatture in Cloud è "fisso" e
    richiede aggiornamento manuale nel pannello FIC al cutover. Pianificare
    una finestra in cui il vecchio URI può ancora funzionare se necessario.

---

## 7. Cosa NON cambia

- Logica di business (calcolo statistiche dashboard, alert, movimenti).
- Schema concettuale del DB (stesse 7 tabelle, stessi campi).
- API tRPC: nomi e shape delle procedure restano identici. Cambiano solo
  le implementazioni interne di `server/db.ts`.
- Componenti UI (shadcn, Tailwind, tutte le pagine in `client/src/pages/`).
- Routing wouter.
- Integrazione Fatture in Cloud (codice resta uguale, cambia solo l'URI).

---

## 8. Decisioni che richiedono input utente

Da chiedere prima di procedere oltre lo Step 1 del piano:

1. **Nome progetto Supabase** e **regione** (consiglio EU `eu-central-1`).
2. **Nome progetto Vercel** e **dominio** (es. `app-soketo.vercel.app` o
   custom domain). 
3. **Metodi di login Supabase** da abilitare (email+password? magic link?
   Google OAuth?). L'utente attuale è 1, quindi non c'è urgenza.
4. **Email admin owner** (sostituisce `OWNER_OPEN_ID`).

Tutto il resto può procedere in autonomia.
