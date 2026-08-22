# Istruzioni per il merge futuro di M13 su `main`

## Stato di partenza da preservare

Il branch da integrare è `feature/m13-expiry-alerts-safe`, attualmente al commit `453505c`. Il branch `main` è rimasto al rollback `fe495f2`; il tentativo di merge del 22 agosto 2026 ha quindi incontrato conflitti attesi, soprattutto **modify/delete**: il rollback aveva cancellato file M13 che il branch ripristina e modifica.

Le migration **0028, 0029 e 0030 sono già applicate manualmente su Supabase produzione**. Non devono essere riapplicate né alterate durante il merge.

> Il merge va eseguito solo in un worktree pulito. Non usare il worktree `main` se contiene report o TODO locali non versionati.

## Preparazione del worktree pulito

```bash
git -C /tmp/gestionalesoketo fetch origin
git -C /tmp/gestionalesoketo worktree add --detach /tmp/gestionalesoketo-main-merge origin/main
cd /tmp/gestionalesoketo-main-merge
git status --short                 # deve essere vuoto
git merge --no-ff --no-commit origin/feature/m13-expiry-alerts-safe
```

Non effettuare alcun push prima che tutte le verifiche riportate sotto abbiano successo.

## Risoluzione dei conflitti

Per i conflitti M13 e per `todo.md`, mantenere la versione del branch:

```bash
git diff --name-only --diff-filter=U | xargs -r -d '\n' git checkout --theirs --
git add -A
git diff --name-only --diff-filter=U  # deve non produrre output
git diff --cached --check             # deve non produrre output
```

Nel merge `--no-ff`, `--theirs` è `origin/feature/m13-expiry-alerts-safe`. I conflitti attesi includono almeno i seguenti file:

| Area | File da mantenere dal branch M13 |
|---|---|
| Pagine | `client/src/pages/ExpiryAlerts.tsx`, `client/src/pages/ExpiryResponse.tsx` |
| Schema e migration | `drizzle/schema.ts`, `drizzle/migrations/0029_m13_item_declaration_anomaly.sql`, `drizzle/migrations/0030_m13_reorder_suppression.sql` |
| Entrypoint e cron | `server/_core/index.ts`, `server/cron-alerts.ts` |
| Router e webhook | `server/expiry-alert-router.ts`, `server/resend-webhook-routes.ts`, `server/routers.ts` |
| Servizi M13 | `server/services/expiryAlertService.ts`, `server/services/m13EmailDelivery.ts`, `server/services/emailLogService.ts`, `server/services/expiryAlertRunRecovery.ts` |
| Test e seed | `scripts/seed-hotfix-m13.ts`, `scripts/test-db/local-postgres.sh`, `scripts/test-m13-t1-t10.ts`, `scripts/test-m13-token-responses.ts`, `scripts/test-m13-reorder-suppression.ts`, `server/services/m13EmailDelivery.test.ts` |
| Infrastruttura | `shared/const.ts`, `todo.md`, `reports/` M13, `MERGE_M13_ISTRUZIONI.md` |

### File M13 che potrebbero essere cancellati automaticamente senza conflitto

Il rollback su `main` può far prevalere una cancellazione quando un file non ha modifiche successive rispetto al merge-base. Verificare esplicitamente la presenza e, se assente, recuperare dal branch:

```bash
git checkout origin/feature/m13-expiry-alerts-safe -- \
  server/services/emailLogService.ts \
  server/services/expiryAlertRunRecovery.ts \
  server/services/m13EmailDelivery.ts \
  server/services/m13EmailDelivery.test.ts \
  server/expiry-alert-router.ts \
  server/resend-webhook-routes.ts \
  server/services/expiryAlertService.ts
git add -A
```

## `package.json`, lockfile e dipendenza `svix`

`server/resend-webhook-routes.ts` importa `Webhook` da `svix`. Il merge che ha fallito non aveva la dipendenza disponibile, causando `Cannot find module 'svix'` durante `pnpm check`.

Nel worktree del merge, assicurarsi che `package.json` contenga nelle `dependencies`:

```json
"svix": "^2.0.0"
```

La modalità meno invasiva è aggiungere o riallineare la dipendenza nel worktree di merge e lasciare che pnpm aggiorni il lockfile:

```bash
pnpm add svix@^2.0.0
pnpm install --frozen-lockfile
```

Se `pnpm add` modifica `package.json` o `pnpm-lock.yaml`, verificare che il diff riguardi soltanto `svix` e le sue dipendenze transitive. Non sostituire indiscriminatamente l'intero `package.json` con la versione del branch se `main` ha dipendenze estranee più recenti.

## Registrazione del router `expiryAlerts`

Il client usa `trpc.expiryAlerts.*`. Il router radice deve quindi importare e registrare il router M13 esattamente così in `server/routers.ts`:

```ts
import { expiryAlertsRouter } from "./expiry-alert-router";
```

e dentro `appRouter`:

```ts
expiryAlerts: expiryAlertsRouter,
```

Verificare anche che `client/src/App.tsx` mantenga le rotte amministrativa e pubblica M13. Se un file del router radice non è in conflitto ma proviene dal rollback, riprendere solo le due integrazioni sopra dal branch, senza sovrascrivere le altre registrazioni di router presenti su `main`.

## Webhook e middleware HTTP

`server/_core/index.ts` deve mantenere il body raw **solo** sulla rotta esatta:

```ts
app.post("/api/webhooks/resend", express.raw({ type: "application/json" }), resendWebhookHandler);
```

Non montare mai `express.raw()` globalmente su `/api`: causerebbe di nuovo la regressione tRPC. Il webhook non abilita invii; gestisce soltanto eventuali eventi di provider per email già inviate.

## Verifiche obbligatorie, nell'ordine indicato

1. Installare dipendenze nel worktree di merge: `pnpm install --frozen-lockfile`.
2. Controllare che non restino marker di merge: `git diff --check` e `git diff --name-only --diff-filter=U` senza output.
3. Eseguire `pnpm check`. Se fallisce, **annullare il merge** con `git merge --abort`; non effettuare commit o push.
4. Ripristinare il database locale isolato: `pnpm testdb:reset`.
5. Eseguire le suite M13 locali con `LOCAL_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55432/gestionalesoketo_test?sslmode=disable`:
   - `pnpm tsx scripts/test-hotfix-reversal.ts`
   - `pnpm tsx scripts/test-m13-reorder-suppression.ts`
   - `pnpm tsx scripts/test-m13-token-responses.ts`
   - `pnpm tsx scripts/test-m13-t1-t10.ts`
   - `pnpm vitest run server/services/m13EmailDelivery.test.ts`
6. Eseguire il runner generale con endpoint Supabase fittizi solo per gli import dei test, senza contattare servizi esterni:

```bash
DATABASE_URL='postgresql://postgres@127.0.0.1:55432/gestionalesoketo_test?sslmode=disable' \
SUPABASE_URL='http://127.0.0.1:65432' \
SUPABASE_ANON_KEY='test-anon-key' \
SUPABASE_SERVICE_ROLE_KEY='test-service-role-key' \
pnpm test
```

Alcune suite di integrazione possono risultare esplicitamente `skipped` in questo assetto; non devono esserci test `failed`.

## Commit, push e verifica deploy

Solo dopo le verifiche verdi:

```bash
git commit -m "merge: M13 alert-only reorder suppression"
git push origin HEAD:main
```

Attendere il completamento del deploy di produzione. Prima di qualunque eventuale dry-run, verificare che `auth.me` e `expiryAlerts.getSettings` rispondano dal backend del deploy effettivo.

## Protezioni che devono restare in vigore dopo il merge

| Protezione | Stato richiesto |
|---|---|
| Cron M13 | Non attivare un invio automatico finché non viene approvato esplicitamente. |
| Invio reale | Bloccato salvo `M13_EMAIL_DELIVERY_ENABLED === 'true'` esatto. |
| Dry-run | Nessun dry-run senza autorizzazione distinta; non crea `email_log`, movimenti o modifiche `inventoryByBatch`. |
| Database produzione | Migration 0028, 0029 e 0030 già applicate; non riapplicarle. |
| M11.D | Processo di carico SoKeto attualmente manuale: non correggere/attivare l'automatismo senza una decisione operativa separata. |
