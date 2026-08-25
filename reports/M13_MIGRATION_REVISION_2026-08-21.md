# Revisione M13 — company scope, notifiche interne e recupero run

**Stato:** migration rigenerata localmente; **non applicata in Supabase**.

## Correzioni incluse in `0028_m13_expiry_alerts.sql`

| Area | Correzione |
|---|---|
| Run M13 | `expiry_alert_runs.company_id uuid NOT NULL REFERENCES companies(id)` |
| Unicità cron | Indice parziale su `(company_id, period_start, period_end)` per run cron non falliti |
| Notifiche interne | `is_internal boolean NOT NULL DEFAULT false` |
| Cancellazione retailer | `retailer_id` usa `ON DELETE SET NULL` |
| Unicità internal | Un solo record per run quando `is_internal = true` |
| Coerenza interna | Un `CHECK` impone che una notifica interna non referenzi un retailer |

## Recupero dei run bloccati

La routine `server/services/expiryAlertRunRecovery.ts` è predisposta per l'avvio del futuro job M13. Aggiorna a `failed` soltanto i run con tutti i seguenti criteri: stessa `company_id`, stessa finestra, `trigger='cron'`, `status='running'` e `created_at` precedente di oltre due ore al momento di avvio. Il messaggio di errore registra company e finestra.

Al momento non esiste ancora un job M13 in produzione: il job e tutte le query di selezione scadenze saranno introdotti solo dopo l'applicazione manuale della migration. Non esistono quindi query M13 già implementate da auditare. La routine di recupero già implementata è filtrata obbligatoriamente per `company_id`, `period_start` e `period_end`; il futuro job riceverà `companyId` obbligatorio per ogni company elaborata.

## Verifiche eseguite nel database isolato

| Verifica | Esito |
|---|---|
| Replay completo della migration aggiornata | PASS |
| Ruolo del replay (`postgres`) | `rolsuper=true`, `rolbypassrls=true` |
| RLS senza policy tramite ruolo `NOBYPASSRLS` | PASS: INSERT bloccato |
| Due company, stessa finestra cron | PASS: entrambe ammesse |
| Duplicato cron, stessa company e finestra | PASS: bloccato dall'indice unico |
| Doppia notifica `is_internal=true` nello stesso run | PASS: bloccata dall'indice unico |
| Recupero stale run | PASS: aggiorna solo la company/finestra scaduta; preserva run recenti, altra company e altra finestra |
| TypeScript | PASS (`pnpm check`) |
| Vitest completo con variabili fittizie | 20 test passati, 12 test legacy intenzionalmente skipped; nessuna connessione Supabase |

> Il replay locale da solo non prova il comportamento RLS di un ruolo limitato, poiché usa il superuser `postgres`. Tale limite è coperto dalla verifica separata `scripts/test-db/verify-m13-rls.sql`, eseguita con il ruolo `m13_local_non_bypass` e conclusa con il blocco della scrittura atteso.

## Nessuna azione di produzione

Nessuna query di modifica è stata eseguita su Supabase e nessuna variabile Vercel è stata cambiata. L'applicazione della migration resta manuale nel SQL Editor.
