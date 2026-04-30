# MIGRATION_LOG.md — Diario di migrazione Manus → Supabase + Vercel

> Diario cronologico inverso (più recente in alto). Per ogni step:
> data, esito, problemi incontrati, soluzioni adottate, link a commit.

Branch di lavoro: `migration/manus-to-supabase` → mergiato in `main`.
Riferimento piano: `MIGRATION_PLAN.md`.

---

## 2026-04-30 — Step 4 (in corso) — Deploy Vercel + serverless bundling

### Riassunto della giornata

**Step 0–3 completati e mergiati in `main`**. Step 4 (deploy production) è
attivo: il codice è in produzione su Vercel ma il bundle serverless non
include la directory `server/` per cui `/api/health` non risponde (ultimo
deploy `ezfMTXudm` su `main`). Auth Supabase end-to-end **funziona in
locale** (login magic link → callback → tRPC autenticato OK).

### Cosa è stato fatto oggi

1. **Step 3 — Auth Supabase**: rifinito il flusso PKCE callback dopo bounce
   in produzione. Fix in `pages/AuthCallback.tsx`:
   - `8cc82c7` — attesa esplicita di `SIGNED_IN` da `onAuthStateChange`
     prima del redirect; superficie del motivo del bounce su pagina (errore
     `auth.me`, sessione mancante, ecc.) per debug.
   - `f099317` — temporaneamente i log del callback vengono renderizzati
     in pagina con delay di 5s prima del redirect (debug aid, da rimuovere
     una volta confermato il flusso production).
   - `b996dea` — exchange PKCE esplicito con logging verboso nel callback.

2. **Step 4 — Setup deploy Vercel**:
   - `5d3ec56` — preparato deploy: singola serverless function per tutto
     `/api/*`. Entry point spostato in `api/index.ts` con `export default`
     handler Express.
   - `e0fe87f` — trigger redeploy dopo aver settato env vars production
     in Vercel (DATABASE_URL pooler 6543 transaction mode, SUPABASE_URL,
     SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_JWT_SECRET,
     OWNER_EMAIL, FATTUREINCLOUD_*).
   - `1a718fa` — fix env: load `.env.local` come side-effect import prima
     della valutazione del modulo, altrimenti env risultava undefined al
     boot.

3. **Bundling serverless — iterazioni**:
   - `b3eecee` — drop `loadEnv` import dall'entry serverless (non
     disponibile fuori dal contesto Vite).
   - `f6a262b` — primo tentativo: bundle serverless con esbuild prebundle
     out of `api/`. Risultato: bundle generato ma `server/` non incluso.
   - `843c136` (**ultimo commit**) — switch a `includeFiles` in
     `vercel.json` invece del prebundle esbuild. Lasciamo a Vercel/ncc il
     bundling, ma forziamo l'inclusione dei file `server/**` e
     `drizzle/**` come asset.

### Stato attuale

- **Branch**: tutto su `main`. `migration/manus-to-supabase` mergiato.
- **Deploy production**: `ezfMTXudm` su Vercel (latest), commit `843c136`.
- **Funziona**: auth Supabase locale end-to-end, schema PG + RLS, seed
  dati (13 retailers + 8 products + 2 inventory).
- **Non funziona ancora**: `/api/health` in production. Causa: bundle
  serverless non include realmente `server/` e dipendenze tRPC. Ultimo
  fix `includeFiles` deve essere verificato sul prossimo deploy.
- **Git**: working tree clean, tutto committato e pushato.

### Da fare domani (priorità ordinata)

1. **Verificare il deploy con `includeFiles`**: aprire Vercel dashboard,
   controllare che il deploy `843c136` sia passato e che
   `https://<vercel-url>/api/health` risponda 200. Se ancora 404/500,
   ispezionare i build logs e l'output della function (probabile causa:
   path resolution di `import` dentro al bundle ncc, o dipendenze native
   non incluse — `postgres` driver, ecc.).

2. **Test login completo in produzione**: una volta che `/api/health`
   risponde, eseguire flusso end-to-end:
   - GET `/login` → form email
   - magic link via email → click → `/auth/callback`
   - polling sessione → redirect `/`
   - `auth.me` deve tornare il profilo admin.
   - Eventualmente rimuovere il delay/log di 5s in `AuthCallback.tsx`
     (`f099317`) una volta confermato che il flusso è stabile.

3. **Configurazione Supabase definitiva** (solo se step 2 OK):
   - Site URL Supabase → URL Vercel production (o dominio custom).
   - Additional redirect URLs → aggiungere
     `https://inventory.soketo.it/auth/callback`.
   - **Dominio custom**: configurare `inventory.soketo.it` su Vercel
     (DNS CNAME → cname.vercel-dns.com), aspettare emissione cert.
   - Aggiornare `FATTUREINCLOUD_REDIRECT_URI` env var Vercel al nuovo
     dominio.
   - Aggiornare il redirect URI nel pannello sviluppatori Fatture in
     Cloud (https://console.fattureincloud.it).

4. **Cutover finale + dismissione Manus**:
   - Provisioning admin via `pnpm exec tsx scripts/create-admin.ts info@soketo.it`
     (o l'email definitiva).
   - Verifica fumo completa in production: login admin, lista retailers,
     CRUD prodotti, dashboard.
   - Comunicazione cutover (se applicabile, l'utente attivo è 1).
   - Spegnimento ambiente Manus Cloud (vecchio dominio
     `foodappdash-gpwq8jmv.manus.space`): dismissione progetto Manus
     dopo conferma che il nuovo URL è stabile per 24-48h.

### Punti di attenzione aperti

- Il debug aid in `pages/AuthCallback.tsx` (delay 5s + log on-page) **va
  rimosso** prima del cutover finale. Issue tracking implicito.
- Il `redirectUri` di Fatture in Cloud è hard-coded in env, va tenuto
  allineato. Nessun retailer ha sync attivo, finestra di rischio bassa.
- Vercel Hobby timeout 10s: ancora non testato in production con sync
  FIC reale. Da osservare al primo sync manuale.

### Riferimento per la prossima sessione

Quando riapri la sessione, **leggi questo file da cima**: trovi tutto
il contesto necessario. La prima azione è verificare lo stato del deploy
`ezfMTXudm` (commit `843c136`) e procedere col punto 1 della lista "Da
fare domani".

---

## 2026-04-29 — Step 3 — Migrazione Auth: Manus OAuth → Supabase Auth

### Scenario scelto

**Scenario 2 — multi-user admin senza per-retailer scoping**.
Solo operatori SoKeto fanno login (admin/operator/viewer). I 13 retailers
restano pura anagrafica, senza login proprio. Multi-tenant per i retailers
è rimandato a Fase B (futura).

### Schema + database

- `users.role` enum riformato: `['user', 'admin']` → `['admin', 'operator', 'viewer']`. Default ora è `operator`.
- `users` table: rimossi `openId`, `loginMethod`, `lastSignedIn`. `id` ora è UUID PRIMARY KEY senza default (popolato dal trigger). `email` ora è NOT NULL UNIQUE.
- Nuova migration `0001_auth_supabase.sql` (drizzle-generata) per il refactor della tabella.
- Nuova migration manuale `0002_auth_supabase_integration.sql` con:
  - FK `public.users.id → auth.users.id ON DELETE CASCADE`.
  - Trigger `on_auth_user_created` che chiama `public.handle_new_user()`: a ogni signup su `auth.users` crea la riga in `public.users` con role default `operator` e nome derivato da `raw_user_meta_data.name` o dalla parte locale dell'email.
  - Helper SQL `public.current_user_role()` (SECURITY DEFINER, evita ricorsione RLS).
  - RLS abilitato su tutte le 7 tabelle.
  - Policy `users`: SELECT/UPDATE self-or-admin; INSERT/DELETE solo admin.
  - Policy app tables (`retailers`, `products`, `inventory`, `stockMovements`, `alerts`, `syncLogs`): SELECT a qualunque utente authenticated; INSERT/UPDATE/DELETE solo `admin` o `operator` (viewer read-only).

Nota: il backend usa il ruolo postgres del pooler (BYPASSRLS), quindi le policy non bloccano l'app server-side. Sono protezione defense-in-depth per accessi diretti via Supabase JS client (futuri scenari).

### Server refactor

- **Eliminati** (non più usati in prod, helper Manus): `server/storage.ts`, `server/_core/oauth.ts`, `server/_core/sdk.ts`, `server/_core/cookies.ts`, `server/_core/dataApi.ts`, `server/_core/llm.ts`, `server/_core/imageGeneration.ts`, `server/_core/notification.ts`, `server/_core/voiceTranscription.ts`, `server/_core/map.ts`, `server/_core/types/manusTypes.ts`, `server/_core/types/cookie.d.ts`, `client/src/components/Map.tsx`.
- **Nuovo**: `server/_core/supabase.ts` — admin client con service_role key per operazioni admin (invite/delete user).
- **Riscritto** `server/_core/context.ts`: estrae `Bearer <jwt>` da `Authorization` header, verifica con `SUPABASE_JWT_SECRET` (HS256), carica profilo da `public.users`. Niente più cookie, niente più `sdk.authenticateRequest`.
- **Esteso** `server/_core/trpc.ts`: aggiunto `writerProcedure` (admin/operator, esclude viewer) tra `protectedProcedure` e `adminProcedure`. Tutte le mutation applicative ora usano `writerProcedure`; le sole-admin (`users.invite/updateRole/delete`, `system.notifyOwner` rimosso) restano su `adminProcedure`.
- `server/_core/env.ts`: rimosse vars Manus (`appId`, `cookieSecret`, `oAuthServerUrl`, `ownerOpenId`, `forgeApiUrl`, `forgeApiKey`). Aggiunte: `supabase.{url,anonKey,serviceRoleKey,jwtSecret}`, `ownerEmail`, `fattureInCloud.*`. Fail-fast all'avvio se mancano variabili required.
- `server/_core/systemRouter.ts`: rimosso `notifyOwner` (dipendeva da Manus Forge); resta solo `health`.
- `server/_core/index.ts`: rimosso `registerOAuthRoutes`.
- `server/db.ts`: rimossa `upsertUser` (gestita ora dal trigger), `getUserByOpenId`. Aggiunte `getUserById`, `getAllUsers`, `updateUserRole`, `deleteUser`.

### Routers

- `server/routers.ts` riscritto con tipi `z.string().uuid()` per tutti gli `id` di tabelle UUID. Mutation passate da `protectedProcedure` a `writerProcedure` (escludono viewer).
- Nuovo router `users` (admin-only): `list`, `invite` (manda magic link via `supabaseAdmin.auth.admin.inviteUserByEmail`), `updateRole`, `delete`.
- `auth.logout` rimosso: il logout è gestito client-side da `supabase.auth.signOut()`. Resta solo `auth.me`.

### Client refactor

- Installato `@supabase/supabase-js`.
- Nuovo `client/src/lib/supabase.ts` con `createClient` PKCE flow + `detectSessionInUrl`.
- Nuova pagina `/login` (`pages/Login.tsx`): form email → `supabase.auth.signInWithOtp({ shouldCreateUser: false })` → conferma "controlla la tua email".
- Nuova pagina `/auth/callback` (`pages/AuthCallback.tsx`): polling breve su `getSession()`, redirect a `/` quando la sessione è creata.
- Nuova pagina `/settings/team` (`pages/Team.tsx`, admin-only): lista utenti, invito email, cambio ruolo, delete.
- `useAuth` riscritto: subscribe a `supabase.auth.onAuthStateChange`, query tRPC `auth.me` solo se sessione presente, redirect automatico a `/login` se richiesto.
- `main.tsx`: tRPC client ora aggiunge `Authorization: Bearer <jwt>` a ogni richiesta tramite `headers()` dinamico. Niente più `credentials: 'include'`.
- `client/src/const.ts`: rimosso `getLoginUrl` Manus, sostituito da `LOGIN_PATH = '/login'`.
- `App.tsx`: route `/login`, `/auth/callback`, `/settings/team`.
- `DashboardLayout`: `useAuth({ redirectOnUnauthenticated: true })`, voce "Team" nel menu solo per admin.
- `RetailerDetail`: `parseInt(params.id)` → uso diretto della stringa UUID.
- `FattureInCloudSync`: `retailerId: number` → `string`.

### Vite/build cleanup

- `vite.config.ts`: rimossi plugin `@builder.io/vite-plugin-jsx-loc`, `vite-plugin-manus-runtime`, custom `vitePluginManusDebugCollector`, `allowedHosts` Manus. Pulito e minimale.
- `package.json`: rimossi `@builder.io/vite-plugin-jsx-loc`, `vite-plugin-manus-runtime`, e il pacchetto residuo `add` (refuso storico).

### Provisioning admin

- Nuovo script `scripts/create-admin.ts`: crea utente Supabase via Admin API (idempotente), promuove a `admin` in `public.users`, manda magic link automatico. Eseguibile con `pnpm exec tsx scripts/create-admin.ts info@soketo.it`.

### Stato DB post-migration

```
users           id=uuid, email NOT NULL UNIQUE, role enum admin/operator/viewer
RLS abilitato:  users, retailers, products, inventory, stockMovements, alerts, syncLogs (7/7)
trigger:        on_auth_user_created su auth.users → public.handle_new_user
user_role:      admin, operator, viewer
```

### Punti di attenzione

1. **Configurazione Supabase Dashboard NECESSARIA**:
   - Auth → Providers: assicurarsi che "Email" sia abilitato e che "Confirm email" sia attivo (per magic link). Disabilitare social provider (non li usiamo).
   - Auth → URL Configuration: aggiungere `http://localhost:3000/auth/callback` e l'URL di production agli "Additional redirect URLs".
   - Auth → Email Templates: tradurre i template "Magic Link" in italiano (Subject + Body). Default è inglese.
   - Auth → User Management: NON consentire signup pubblico (`Disable signups: ON`) — gli utenti devono essere invitati da admin via `/settings/team`.

2. **Bootstrap admin**: dopo il deploy o appena pronto in locale, eseguire `pnpm exec tsx scripts/create-admin.ts info@soketo.it`. Il primo admin entra via magic link, poi può invitare altri da `/settings/team`.

3. **Cookie HttpOnly → localStorage**: la sessione Supabase JS è in localStorage (default). Per migliore sicurezza in futuro si può migrare a `@supabase/ssr` con cookie HttpOnly + middleware Express per il refresh.

4. **MIGRATION_PLAN sezione FIC**: il `redirectUri` Fatture in Cloud va aggiornato al cutover col nuovo dominio Vercel.

---

## 2026-04-29 — Step 2 — Schema + dati MySQL → Postgres/Supabase

### File modificati / creati

- `.env.local` (untracked, gitignored) — credenziali Supabase progetto `aejwoytoskihmtlgtfaz`.
- `.env.example` — template variabili ambiente.
- `drizzle.config.ts` — `dialect: "mysql"` → `"postgresql"`; aggiunto load di `.env.local` via dotenv.
- `package.json` / `pnpm-lock.yaml` — rimosso `mysql2`, aggiunto `postgres@3.4.9`.
- `drizzle/schema.ts` — riscritto su `drizzle-orm/pg-core`. Tutti gli `id` → `uuid` con default `gen_random_uuid()`. Definiti 5 `pgEnum` (`user_role`, `stock_movement_type`, `alert_type`, `alert_status`, `sync_status`). Tutti i `timestamp` → `timestamp({ withTimezone: true })`. Rimossi `onUpdateNow()`.
- `drizzle/0000_initial_postgres.sql` — migration nuova generata da `drizzle-kit generate`. Sostituisce le 3 vecchie migrazioni MySQL (rimosse).
- `drizzle/meta/_journal.json` + `0000_snapshot.json` — rigenerati per il nuovo dialect.
- `server/db.ts` — driver `drizzle-orm/postgres-js`. `insertId` → `.returning()`. `onDuplicateKeyUpdate` → `onConflictDoUpdate({ target: ..., set: ... })`. Tutte le firme `id: number` → `id: string`. `updatedAt` settato esplicitamente in ogni `update()`. Aggiunto `prepare: false` per compat pgbouncer/Supavisor.
- `scripts/seed.ts` — nuovo. Seed idempotente che inserisce 13 retailers + 8 products + 2 inventory rows con UUID generati e mapping `oldIntId → newUuid` per preservare le FK.

### Decisioni di design

1. **UUID al posto di serial integer** per tutti gli `id`. Motivo: allineamento con `auth.users.id` di Supabase Auth (uuid). Costo: rimappatura ID nel seed (gestita).
2. **`integer` per i flag nutrizionali** (`isLowCarb`, `isGlutenFree`, `isKeto`, `syncEnabled`). Il dump originale usa `int` (non `tinyint(1)`), e convertirli a `boolean` avrebbe richiesto modifiche a `routers.ts` per zero beneficio funzionale.
3. **No FK constraint** (al momento). Il dump non ne aveva, `db.ts` non li richiede, e li aggiungeremmo solo per integrità referenziale: rimandato a step successivo se servirà.
4. **`updatedAt` esplicito da app** invece di trigger Postgres. Pattern già applicato in `db.ts`.
5. **Manteniamo `openId` su `users`** per ora (sarà rimosso in step 3 — Auth migration).
6. **Skip dell'utente legacy** dal seed (è il test owner Manus, sarà ricreato via Supabase Auth).

### Problemi incontrati

- **Direct connection IPv6-only**. `db.aejwoytoskihmtlgtfaz.supabase.co:5432` non risolve da rete IPv4. Soluzione: pooler Supavisor.
- **Pooler endpoint nuovo**. Il prefisso DNS classico `aws-0-<region>...` restituisce `Tenant or user not found` per progetti recenti. Il prefisso corretto per questo progetto è `aws-1-<region>.pooler.supabase.com` (Supavisor v2). Identificato per probing.
- **Region**: `eu-central-1` (Frankfurt), confermato dal probe (unico endpoint con tenant valido).
- **Username pooler**: `postgres.aejwoytoskihmtlgtfaz` (con suffix project ref), non solo `postgres`.

### Connection string finale

```
postgresql://postgres.aejwoytoskihmtlgtfaz:***@aws-1-eu-central-1.pooler.supabase.com:5432/postgres
```

(port 5432 = session mode; per il runtime serverless Vercel valutare port 6543 transaction mode in step deploy.)

### Verifica record

```
retailers       13
products         8
inventory        2
stockMovements   0
alerts           0
syncLogs         0
users            0
```

Tutti i conteggi corrispondono al dump. FK uuid coerenti tra inventory ↔ retailers/products.

### Punti di attenzione per step successivi

- `routers.ts` usa ancora `z.number()` per gli input `id`: andrà aggiornato a `z.string().uuid()` quando si toccherà il flusso Auth (i tipi tRPC sono già rotti rispetto al nuovo `db.ts`).
- `MIGRATION_PLAN.md` parla di "convertire `tinyint(1)` → boolean": skipato perché nel dump i flag sono `int`, non `tinyint(1)`.

---

## 2026-04-29 — Step 0.1 — Setup branch + documenti di migrazione

- ✅ Creato branch `migration/manus-to-supabase` da `main` (commit
  `56bf55c`).
- ✅ Letto `DOCUMENTAZIONE_TECNICA.md`, `package.json`,
  `drizzle.config.ts`, `drizzle/schema.ts`, `server/db.ts`,
  `server/_core/*` (oauth, sdk, context, trpc, cookies, env, index, vite),
  `server/routers.ts`, `server/fattureincloud-*.ts`, `client/src/*`
  (main, App, const, lib/trpc, _core/hooks/useAuth), `shared/*`,
  `vite.config.ts`, `tsconfig.json`, dump SQL.
- ✅ Scritto `CLAUDE.md` con riassunto architetturale, mappatura
  MySQL→Postgres, mappatura Manus Auth→Supabase Auth, lista helper Manus
  da rimuovere, variabili d'ambiente nuove/da rimuovere, 10 punti di
  attenzione, 4 decisioni da chiedere all'utente.
- ✅ Scritto `MIGRATION_PLAN.md` con 8 fasi (Preparazione, Setup esterni,
  Schema/ORM, Dati, Auth, Pulizia, Vercel, Deploy, Decommissioning).
  Ogni step ha cosa fare / come testare / criterio / rischi.
- ✅ Scritto `MIGRATION_LOG.md` (questo file).

**Problemi:** nessuno.

**Prossimo step:** 0.2 — verifica baseline (`pnpm install`, `pnpm check`,
`pnpm test`) prima di cominciare modifiche al codice. Da fare nella
prossima sessione.

**Decisioni in attesa dall'utente** (vedi `CLAUDE.md` §8):
1. Nome/regione progetto Supabase.
2. Nome progetto Vercel + dominio.
3. Metodi di login Supabase da abilitare.
4. Email admin owner (sostituisce `OWNER_OPEN_ID`).
