# Database isolato — stub migration e suite Vitest legacy

Questo documento descrive esclusivamente i prerequisiti aggiunti da
`scripts/test-db/local-postgres.sh` per permettere il replay locale delle migration.
Gli stub sono applicati solo al database PostgreSQL locale sulla porta `55432`.

## Stub e prerequisiti

| Punto del bootstrap | Perché serve | Contenuto locale aggiunto | Impatto su tabelle magazzino/ordini |
|---|---|---|---|
| `auth` Supabase | Le migration di auth richiedono lo schema e la tabella Supabase. | Schema `auth`, tabella minima `auth.users(id, email, raw_user_meta_data)`, funzione `auth.uid()` e ruolo `authenticated`. | **Nessuno**: non modifica né sostituisce `orders`, `orderItems`, `inventoryByBatch` o `stockMovements`. |
| Prima di `drizzle/0009_product_supplier_codes.sql` | La migration aggiunge ruoli retailer a un enum che nel bootstrap storico non li contiene. | `ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'retailer_admin'` e `'retailer_user'`. | **Nessuno**. |
| Prima di `drizzle/migrations/0020_fic_connections_per_company.sql` | La definizione storica di `ficConnections` non è presente nel repository, mentre la migration la modifica. | Tabella minima fedele allo schema corrente `ficConnections` con FK a `companies`, token e timestamp. | **Nessuno**: riguarda esclusivamente la connessione Fatture in Cloud. |

Tutte le migration repository elencate nello script sono quindi eseguite; non viene stubbata né sostituita alcuna migration che definisce o altera `orders`, `orderItems`, `inventoryByBatch` o `stockMovements`.

## Suite Vitest con mock Supabase locale

Le tre suite sotto vengono caricate con variabili Supabase fittizie locali (`http://127.0.0.1:54321`, chiavi mock), senza contattare servizi esterni:

| Suite | Stato | Copertura dichiarata | Nota |
|---|---|---|---|
| `server/auth.logout.test.ts` | 1 test skipped | Logout legacy | La procedura `auth.logout` non esiste più dopo Supabase Auth client-side. Non tocca ordini o magazzino. |
| `server/retailer-details.test.ts` | 3 test skipped | Dettaglio retailer, inventario e movimenti | Test legacy incompatibile con UUID/Supabase e con procedure M1 rimosse; la copertura attiva su magazzino è fornita dalla suite isolata `test-hotfix-reversal.ts`. |
| `server/routers.test.ts` | 8 test skipped | Dashboard, retailer, prodotti, alert e auth legacy | Test legacy incompatibile con UUID/Supabase e procedure rimosse. Non contiene flussi ordine o storno. |

L’hotfix è coperto attivamente da `server/services/orderTransferReversal.test.ts` (5 test unitari) e da `scripts/test-hotfix-reversal.ts` (6 scenari di integrazione PostgreSQL isolato).
