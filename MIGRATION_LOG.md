# MIGRATION_LOG.md — Diario di migrazione Manus → Supabase + Vercel

> Diario cronologico inverso (più recente in alto). Per ogni step:
> data, esito, problemi incontrati, soluzioni adottate, link a commit.

Branch di lavoro: `migration/manus-to-supabase`.
Riferimento piano: `MIGRATION_PLAN.md`.

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
