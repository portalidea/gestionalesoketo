# MIGRATION_LOG.md — Diario di migrazione Manus → Supabase + Vercel

> Diario cronologico inverso (più recente in alto). Per ogni step:
> data, esito, problemi incontrati, soluzioni adottate, link a commit.

Branch di lavoro: `migration/manus-to-supabase` → mergiato in `main`.
Riferimento piano: `MIGRATION_PLAN.md`.

---

## 2026-04-30 (sera+) — Performance hotfix — Dashboard hang in produzione

### Sintomo

Login funzionante in produzione (post-fix JWKS ES256), ma la home `/`
restava in loading infinito. Le altre pagine (retailers, products,
alerts, settings) rispondevano normalmente. Sintomo conferma da
Vercel logs: `FUNCTION_INVOCATION_TIMEOUT` su `/api/trpc/dashboard.getStats`.

### Root cause

Combinazione di due fattori:

1. **N+1 query** in `dashboard.getStats` (`server/routers.ts`): 3 query
   iniziali + 13 chiamate `getInventoryByRetailer` + N `getProductById`
   in loop sequenziale. ~18 query totali.

2. **Connection pool `max: 1`** in `server/db.ts`. Su istanze Vercel
   warm il pooler Supabase (Supavisor in transaction mode) può chiudere
   connessioni idle lato server, ma il driver `postgres-js` non lo
   rileva subito e una query successiva può hangare aspettando una
   risposta che non arriverà mai. Con `max: 1` quella connessione era
   l'unica disponibile, quindi tutte le query successive si
   accodavano dietro all'hang.

Test locale del loop vecchio: ~1500ms (lento ma completa). In
produzione: hang fino al timeout 60s di Vercel.

### Fix

**`server/db.ts`** — pool resiliente:
```ts
postgres(process.env.DATABASE_URL, {
  prepare: false,
  max: 5,              // era 1
  idle_timeout: 20,    // chiude conn idle dopo 20s
  max_lifetime: 60*5,  // cycling regolare ogni 5 min
  connect_timeout: 10, // fail-fast in connect
});
```

**`server/db.ts`** — nuova `getDashboardStats()` con 4 query parallele
(`Promise.all`):
- `count(*)::int` su retailers, products, alerts(WHERE status='ACTIVE')
- `inventory INNER JOIN products` per ottenere quantity, expirationDate,
  unitPrice, minStockThreshold in una sola query

Tutto il calcolo aggregato (totalValue, lowStock, expiring) avviene
in memoria sulle righe joinate, zero query nel loop.

**`server/routers.ts`** — `dashboard.getStats` ridotto a thin wrapper:
```ts
getStats: protectedProcedure.query(async () => {
  return await db.getDashboardStats();
}),
```

**Diagnostico**: `console.error` (era warn) sui catch di getDb e
getDashboardStats, sempre attivo (anche in produzione). Visibile nei
Vercel runtime logs.

### Timing locale (post-fix)

```
[dashboard] getStats 237ms  ← cold (prima conn)
[dashboard] getStats  52ms  ← warm
```

Vs ~1500ms del pattern N+1 vecchio = **6x più veloce a freddo, 30x a
caldo**.

### Verifica produzione (post-deploy `b96c107`)

Tutte le tRPC procedures rispondono <310ms con auth check funzionante:
```
/api/trpc/dashboard.getStats   → 401 UNAUTHORIZED (no auth)  ~300ms
/api/trpc/retailers.list       → 401 UNAUTHORIZED (no auth)  307ms
/api/trpc/products.list        → 401 UNAUTHORIZED (no auth)  236ms
/api/trpc/alerts.getActive     → 401 UNAUTHORIZED (no auth)  265ms
/api/health                    → 200 OK
```

Niente più hang. Conferma finale richiesta: utente apre dashboard in
produzione con sessione admin attiva, KPI deve caricare in <1s.

### Punti di attenzione aperti

- Pattern simile (N+1 in loop sequenziale) potrebbe esistere in altre
  procedure (es. `retailers.getDetails` aggrega inventory+movements+
  alerts per un retailer). Monitorare.
- `console.error` di diagnostica sempre attivo in produzione: utile per
  debug post-deploy, da valutare se ridurre verbosità una volta
  stabile.

---

## 2026-04-30 (sera) — Step 3 hotfix — Bug critico Auth: HS256 vs ECDSA P-256

### Sintomo

Login in produzione non riesce: dopo magic link → `/auth/callback` →
sessione Supabase OK lato client → tRPC `auth.me` ritorna `null` →
`useAuth` rimanda al `/login` → loop.

### Root cause

Il progetto Supabase `aejwoytoskihmtlgtfaz` usa **JWT Signing Keys
ECDSA P-256 (ES256)** come Current Key. Il vecchio HS256 secret resta
nel pannello come "Previous Key" ma **i nuovi token sono firmati con
la Current asimmetrica**, non con il secret HS256.

Il backend in `server/_core/context.ts` verificava i JWT con:
```ts
const jwtSecret = new TextEncoder().encode(ENV.supabase.jwtSecret);
const { payload } = await jwtVerify(token, jwtSecret, {
  algorithms: ["HS256"],
});
```

Quindi ogni JWT fresco lato client (firmato ES256) falliva la verifica
con `JWSSignatureVerificationFailed`, il `catch` lo silenziava in
production (loggava solo in dev), `user` restava `null`, le
protectedProcedure rispondevano UNAUTHORIZED, il client tornava a
`/login`.

### Fix

`server/_core/context.ts` riscritto per usare `createRemoteJWKSet` di
`jose` (già nelle deps):

```ts
const SUPABASE_ISSUER = `${ENV.supabase.url}/auth/v1`;
const JWKS = createRemoteJWKSet(
  new URL(`${SUPABASE_ISSUER}/.well-known/jwks.json`),
);
// ...
const { payload } = await jwtVerify(token, JWKS, {
  algorithms: ["ES256"],
  issuer: SUPABASE_ISSUER,
  audience: "authenticated",
});
```

`createRemoteJWKSet` cacha le chiavi in memory, refetch automatico se
incontra un `kid` non in cache. Niente TTL fisso, ottimale per un
serverless (1 RTT al cold start, poi cache).

Sanity check JWKS endpoint:
```
GET https://aejwoytoskihmtlgtfaz.supabase.co/auth/v1/.well-known/jwks.json
→ { "keys": [{ "alg": "ES256", "crv": "P-256", "kty": "EC",
              "kid": "1c158780-...", "use": "sig", "x": "...", "y": "..." }] }
```

`SUPABASE_JWT_SECRET` resta in env vars per ora (richiesta in
`env.ts`, non rompe nulla, eventualmente removed in cleanup successivo).

### Fix collaterale (fast-path /api/health)

Notato durante la diagnosi: il fast-path `/api/health` in
`vercel-handler/index.ts` non matchava in produzione (Express
rispondeva 404) perché Vercel, dopo il rewrite `vercel.json`, può
passare `req.url = "/api"` mentre `req.originalUrl = "/api/health"`.
Fast-path aggiornato a usare `req.originalUrl ?? req.url`,
normalizzando query string e trailing slash.

### Stato pre-push

- `server/_core/context.ts`: ✅ ES256 + JWKS pubblico
- `vercel-handler/index.ts`: ✅ fast-path tolerante
- `api/index.js`: ✅ rigenerato 3.2MB con esbuild
- Bundle locale: caricato pulito (`require('./api/index.js')` shape ok)
- JWKS endpoint: reachable, format ES256/P-256/EC come atteso
- Test login locale browser: **non eseguibile dall'AI** (richiede
  click manuale magic link); demandato all'utente post-deploy

### Da verificare post-deploy

1. `/api/health` → 200 con marker `vercel-handler-alive` + env summary
2. Login completo in produzione (utente fa magic link da browser)
3. `auth.me` ritorna profilo non-null (admin role per
   alessandro@soketo.it)

---

## 2026-04-30 (mattina, 08:23–09:16) — Step 4 — Deep-dive bundle Vercel

### Sessione mattutina, 12 commit, deploy NON confermato funzionante

Lavorato sul bundling della serverless function dopo che la diagnostica
abilitata ieri (`5b07a74`) aveva rivelato `ERR_MODULE_NOT_FOUND: Cannot
find module '/var/task/server/_core/context'`.

### Catena di tentativi (in ordine cronologico)

1. **`e5ea4cd`** — `engines.node = 20.x` in package.json. Non basta:
   stesso `Cannot find module` (Node 20 conferma da diagnostic JSON).
2. **`5b07a74`** — già di ieri, self-diagnostic JSON al boot fail.
3. **`e3c2ca1`** — drop `includeFiles` da vercel.json. Stesso errore.
4. **`5da27b1`** — switch da dynamic a static imports. Risultato: text/plain
   `FUNCTION_INVOCATION_FAILED` (la diagnostic non parte perché lo
   static import fallisce a livello di module load).
5. **`61131bc`** — aggiunto `api/package.json` con `{"type":"commonjs"}`
   per forzare CJS bundling. Stesso 500.
6. **`1efcd4c`** — pre-bundle con esbuild come build step (`pnpm build:api`),
   source spostata in `vercel-handler/index.ts`, output `api/index.js`
   (gitignored), eliminato `api/index.ts`. Con `--packages=external`. 500.
7. **`a023cf0`** — drop `--packages=external`, bundle self-contained 3.2MB
   (tutte le deps inlined). 500.
8. **`92bde04`** — aggiunto fast-path `/api/health` diagnostico (env summary,
   bootStarted, nodeVersion). 500.
9. **`69b9a05`** — sostituito handler con minimal hello-world (no imports,
   1.3KB). Anche questo 500.
10. **`8f1a432`** — handcrafted `api/index.js` direttamente committato in
    git (no build:api), CJS minimal con `res.status(200)`. 500.
11. **`9072ad0`** — handcrafted con raw Node http API
    (`res.statusCode = 200; res.end(...)`), 4 righe. 500.
12. **`80bfa54` ⭐** — fixato **`vercel.json`**: `functions.api/index.ts`
    → `functions.api/index.js`. **Deploy ha funzionato in ~25s, HTTP 200
    con marker `raw-node-handler`**. Era questo il root cause di tutto:
    `vercel.json` puntava a un file (`api/index.ts`) che avevo eliminato,
    Vercel non applicava la config corretta e il deploy era rotto.
13. **`ffa52e7`** — ripristinato handler full (vercel-handler/index.ts con
    tRPC+Express+diagnostic), riabilitato `pnpm build:api`, `api/index.js`
    rimesso gitignored. **Non landed** dopo 8+ minuti di polling
    (continuava a rispondere `raw-node-handler` di `9072ad0`).
14. **`82767ba`** — committato `api/index.js` (3.2MB) direttamente in git,
    sospettando che Vercel fa function detection prima del build. **Non
    confermato live al momento dello stop.**

### Root cause confermato

`vercel.json` aveva `"functions": { "api/index.ts": ... }` ma `api/index.ts`
era stato eliminato in commit `1efcd4c`. Per ~50 minuti Vercel ha
risposto `FUNCTION_INVOCATION_FAILED` text/plain a qualunque modifica
perché la function config puntava a un file fantasma. Una volta fixato
(`80bfa54`), un handler minimale ha risposto 200 in 25 secondi.

### Stato al momento dello stop (09:16)

- **HEAD `main`**: `82767ba`
- **`vercel.json`**: ✅ functions config corretto (`api/index.js`)
- **`api/index.ts`**: ❌ eliminato (intenzionale)
- **`api/index.js`**: ✅ committato in git, 3.2MB bundle CJS prebundled
  (esbuild → vercel-handler/index.ts con tRPC+Express+/api/health
  fast-path diagnostic)
- **`api/package.json`**: `{"type":"commonjs"}`
- **`package.json`**: `build = "vite build && pnpm build:api"`,
  `build:api` esegue esbuild prebundle
- **`vercel-handler/index.ts`**: source del handler full
- **Bundle**: generato con **esbuild** (non tsup), 3328033 bytes
- **Build locale**: ✅ verificata pulita (`pnpm build` produce
  dist/public + api/index.js senza errori)

### Risultato deploy

**INCERTO**. Ultimo poll utile mostrava ancora `raw-node-handler` di
`9072ad0` in produzione. I deploy `ffa52e7` e `82767ba` non hanno
confermato di essere live. **L'utente vedeva 404 al momento dello stop**:
da chiarire (mio ultimo poll mostrava 200, non 404 — qualcosa è cambiato
fra il mio polling e il check dell'utente).

### Da fare nella prossima sessione

1. **Verificare in Vercel Dashboard** → Deployments:
   - Quale è il deploy "Current" su production?
   - Status del deploy `82767ba`: Ready / Error / Building?
   - Se Error: leggere build logs, identificare il fail.

2. **Se `82767ba` è Error**: probabilmente il commit del bundle 3.2MB ha
   rotto qualcosa (size limit? gitignored ma ora tracked?). Considerare
   rollback a `80bfa54` come baseline working e procedere chirurgicamente.

3. **Se `82767ba` è Ready ma /api/health fa 404**: problema di routing
   con i rewrite in vercel.json (`/api/:path*` → `/api`); il path passato
   a Express dopo il rewrite potrebbe non avere più `/api/health`. Va
   ispezionato il `req.url` reale visto dal handler.

4. **Se `82767ba` è Ready e /api/health risponde 200 con marker
   `vercel-handler-alive`**: tutto a posto, procedere con flusso login
   come pianificato ieri.

### Punti di attenzione aperti

- **Approccio "commit del bundle 3.2MB"** è subottimale (file binario in
  git). Da rivedere: dovrebbe essere possibile generarlo solo durante il
  build Vercel se la function detection scansiona dopo il build. Da
  verificare.
- **Cache Vercel**: alcuni deploy hanno tardato molto (ffa52e7 mai
  confermato). Possibile che ci sia un build cache stantio da invalidare.
- **Debug aid in `vercel-handler/index.ts`** (env summary, log on-page in
  AuthCallback) **da rimuovere prima del cutover finale**. Vale anche per
  il fast-path /api/health diagnostic che espone presenza/assenza env vars.

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
