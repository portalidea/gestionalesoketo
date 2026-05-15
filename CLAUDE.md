# CLAUDE.md — SoKeto Gestionale

> Riferimento operativo per Claude Code. Sistema in produzione su
> https://gestionale.soketo.it dopo cutover dal vecchio stack Manus.im
> (2026-04-30). Per la storia della migrazione vedi
> [`MIGRATION_LOG.md`](./MIGRATION_LOG.md).

---

## Cos'è il progetto

Piattaforma B2B di E-Keto Food Srls per gestire l'anagrafica della
rete rivenditori SoKeto (ristoranti, farmacie, negozi, palestre che
distribuiscono prodotti low-carb/keto/gluten-free) e il loro inventario.

Funzionalità attuali (post-cutover, ≈ funzionalità Manus):
- Anagrafica rivenditori e prodotti centralizzata, CRUD completo
- Inventario per coppia (rivenditore, prodotto)
- Movimenti di magazzino in **read-only** (creazione UI disabilitata
  in attesa Phase B)
- Alert automatici per scorte basse / scadenze
- Dashboard KPI aggregata

Per la **visione completa** (sistema lotti FEFO con tracking
produttori → magazzino centrale → retailer → cliente finale,
integrazioni multi-provider gestionali) vedi sezione "Roadmap Phase B"
in fondo + sezione dettagliata in `MIGRATION_LOG.md`.

---

## Stack

| Livello | Tecnologia |
|---|---|
| Frontend | React 19 + TypeScript 5.9 + Tailwind 4 + shadcn/ui + wouter |
| Backend | Express + tRPC 11 + Drizzle ORM (postgres-js) |
| DB | Supabase Postgres (regione `eu-central-1` Frankfurt) |
| Auth | Supabase Auth (magic link), JWT verify via JWKS ECDSA P-256 |
| Hosting | Vercel Hobby — function CJS prebundled con esbuild |
| Email | Resend con dominio custom `sm.soketo.it` |
| Dominio | `https://gestionale.soketo.it` (alias Vercel) |
| Package manager | pnpm 10 |

---

## Struttura cartelle

```
client/src/                 Frontend React
  pages/                    Home, Login, AuthCallback, Retailers,
                            RetailerDetail, Products, ProductDetail,
                            Alerts, Reports, Team, Integrations
  components/               DashboardLayout, FattureInCloudSync (legacy)
  components/ui/            shadcn (button, dialog, alert-dialog, ...)
  _core/hooks/useAuth.ts    Hook auth + bounce reason

server/                     Backend Express + tRPC
  _core/
    index.ts                Express boot (dev only — Vercel usa vercel-handler/)
    context.ts              tRPC ctx + JWT verify via JWKS
    trpc.ts                 protected/writer/admin procedures
    env.ts                  ENV centralizzato
    supabase.ts             Admin client (service role)
    systemRouter.ts         /system/health
  routers.ts                Tutte le procedure tRPC (auth/users/retailers/
                            products/inventory/stockMovements/alerts/sync/dashboard)
  db.ts                     Drizzle helpers (cascade delete in transaction,
                            getDashboardStats parallelo, ecc.)
  fattureincloud-*.ts       Integrazione FIC (oauth, api, sync, routes)
                            ⚠️ legacy per-retailer; refactor single-tenant in Phase B

vercel-handler/index.ts     Source serverless function Vercel
                            → bundlato in api/index.js (esbuild)

api/index.js                Build artifact (3.2MB CJS, tracked in git per
                            Vercel pattern check pre-build)
api/package.json            { "type": "commonjs" }

drizzle/                    Schema + migrations
  schema.ts                 7 tabelle (users, retailers, products,
                            inventory, stockMovements, alerts, syncLogs)
  0000_initial_postgres.sql Schema iniziale
  0001_auth_supabase.sql    Refactor users per Supabase Auth
  0002_auth_supabase_integration.sql  FK + trigger handle_new_user + RLS

scripts/                    Utility one-shot/regression
  seed.ts                   Seed iniziale (idempotente)
  create-admin.ts           Bootstrap admin via Supabase Admin API
  check-trigger.ts          Diagnosi schema/trigger live (read-only)
  test-trigger.ts           Test E2E trigger handle_new_user
  test-dashboard.ts         Perf regression dashboard.getStats
  dump-data.ts              Dump SQL data-only per disaster recovery

backups/                    Output dump (gitignored, contiene PII)
  .gitignore                Ignora tutto tranne se stesso

shared/                     Costanti/tipi condivisi front+back
```

---

## Run locale

```bash
pnpm install
pnpm dev          # tsx watch su server/_core/index.ts (Express + Vite middleware)
                  # apre su http://localhost:<dynamic-port>
```

Richiede `.env.local` con `DATABASE_URL`, `SUPABASE_URL`,
`SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `OWNER_EMAIL`,
`FATTUREINCLOUD_*` (opzionali). Vedi `.env.example`.

```bash
pnpm exec tsc --noEmit    # typecheck
pnpm build                # vite build (frontend) + esbuild (api/index.js)
pnpm exec tsx scripts/test-trigger.ts   # smoke test trigger
pnpm exec tsx scripts/test-dashboard.ts # smoke test perf dashboard
pnpm exec tsx scripts/dump-data.ts      # backup data → backups/
```

---

## Deploy

Vercel auto-deploy su push a `main`. Il build chain:
```
pnpm build = vite build && esbuild vercel-handler/index.ts → api/index.js
```

Vercel valida `vercel.json` `functions: api/index.js` PRE-build (file
deve esistere in git checkout, vedi tech debt). Poi runa `pnpm build`,
poi raccoglie le functions.

```bash
# Vedere stato deploy
pnpm dlx vercel ls gestionalesoketo

# Build logs di un deploy specifico
pnpm dlx vercel inspect <deployment-url> --logs
```

Production alias: `gestionale.soketo.it` (CNAME via Cloudflare → Vercel).

---

## ⚠️ REGOLA CRITICA: Migration-First Deploy

**MAI pushare codice che usa nuove colonne/tabelle senza prima
confermare che la migration sia stata applicata su Supabase.**

Ordine corretto:
1. Preparare file migration SQL (`drizzle/NNNN_*.sql`)
2. Notificare utente con il SQL integrale → utente applica via SQL Editor
3. **Attendere conferma esplicita** dall'utente che la migration è OK
4. SOLO DOPO conferma, pushare il codice che usa le nuove colonne

Motivazione: Vercel auto-deploya su push a `main`. Se il codice
usa colonne che non esistono ancora in DB, il sito va in errore
immediatamente in produzione (es. bug M5.8 del 2026-05-15).

Eccezione: se le nuove colonne hanno DEFAULT e il codice le usa
solo in INSERT (non SELECT/WHERE), il push può essere simultaneo
perché i SELECT esistenti non si rompono. Ma per sicurezza,
preferire sempre l'ordine migration-first.

---

## Environment variables (Vercel production)

| Var | Scope | Note |
|---|---|---|
| `DATABASE_URL` | server | Pooler Supavisor `aws-1-eu-central-1.pooler.supabase.com:6543` (transaction mode) |
| `SUPABASE_URL` | server + `VITE_SUPABASE_URL` per frontend | |
| `SUPABASE_ANON_KEY` | server + `VITE_SUPABASE_ANON_KEY` per frontend | |
| `SUPABASE_SERVICE_ROLE_KEY` | server only | Mai esposto al client |
| `SUPABASE_JWT_SECRET` | server | ⚠️ deprecato (verifica JWT via JWKS), lasciato come safety net |
| `OWNER_EMAIL` | server | Admin owner per script create-admin |
| `FATTUREINCLOUD_*` | server | Per integrazione FIC (parziale, refactor Phase B) |

Disaster recovery DB:
1. Crea nuovo progetto Supabase (regione `eu-central-1`)
2. Apply migrations: `pnpm exec drizzle-kit migrate`
3. Apply data dump: `psql $DATABASE_URL < backups/migration-final-YYYY-MM-DD.sql`
4. Aggiorna env vars Vercel
5. Bootstrap admin: `pnpm exec tsx scripts/create-admin.ts info@soketo.it`

---

## Tech debt corrente

- `api/index.js` 3.2MB tracked in git (workaround Vercel pre-build
  pattern check). Vedi `MIGRATION_LOG.md` sezione "Step 2 ❌".
- `SUPABASE_JWT_SECRET` ancora in env vars Vercel ma non usata in
  codice. Da rimuovere dopo settimane di stabilità.
- Tab Movimenti Stock UI disabilitata in attesa Phase B (sistema
  lotti FEFO).
- Integrazione FIC è per-retailer ma deve essere single-tenant.
  Refactor pianificato in Phase B.

---

## Roadmap Phase B (2–6 settimane, priorità alta)

Visione operativa completa — blocking per uso reale del sistema
(E-Keto Food deve gestire scadenze lotti per regole alimentari).

Modello dominio:
```
produttori → magazzino centrale SoKeto → retailer → cliente finale
```

Entità da implementare:
- `producers` — anagrafica produttori
- `productBatches` — lotti per prodotto con scadenza
- `inventory` ridisegnata: `(location, batch, quantity)` dove
  `location = 'soketo_warehouse' | retailer_id`
- Movements estesi: `IN`, `TRANSFER` (warehouse → retailer),
  `RETAIL_OUT` (retailer → cliente finale, importato dal gestionale
  retailer)
- Suggerimento FEFO automatico su distribuzione
- Integrazioni multi-provider gestionali retailer (FIC + Mago +
  TeamSystem + Danea + ...) con architettura plug-in
- Architettura FiC single-tenant: tabella `system_integrations`
  (singleton FIC SoKeto) + `retailer.fic_client_id` per fatturazione

Vedi `MIGRATION_LOG.md` sezione "🛣️ FASE B" per piano completo.

---

## Comandi utili

```bash
# Dev
pnpm dev
pnpm exec tsc --noEmit
pnpm build

# Test
pnpm exec tsx scripts/test-trigger.ts
pnpm exec tsx scripts/test-dashboard.ts
pnpm exec tsx scripts/check-trigger.ts

# Backup
pnpm exec tsx scripts/dump-data.ts

# Vercel
pnpm dlx vercel ls gestionalesoketo
pnpm dlx vercel inspect <url> --logs

# DB schema (Drizzle)
pnpm exec drizzle-kit generate    # genera migration da schema.ts
pnpm exec drizzle-kit migrate     # applica migration
```

---

## Riferimenti

- Codice: https://github.com/portalidea/gestionalesoketo
- Production: https://gestionale.soketo.it
- Vercel: https://vercel.com/soketo-s-projects/gestionalesoketo
- Supabase: https://supabase.com/dashboard/project/aejwoytoskihmtlgtfaz
- Resend: https://resend.com (dominio sm.soketo.it)
- Tag git stato attuale: `v1.0-post-migration`
- Storia migrazione: [`MIGRATION_LOG.md`](./MIGRATION_LOG.md)
