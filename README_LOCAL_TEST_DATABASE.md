# Database PostgreSQL locale per test magazzino e M13

Questo ambiente è **interamente isolato** dal database Supabase di produzione. Serve a testare le regole che modificano inventario, movimenti, lotti, annullamenti e, in futuro, gli alert M13. I dati runtime sono salvati in `.local-test-postgres/`, già esclusa da Git.

## Struttura versionata

| Percorso | Funzione |
|---|---|
| `scripts/test-db/local-postgres.sh` | Avvio, reset, stop e URL del PostgreSQL nativo locale. |
| `scripts/seed-hotfix-m13.ts` | Seed idempotente con fixture magazzino, trasferimenti e lotti M13. |
| `scripts/test-hotfix-reversal.ts` | Sei test d’integrazione dell’hotfix di storno, con evidenze prima/dopo. |
| `scripts/test-db/verify-m13-rls.sql` | Prova RLS M13 con un ruolo locale `NOBYPASSRLS`, separata dal replay. |
| `scripts/test-db/verify-m13-company-scoping.sql` | Verifica l’unicità cron per company e la notifica interna esplicita. |
| `scripts/test-m13-run-recovery.ts` | Verifica il recupero di un run cron bloccato senza toccare altre company o finestre. |
| `reports/test-evidence/` | Output runtime JSON/HTML dei test; non viene versionato. |

## Prerequisiti

Sono richiesti Node/pnpm già presenti nel progetto e PostgreSQL nativo con `initdb`, `pg_ctl`, `psql` e `pg_config` disponibili nel `PATH`.

Su Ubuntu/Debian:

```bash
sudo apt-get update
sudo apt-get install postgresql postgresql-client
```

## Avvio da zero

Il reset crea un cluster locale su `127.0.0.1:55432`, ricrea il database `gestionalesoketo_test`, applica nell’ordine tutte le migration SQL presenti nel repository e genera `.local-test-postgres/env.sh`.

```bash
pnpm testdb:reset
source .local-test-postgres/env.sh
pnpm testdb:seed
```

Il seed è idempotente: può essere eseguito più volte. Per ripartire da una base completamente pulita è preferibile ripetere `pnpm testdb:reset` prima del seed.

## Fixture incluse

Il seed crea una company origine E-Keto di test, una company SoKeto di test, un magazzino centrale per ciascuna, un rivenditore normale e il retailer inter-company SoKeto. Inserisce inoltre due prodotti e tre lotti.

| Lotto fixture | Prodotto | `piecesPerUnit` | Scadenza | Uso |
|---|---|---:|---|---|
| `TEST-SCAD-NEXT-MONTH` | Prodotto confezione | 6 | Tra circa 30 giorni | Alert M13 e transfer standard/inter-company. |
| `TEST-SCAD-FOUR-MONTHS` | Prodotto confezione | 6 | Tra circa 4 mesi | Giacenza parzialmente disponibile. |
| `TEST-SCAD-EXPIRED` | Prodotto pezzo singolo | 1 | Già scaduto | Storno e casi M13 di merce scaduta. |

Sono inoltre creati sei ordini `TEST-REV-001`…`TEST-REV-006`, ciascuno destinato a uno scenario di storno. La location del rivenditore normale parte con 50 pezzi preesistenti del lotto `TEST-SCAD-NEXT-MONTH`, usati da T6.

## Esecuzione test hotfix storno

```bash
source .local-test-postgres/env.sh
pnpm testdb:reversal
```

La suite reinizializza il seed prima di ogni scenario e verifica:

1. annullamento di transfer con giacenza retailer intatta;
2. storno parziale quando la giacenza retailer è già ridotta;
3. doppio annullamento consecutivo idempotente;
4. due annullamenti concorrenti, serializzati dal lock ordine;
5. ordine inter-company senza doppio storno tra stock standard e M11.D, incluso storno parziale anti-negativo su SoKeto;
6. storno di un nuovo transfer di 30 pezzi con 50 pezzi preesistenti presso il retailer: la quantità deve tornare da 80 a 50, non a zero.

Le evidenze sono generate in:

```text
reports/test-evidence/hotfix-reversal-evidence.json
reports/test-evidence/hotfix-reversal-evidence.html
```

Per visualizzare l’HTML localmente, aprire `reports/test-evidence/hotfix-reversal-evidence.html` nel browser.

## Verifiche M13: RLS, company e run bloccati

```bash
pnpm testdb:reset
source .local-test-postgres/env.sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/test-db/verify-m13-rls.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/test-db/verify-m13-company-scoping.sql
pnpm testdb:m13-recovery
```

> Il replay usa volutamente `postgresql://postgres@…`: il ruolo locale `postgres` ha sia `rolsuper=true` sia `rolbypassrls=true`. Il replay della migration **non dimostra quindi da solo** il comportamento RLS di un ruolo applicativo ristretto. La prova separata `verify-m13-rls.sql` crea un ruolo `NOBYPASSRLS`, concede i privilegi SQL minimi e conferma che RLS senza policy ne blocca la scrittura. L’architettura di produzione è stata verificata separatamente: il backend Drizzle usa il ruolo `postgres` con `BYPASSRLS=true`.

## Gestione del runtime locale

```bash
pnpm testdb:start   # avvia il cluster locale senza reset
pnpm testdb:stop    # arresta il cluster
pnpm testdb:url     # stampa l’URL del database locale
```

> Non usare questi script contro produzione. Il workflow operativo su Supabase resta migration manuale nel SQL Editor; il database locale serve esclusivamente a test ripetibili e non usa credenziali Supabase.
