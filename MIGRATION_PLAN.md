# MIGRATION_PLAN.md — Da Manus.im a Supabase + Vercel

> Piano di migrazione granulare. Ogni step ha:
> **Cosa fare** • **Come testare** • **Criterio di accettazione** • **Rischi**.
>
> Branch di lavoro: `migration/manus-to-supabase`.
> Le modifiche sono sempre fatte come commit incrementali; nessuna
> operazione distruttiva sul codice originale (resta su `main` finché non
> diamo il go al cutover).

---

## Fase 0 — Preparazione

### Step 0.1 — Branch + documenti di migrazione
**Cosa fare:** creare branch dedicato, scrivere `CLAUDE.md`,
`MIGRATION_PLAN.md`, `MIGRATION_LOG.md`, fare primo commit.
**Come testare:** `git status` pulito sul branch, `main` invariato.
**Criterio:** branch presente, 3 file committati.
**Rischi:** nessuno.
**Stato:** 🟢 Completato (questo step).

### Step 0.2 — Baseline funzionale del progetto attuale
**Cosa fare:**
- `pnpm install`
- `pnpm check` (typecheck) e `pnpm test` per fissare la baseline
- Annotare in `MIGRATION_LOG.md` quali test passano OGGI (così sappiamo cosa
  non regredire)
- Non avviare il dev server: senza credenziali Manus non si autentica.

**Come testare:** `pnpm check` deve completare senza errori. `pnpm test`
deve eseguire (anche se alcuni test richiedono mock e potrebbero saltare).
**Criterio:** baseline annotata.
**Rischi:** dipendenze non installabili (lockfile rotto). Mitigazione:
non rimuoviamo nulla, installiamo solo.

---

## Fase 1 — Setup ambienti esterni (richiede utente)

### Step 1.1 — Creazione progetto Supabase
**Cosa fare (UTENTE):**
1. Andare su https://supabase.com/dashboard, creare progetto Free tier,
   regione EU (consiglio `eu-central-1` Frankfurt).
2. Annotare: `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
   `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`, `DATABASE_URL`
   (modalità Transaction per pgbouncer).
3. Comunicare a Claude i valori (preferibile via file `.env` locale, mai
   in repo).

**Come testare:** Claude tenta una connessione di prova con `psql` o nodo
script.
**Criterio:** connessione OK, latenza accettabile.
**Rischi:** Free tier ha limiti (500MB DB, sospensione dopo 7gg di
inattività). Per il volume attuale è ampio.

### Step 1.2 — Creazione progetto Vercel
**Cosa fare (UTENTE):**
1. Account Vercel Hobby, link al repo GitHub.
2. Annotare il dominio assegnato (es. `app-soketo.vercel.app`).
3. **Non** triggerare deploy ancora (faremo manualmente quando il branch
   è pronto).

**Come testare:** progetto visibile in dashboard Vercel.
**Criterio:** progetto Vercel pronto, dominio noto.
**Rischi:** scelta nome irreversibile in URL gratuito.

---

## Fase 2 — Conversione schema e ORM (MySQL → Postgres)

### Step 2.1 — Aggiungere dipendenze Postgres
**Cosa fare:**
- `pnpm add postgres` (driver `postgres-js`, leggero, ottimo per Drizzle)
- `pnpm add @supabase/supabase-js @supabase/ssr` (auth)
- Mantenere temporaneamente `mysql2` per non rompere il main (lo rimuoveremo
  alla fine).

**Come testare:** `pnpm install` ok, `pnpm check` ancora verde.
**Criterio:** dipendenze in `package.json`.
**Rischi:** conflitti di peer deps. Mitigazione: pin versioni minori.

### Step 2.2 — Riscrivere `drizzle/schema.ts` per Postgres
**Cosa fare:**
- Creare `drizzle/schema.ts` riscritto con `pgTable`, `pgEnum`, `serial`,
  `integer`, `varchar`, `text`, `timestamp`.
- Mantenere TUTTI i nomi di colonna e tabelle (lowerCamelCase) identici.
- Convertire enum: `mysqlEnum("type", ["IN","OUT","ADJUSTMENT"])` →
  definire `pgEnum("stockMovementType", [...])` poi `type:
  stockMovementType("type").notNull()`.
- Rimuovere `.onUpdateNow()` (gestito a livello applicativo).
- Tabella `users`: rinominare `openId` → `supabaseUserId` (UUID stringa).
  Tipo: `varchar({ length: 64 })` resta valido (UUID encoded in 36 char).
- `int` flag (`isLowCarb`, `isGlutenFree`, `isKeto`, `syncEnabled`):
  decisione → restano `integer` per minimizzare cambi nel resto del codice.
  Si potrà migrare a `boolean` in un secondo momento.

**Come testare:**
- `pnpm check` (TS deve compilare contro nuovi tipi)
- `pnpm exec drizzle-kit generate` su un nuovo `drizzle.config.ts` (vedi
  step successivo) deve produrre SQL Postgres pulito.

**Criterio:** schema TS compila e genera migrazione SQL.
**Rischi medi:** import path fragili. Tutti i file che importano
`from "../drizzle/schema"` devono continuare a funzionare (i tipi sono
re-exportati).

### Step 2.3 — Aggiornare `drizzle.config.ts`
**Cosa fare:** `dialect: "postgresql"`, mantenere
`url: process.env.DATABASE_URL`.

**Come testare:** `pnpm exec drizzle-kit generate` produce file SQL
Postgres-compatibile.
**Criterio:** generazione OK senza errori.
**Rischi:** drizzle-kit potrebbe trovare ambiguità con vecchie migrazioni
MySQL in `drizzle/`. Mitigazione: spostare le vecchie migrazioni in
`drizzle/legacy_mysql/` (mai eliminare, backup).

### Step 2.4 — Convertire `server/db.ts` a Postgres
**Cosa fare:**
- Sostituire `import { drizzle } from "drizzle-orm/mysql2"` con
  `import { drizzle } from "drizzle-orm/postgres-js"` + `import postgres
  from "postgres"`.
- `drizzle(process.env.DATABASE_URL!)` con un `postgres(connectionString,
  { prepare: false })` (richiesto da pgbouncer Supabase).
- `createRetailer` / `createProduct` / `createAlert` / `createSyncLog`:
  passare a `.returning({ id: <table>.id })` invece di `result[0].insertId`.
- `upsertInventory`: usare `.onConflictDoUpdate` invece dell'attuale
  pattern read-then-update (oppure tenere il pattern che è
  database-agnostic, ma evitare race condition).
- `upsertUser`: convertire `.onDuplicateKeyUpdate` in
  `.onConflictDoUpdate({ target: users.supabaseUserId, set: {...} })`.
- Aggiungere update esplicito di `updatedAt: new Date()` in tutte le
  `db.update(...)` (ex `onUpdateNow`).

**Come testare:** `pnpm check` verde. Test DB integration: piccolo script
`scripts/smoke-db.ts` che crea/legge/cancella un retailer fittizio
contro il DB Supabase.
**Criterio:** smoke script gira contro Supabase, ritorna OK.
**Rischi alti:** facile dimenticare un `insertId` o `onUpdateNow`. Cercare
con grep prima di committare. La fase di test deve essere accurata.

### Step 2.5 — Generare migrazione iniziale Postgres + applicarla
**Cosa fare:**
- `pnpm exec drizzle-kit generate` → genera `drizzle/0000_initial_pg.sql`.
- Verificare che corrisponda allo schema atteso (col types, enum,
  constraints).
- `pnpm exec drizzle-kit migrate` contro Supabase Free.
- Verificare in Supabase Studio che le 7 tabelle siano presenti.

**Come testare:** query manuale da Supabase Studio: `SELECT
table_name FROM information_schema.tables WHERE table_schema = 'public'`.
**Criterio:** 7 tabelle + enum types presenti.
**Rischi:** migrazione fallita per credenziali errate / TLS. Mitigazione:
test connection string con `psql` prima.

---

## Fase 3 — Migrazione dati

### Step 3.1 — Convertire `dump_manus_DATA.sql` in formato Postgres
**Cosa fare:**
- Estrarre solo le sezioni `INSERT INTO` da `dump_manus_DATA.sql`.
- Riformattare: rimuovere backtick, convertire `\'` → `''`, gestire
  date/timestamp.
- Salvare come `migration_data/postgres_data.sql`.
- Ignorare la riga `users`: il record Manus non ha senso in Supabase.
  Lo user verrà creato dopo via Supabase Auth.

**Come testare:** import in Supabase Studio (SQL editor) o via `psql`.
Verificare conteggi: 13 retailers, 8 products, 2 inventory.
**Criterio:** `SELECT count(*) FROM retailers` = 13, `products` = 8,
`inventory` = 2, altre = 0.
**Rischi:** encoding caratteri italiani / accenti. Mitigazione: file UTF-8,
verificare con query select.

### Step 3.2 — Resettare sequence ID dopo l'import
**Cosa fare:** dopo l'import, `SELECT setval('retailers_id_seq',
(SELECT MAX(id) FROM retailers))` per ogni tabella con sequence,
altrimenti il primo INSERT applicativo darà errore di duplicate key.

**Come testare:** insert di prova di un nuovo retailer da app, deve avere
`id = 14`.
**Criterio:** insert riuscito, id consecutivo.
**Rischi:** dimenticare una tabella → bug runtime. Mitigazione: script
unico che lo fa per tutte.

---

## Fase 4 — Auth: Manus → Supabase Auth

### Step 4.1 — Setup Supabase Auth lato frontend
**Cosa fare:**
- Creare `client/src/lib/supabase.ts` con
  `createBrowserClient(VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY)`.
- Creare pagina `client/src/pages/Login.tsx` (form email+password
  oppure magic link, da decidere con utente).
- Configurare Supabase Auth per generare cookie HttpOnly via
  `@supabase/ssr` (anche se la app è SPA, il cookie facilita la verifica
  server-side).

**Come testare:** UI login si vede, può fare signup/login con utente
admin creato manualmente da Supabase dashboard.
**Criterio:** login con email reale → ricezione JWT.
**Rischi:** flow magic link richiede SMTP configurato (Supabase Free ha
SMTP default ma con rate-limit). Email+password è più semplice.

### Step 4.2 — Sostituire `client/src/const.ts` e `useAuth.ts`
**Cosa fare:**
- Rimuovere `getLoginUrl()` (era specifico Manus). Sostituire con redirect
  a `/login`.
- Riscrivere `_core/hooks/useAuth.ts` per leggere session da Supabase
  client (`supabase.auth.getSession()`, `onAuthStateChange`) invece che
  da `trpc.auth.me`. Mantenere la stessa interfaccia
  `{ user, loading, isAuthenticated, logout }` per non rompere i consumer.
- Aggiornare `client/src/main.tsx`: il redirect on 401 va a `/login` non
  più a Manus portal.

**Come testare:** dopo login, `useAuth()` ritorna l'utente. Logout
disconnette correttamente.
**Criterio:** hook funzionante, navigazione fluida.
**Rischi medi:** localStorage `manus-runtime-user-info` può rimanere
orfano. Pulizia esplicita.

### Step 4.3 — Sostituire backend auth (`sdk.ts`, `oauth.ts`, `context.ts`)
**Cosa fare:**
- Eliminare `server/_core/oauth.ts` (callback Manus) e la registrazione
  in `index.ts`.
- Eliminare `server/_core/sdk.ts`.
- Riscrivere `server/_core/context.ts`:
  - Leggere il JWT dalla request (cookie HttpOnly Supabase oppure header
    `Authorization: Bearer`).
  - Verificare con `jose.jwtVerify(jwt, supabaseJwtSecret)` (Supabase
    firma con HS256 + il `SUPABASE_JWT_SECRET`).
  - Usare il `sub` (UUID) per leggere `users` table; se mancante,
    upsert con email da JWT payload.
- Aggiornare `server/_core/env.ts`: rimuovere `appId`, `oAuthServerUrl`,
  `forgeApi*`, `ownerOpenId`. Aggiungere `supabaseJwtSecret`,
  `supabaseUrl`, `supabaseServiceRoleKey`, `ownerEmail`.
- Aggiornare `server/db.ts upsertUser`: il primo accesso dell'email
  configurata in `OWNER_EMAIL` riceve `role = 'admin'`.

**Come testare:** integration test end-to-end:
1. Login da UI → Supabase JWT in cookie.
2. Chiamata tRPC `retailers.list` → 200 con dati.
3. Chiamata senza cookie → 401.

**Criterio:** flusso login + chiamata protected procedure OK.
**Rischi alti:** cookie sameSite, dominio, secure devono combaciare tra
client e server. Test in locale (`localhost`) e in Vercel preview prima
del cutover.

### Step 4.4 — Aggiornare `server/_core/cookies.ts`
**Cosa fare:** passare `sameSite: 'lax'` (non più `'none'`) perché
front + back saranno sullo stesso dominio Vercel. `secure` resta dinamico.
**Come testare:** browser dev-tools, cookie `sb-...` ha `SameSite=Lax`,
`Secure` su prod, `HttpOnly`.
**Criterio:** flag corretti.
**Rischi:** se manteniamo dominio diverso (es. backend separato), serve
`'none'`. Validare assunzione "stesso dominio" prima.

---

## Fase 5 — Pulizia codice Manus-specific

### Step 5.1 — Rimuovere Forge helpers non usati
**Cosa fare:** `git rm` di:
- `server/storage.ts`
- `server/_core/llm.ts`
- `server/_core/imageGeneration.ts`
- `server/_core/notification.ts`
- `server/_core/voiceTranscription.ts`
- `server/_core/map.ts`
- `server/_core/dataApi.ts`

**Come testare:** `pnpm check` deve passare (verifica niente li importa).
**Criterio:** TS verde.
**Rischi bassi:** dimenticare un import. Mitigazione: typecheck.

### Step 5.2 — Stub o rimuovi `systemRouter`
**Cosa fare:** lasciare solo `health`, rimuovere `notifyOwner`. Oppure
rimuovere il router intero (non è chiamato dalla UI).
**Come testare:** `pnpm check` + smoke su `/api/trpc/system.health`.
**Criterio:** OK.
**Rischi:** nessuno.

### Step 5.3 — Pulire `vite.config.ts`
**Cosa fare:**
- Rimuovere `vitePluginManusRuntime`, `jsxLocPlugin`,
  `vitePluginManusDebugCollector`.
- Rimuovere `allowedHosts` `.manus.computer` etc.
- Mantenere alias `@`, `@shared`, `@assets`.

**Come testare:** `pnpm build` produce bundle pulito; nessun warning su
plugin mancante.
**Criterio:** build OK.
**Rischi bassi.**

### Step 5.4 — Rimuovere dipendenze Manus
**Cosa fare:** `pnpm remove vite-plugin-manus-runtime
@builder.io/vite-plugin-jsx-loc @aws-sdk/client-s3
@aws-sdk/s3-request-presigner mysql2`.
**Come testare:** `pnpm install` + `pnpm check` + `pnpm build`.
**Criterio:** dipendenze rimosse, build OK.
**Rischi bassi.**

---

## Fase 6 — Adattamento per Vercel

### Step 6.1 — Creare entry point serverless
**Cosa fare:**
- Creare `api/[[...path]].ts` che importa l'app Express e la riesporta come
  default handler. Pattern:
  ```ts
  import app from "../server/_core/app"; // factory che ritorna l'Express app
  export default app;
  ```
- Refactor `server/_core/index.ts`: estrarre la creazione dell'app in
  `server/_core/app.ts` (no `listen`), e tenere `index.ts` solo per
  `app.listen()` in dev locale (`pnpm dev`).
- Vercel rileva `api/[[...path]].ts` come Serverless Function (Node.js
  runtime).

**Come testare:** `vercel dev` localmente, hit `http://localhost:3000/api/trpc/system.health`.
**Criterio:** risposta 200.
**Rischi:** assett statici frontend e API non in conflitto. Soluzione:
`vercel.json` per `outputDirectory: dist/public` e `functions` solo in `api/`.

### Step 6.2 — `vercel.json`
**Cosa fare:** creare `vercel.json` con:
```json
{
  "buildCommand": "pnpm build",
  "outputDirectory": "dist/public",
  "functions": {
    "api/[[...path]].ts": { "maxDuration": 30 }
  },
  "rewrites": [
    { "source": "/api/(.*)", "destination": "/api/$1" },
    { "source": "/(.*)", "destination": "/index.html" }
  ]
}
```
**Come testare:** `vercel build` locale.
**Criterio:** build OK senza errori.
**Rischi:** SPA routing per wouter (catch-all `/(.*)` → index.html) deve
essere PRIMA del catch-all API. Verificare ordine.

### Step 6.3 — Adattare `package.json`
**Cosa fare:**
- `"build": "vite build"` (Vercel non bundla l'API; lo fa esbuild
  automaticamente da `api/`). Rimuovere il bundle esbuild manuale.
- `"dev"`: lasciare per Express puro in locale (`tsx watch
  server/_core/index.ts`).

**Come testare:** `pnpm build` produce solo `dist/public`. Vercel build
in cloud bundla `api/`.
**Criterio:** build locale OK.

---

## Fase 7 — Configurazione e deploy

### Step 7.1 — Variabili d'ambiente Vercel
**Cosa fare (UTENTE su pannello Vercel):** inserire tutte le variabili
elencate in `CLAUDE.md` §5 (Supabase + FIC). Le variabili `VITE_*` vengono
esposte al client; le altre solo al server.
**Come testare:** `vercel env pull .env.local`, poi `pnpm dev`.
**Criterio:** server avvia, frontend si connette a Supabase.
**Rischi:** dimenticare una variabile. Mitigazione: checklist nel log.

### Step 7.2 — Aggiornare Fatture in Cloud OAuth redirect URI
**Cosa fare (UTENTE su portale FIC):** aggiornare il redirect URI a
`https://<DOMINIO_VERCEL>/api/fattureincloud/callback`.
**Come testare:** simulare flusso OAuth con un retailer di test.
**Criterio:** callback risponde 200 e salva token.
**Rischi medi:** se l'URI è cambiato e qualche retailer aveva sync attivo,
i token esistenti continuano a funzionare ma i nuovi auth flow no finché
non si aggiorna. Stato attuale: 0 retailer con sync attivo, rischio nullo.

### Step 7.3 — Primo deploy in preview Vercel
**Cosa fare:** push branch `migration/manus-to-supabase`. Vercel crea
deployment preview.
**Come testare:**
- Login con utente admin.
- CRUD retailer / product.
- Visualizzazione dashboard.
- Creazione movimento stock manuale.
- Ack/resolve di un alert.
- Endpoint OAuth callback FIC ritorna pagina HTML di conferma.

**Criterio:** tutte le funzionalità operative su preview.
**Rischi alti:** cold start lento, errori di runtime visibili solo in
Vercel logs. Pianificare 1-2 iterazioni di fix.

### Step 7.4 — Validazione utente
**Cosa fare (UTENTE):** test manuale completo su preview Vercel +
Supabase. Lista checklist:
- [ ] Login OK
- [ ] Dashboard mostra KPI corretti (13 retailer, 8 prodotti)
- [ ] Lista retailer mostra 13 elementi
- [ ] Dettaglio retailer (inventario + movimenti + alert)
- [ ] Crea/modifica/elimina retailer
- [ ] Crea/modifica/elimina prodotto
- [ ] Logout

**Criterio:** tutti i punti verdi.
**Rischi:** scoperta di feature non testabile senza dati FIC reali.

### Step 7.5 — Promote a production
**Cosa fare (UTENTE):** in Vercel, promote del deployment preview a
production. Configurare custom domain se desiderato.
**Come testare:** stessa checklist di 7.4 su URL production.
**Criterio:** prod operativa.
**Rischi bassi** se preview è OK.

---

## Fase 8 — Decommissioning

### Step 8.1 — Documentare nuova URL e credenziali in MIGRATION_LOG.md
**Cosa fare:** salvare nel log: URL Vercel finale, project ID Supabase,
nuovo redirect URI FIC, data del cutover.
**Criterio:** log aggiornato.
**Rischi:** nessuno.

### Step 8.2 — Spegnere Manus
**Cosa fare (UTENTE):** dopo ≥7 giorni di operatività in Vercel/Supabase
senza issues, rimuovere il progetto da Manus dashboard. **Non prima.**
**Come testare:** prod Vercel risponde, app accessibile.
**Criterio:** Manus offline, prod operativa.
**Rischi alti se fatto troppo presto.** Pianificare finestra di overlap.

### Step 8.3 — Merge `migration/manus-to-supabase` → `main`
**Cosa fare:** dopo go-live confermato, merge fast-forward o squash su
main. Tag release `v2.0.0-supabase`.
**Criterio:** main aggiornato.
**Rischi:** nessuno se prod è già su Vercel (il main aggiornato è solo
fonte di verità per future modifiche).

---

## Riepilogo dipendenze utente

| Step | Cosa serve dall'utente |
|---|---|
| 1.1 | Creare progetto Supabase, fornire credenziali |
| 1.2 | Creare progetto Vercel, scegliere nome/dominio |
| 4.1 | Decidere metodo login (email/password, magic link, Google) |
| 4.3 | Fornire `OWNER_EMAIL` |
| 7.1 | Inserire env vars in dashboard Vercel |
| 7.2 | Aggiornare redirect URI in pannello FIC |
| 7.4 | Validare checklist su preview |
| 7.5 | Promote a production |
| 8.2 | Spegnere Manus dopo overlap di sicurezza |

Tutti gli step di codice (Fase 2, 3, 5, 6) sono in autonomia di Claude.
