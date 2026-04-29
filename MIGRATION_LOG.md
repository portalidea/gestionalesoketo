# MIGRATION_LOG.md — Diario di migrazione Manus → Supabase + Vercel

> Diario cronologico inverso (più recente in alto). Per ogni step:
> data, esito, problemi incontrati, soluzioni adottate, link a commit.

Branch di lavoro: `migration/manus-to-supabase`.
Riferimento piano: `MIGRATION_PLAN.md`.

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
