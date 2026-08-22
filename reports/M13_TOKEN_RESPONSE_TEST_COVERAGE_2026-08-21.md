# Copertura test risposta token M13 — database isolato

L'esecuzione è avvenuta unicamente sul worktree temporaneo del commit M13 ritirato e sul PostgreSQL locale. La produzione, Supabase e Resend non sono stati contattati.

| Scenario richiesto | Esito | Evidenza grezza |
|---|---|---|
| Quantità email con `piecesPerUnit` 6 e 1 | PASS | Corpo text/plain: `8 confezioni + 2 pz (50 pz)` e `3 pz` |
| `sold_out` | PASS | `inventoryByBatch.quantity` 50 → 0; un ADJUSTMENT con `sourceDocumentType=m13_retailer_declaration`; `adjustment_applied=true` |
| `has_stock` con `piecesPerUnit=6` | PASS | Dichiarate 7 confezioni → 42 pezzi; stock 50 → 42; ADJUSTMENT -8 |
| `has_stock` con `piecesPerUnit=1` | Superato nella versione iniziale; poi corretto | Il caso `3 → 7` ha rivelato un carico improprio da dichiarazione pubblica ed è stato sostituito dalla regola anomalia non rettificante |
| Dichiarazione superiore allo snapshot | PASS dopo 0029 | Snapshot e stock 3, dichiarati 7; stock invariato 3, zero movimenti, `adjustment_applied=false`, `declaration_anomaly=true` sull'item, `response_type=has_stock` |
| Doppia submit | PASS | Prima rettifica 50 → 0; secondo submit rifiutato con `Risposta già registrata`; un solo movimento |
| Token scaduto | PASS | Errore `Link scaduto`; stock 50 → 50; zero movimenti |

## Correzioni necessarie emerse prima della prova

La prima esecuzione ha evidenziato tre difetti del codice M13 ritirato: cast UUID su una colonna `response_token` testuale, `sourceDocumentType` non conforme e input token espresso in pezzi. Le modifiche sono confinate al worktree e non sono state commitate né pubblicate:

1. Il confronto del token è ora testuale.
2. Il movimento usa `m13_retailer_declaration`.
3. L'input utente è in confezioni e la procedura converte in pezzi tramite `piecesPerUnit`.
4. Le dichiarazioni superiori allo snapshot non possono caricare giacenza: vengono registrate come anomalia amministrativa senza movimento. I movimenti ammessi indicano esplicitamente che l'origine è una dichiarazione esterna non autenticata.

## Ripetizione con migration 0029

La seconda esecuzione ha riprodotto il database locale includendo `0029_m13_item_declaration_anomaly.sql`.

| Requisito aggiuntivo | Esito |
|---|---|
| Flag anomalia per-item | PASS: `expiry_alert_items.declaration_anomaly=true` solo sull'item superiore allo snapshot |
| Risposta con item normali e anomali | PASS: l'item normale è rettificato; l'item anomalo resta invariato |
| Dominio notification | PASS: `response_type` resta `has_stock`, senza valore tecnico di anomalia |
| Movimento M13 | PASS: `retailerId` valorizzato; `fromLocationId=NULL`; `toLocationId=NULL` |

L'evidenza completa, inclusi tutti i campi delle righe `inventoryByBatch` e `stockMovements` prima/dopo, è conservata nel log raw dell'esecuzione riuscita.
