# Evidenze test hotfix storno — database isolato

La suite è stata eseguita su PostgreSQL locale isolato, inizializzato da migration e fixture versionate. Nessun dato Supabase o di produzione è stato utilizzato o modificato.

| Test | Esito | Evidenza rilevata |
|---|---|---|
| T1 — giacenza retailer intatta | PASS | Prima: 30 pezzi retailer e 90 centrale. Dopo: 0 retailer e 120 centrale; un `TRANSFER` inverso con riferimento strutturato all’ordine. |
| T2 — giacenza retailer insufficiente | PASS | Prima: 11 disponibili su 30 richiesti. Dopo: 0 retailer e 101 centrale; storno di 11 e discrepanza di 19 registrata in `notesInternal`. |
| T3 — doppio annullamento consecutivo | PASS | Il primo annullamento ripristina 12 pezzi; il secondo trova l’ordine già annullato e non crea un secondo movimento. |
| T4 — annullamenti concorrenti | PASS | Due richieste simultanee vengono serializzate dal lock `FOR UPDATE`; una sola vede `transferring` e crea lo storno. |
| T5 — ordine inter-company | PASS | Lo storno standard riporta 18 pezzi dalla location retailer al centrale E-Keto; dopo aver ridotto SoKeto a 7 pezzi, M11.D rimuove solo 7 e registra 11 mancanti. Nessuna riga `inventoryByBatch` va negativa o viene stornata due volte. |
| T6 — giacenza preesistente | PASS | Il retailer parte da 50 pezzi, riceve 30 e passa a 80; l’annullamento ne storna 30 e lo riporta a 50, con centrale 40→70. |

## Verifiche aggiuntive

- `npx tsc --noEmit`: **PASS**.
- `server/services/orderTransferReversal.test.ts`: **5/5 PASS**.
- `scripts/test-hotfix-reversal.ts`: **6/6 PASS** in PostgreSQL isolato.
- Le righe `stockMovements` complete (tutti i campi) di T1, T2 e T6 sono disponibili in `test-evidence/hotfix-reversal-evidence.json`, nei rispettivi oggetti `after.rawMovements`.
- Per gli stub migration e le suite legacy Supabase, vedi `LOCAL_TEST_DATABASE_STUBS.md`.

Le cinque evidenze sono disponibili sia nel report JSON/HTML runtime sia nelle schermate catturate durante la suite isolata.
