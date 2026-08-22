# M13 — Validazione locale della soppressione per riordino

## Stato di lavoro

Le modifiche vivono esclusivamente nel worktree locale del branch `feature/m13-expiry-alerts-safe`. Non è stato eseguito alcun push, merge, deploy, dry-run su Supabase, invio Resend o accesso al database di produzione. Il branch remoto e il worktree non sono ancora allineati perché le modifiche qui descritte sono non committate.

## Comportamento implementato

Il dispatcher M13 calcola per ogni coppia **location del rivenditore + prodotto** l'ultimo trasferimento di ogni lotto tramite `MAX(stockMovements.timestamp)`, considerando tutti i movimenti `TRANSFER` che hanno quel lotto e quella destinazione. La query non filtra `sourceDocumentType`, così include anche i trasferimenti storici in cui il campo è nullo.

Un lotto con giacenza positiva è soppresso soltanto quando la sua ultima consegna è antecedente a `D_max - reorder_tolerance_days`, dove `D_max` è la consegna più recente del prodotto/location. La tolleranza predefinita è 7 giorni e può essere aggiornata per company. La soppressione non modifica `inventoryByBatch` né `stockMovements`: salva invece uno snapshot in `expiry_alert_suppressions` con rivenditore, prodotto, lotti vecchio/nuovo, date delle consegne e tolleranza applicata.

Le selezioni M13 escludono la location inter-company tramite l'UUID temporaneo concordato e applicano il filtro PEC ristretto nella selezione comune. Le procedure tRPC e il cron non offrono più un avvio alignment: il cron, se verrà esplicitamente abilitato in futuro, calcolerà soltanto la modalità `alert` in dry-run. L'invio reale resta bloccato senza `M13_EMAIL_DELIVERY_ENABLED === 'true'`.

La classificazione **PEC ha precedenza sulla soppressione per riordino**. Se un indirizzo è PEC, i suoi lotti della finestra restano visibili nel run come `skipped` / `pec_address`, anche quando la data di consegna li renderebbe altrimenti sopprimibili. Non viene creato per loro uno snapshot che mascheri il problema anagrafico nella sola lista delle soppressioni.

La pagina token non chiede più quantità. Per ciascun lotto mostra solo il pulsante volontario **Segnala esaurito**; l'azione idempotente azzera il lotto specifico e registra un ADJUSTMENT soltanto su quella segnalazione esplicita. Non è coinvolta nella selezione/soppressione da riordino.

## Migration manuale necessaria

Prima di usare queste modifiche in un ambiente che non contiene già lo schema 0030, occorre applicare manualmente `drizzle/migrations/0030_m13_reorder_suppression.sql`. La migration:

| Oggetto | Scopo |
|---|---|
| `expiry_alert_settings.reorder_tolerance_days` | Tolleranza per company, `7` di default, vincolo `0–90` |
| `expiry_alert_suppressions` | Snapshot verificabile dei lotti soppressi |
| Indici su run e retailer/prodotto | Consultazione report per run |
| RLS abilitata | Coerenza con le altre tabelle M13; accesso applicativo solo server-side |

Non applicare la migration finché non si decide di procedere al deploy del branch. Non sono state eseguite DDL o DML su Supabase.

## Validazione locale eseguita

Il database PostgreSQL locale è stato resettato includendo la migration 0030. Il typecheck `pnpm check` ha completato senza errori. Il log grezzo completo è `terminal_full_output/m13_alert_only_clean_validation_2026-08-22.log`.

| Verifica | Esito effettivo |
|---|---|
| Lotto A marzo/scadenza settembre, lotto B giugno/scadenza dicembre | PASS: A non entra nell'alert, snapshot A→B presente |
| Lotto singolo in scadenza senza riordino | PASS: incluso nell'alert |
| Due lotti dello stesso prodotto consegnati a tre giorni | PASS: entrambi correnti con tolleranza 7 giorni |
| Prodotti diversi | PASS: il riordino di un prodotto non influenza l'altro |
| Invarianti della soppressione | PASS: `inventoryByBatch` e `stockMovements` invariati; `email_log = 0`; movimenti M13 = 0 |
| Token solo esaurito | PASS: azzeramento del solo lotto segnalato, doppia submit idempotente, token scaduto bloccato |
| Sicurezze M13 esistenti | PASS: company scope, inter-company escluso, opt-out, PEC skipped, recovery stale cron, nessun `email_log` da dry-run, idempotenza finestra |
| Gateway email | PASS: 3 test Vitest, default disabilitato e attivabile solo con valore esatto `true` |

## Query SQL read-only

Il file `reports/M13_SEPTEMBER_REORDER_SUPPRESSION_READONLY.sql` contiene due query solo `SELECT`, impostate su settembre 2026 e tolleranza 7 giorni:

1. **Query 0 — copertura TRANSFER**: confronto, per company e separando la relazione inter-company temporanea, fra lotti con giacenza positiva sulle location retailer e lotti con almeno un `TRANSFER` con `batchId` e `toLocationId` corrispondenti. Restituisce conteggi, pezzi e percentuale di copertura. Va eseguita nel SQL Editor per ottenere i valori reali.
2. Dettaglio di ogni lotto in scadenza con `D_max`, ultimo trasferimento, decisione `alert_candidate`, `suppressed_by_reorder` o `skipped_pec_address`.
3. Riepilogo per rivenditore con lotti, pezzi e confezioni equivalenti candidati/soppressi/PEC.

Entrambe escludono la relazione inter-company temporanea, riconoscono le PEC con il set ristretto concordato e non filtrano `sourceDocumentType` nella ricerca delle consegne storiche.

## Fonti storiche alternative censite, non implementate

| Fonte | Dati presenti | Utilizzabilità per ricostruire una consegna lotto-location |
|---|---|---|
| `stockMovements` `TRANSFER` | Timestamp, `batchId`, `toLocationId`, company e quantità | Fonte primaria e deterministica. |
| `orders` + `orderItems` | Rivenditore, `batchId`, quantità, stati e timestamp `transferringAt` / `shippedAt` / `deliveredAt` | Fallback approssimato possibile solo per righe con lotto, ordine non annullato e un timestamp logistico coerente; non registra esplicitamente la location e non prova che il TRANSFER sia stato materializzato. |
| `ddt_imports` + `ddt_import_items` | DDT, data, lotto estratto, prodotto e lotto creato | Non adatta ai trasferimenti verso retailer: il modello registra import da produttore e non contiene `retailerId` né `locationId` di destinazione. |
| `sourceDocumentType='order_transfer'` | Collegamento movimento-ordine | Utile solo per i trasferimenti creati dopo l'hotfix; gli storici possono avere il campo nullo e quindi non risolve la copertura pregressa. |

## Stato Git

`main` non è stato toccato e rimane al rollback `fe495f2`. Il remoto del branch è ancora al commit `e99c588`; tutte le modifiche della nuova specifica vivono localmente e non sono né committate né pushate. Un eventuale commit e push sul branch richiede una nuova autorizzazione esplicita dell'utente.
