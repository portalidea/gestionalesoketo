# SoKeto — import giornaliero Amazon: implementazione locale

Branch: `feature/amazon-daily-order-import`, base `bd09d37` (main del 5 novembre 2026). Nessun push, merge o deploy. Nessuna scrittura in produzione. Scenario Make non modificato né attivato.

## Implementato

I quattro endpoint `/api/marketplace/amazon/import-window`, `/report-created`, `/report-file`, `/report-status` sono montati sia nell'handler Vercel sia nel server Node. La route raw precede il parser JSON generale. Richiedono un segreto dedicato di almeno 32 caratteri e lo store configurato esclusivamente lato server; company E-Keto verificata per ID, non per nome.

Report originale TSV/CSV con intestazioni, BOM e GZIP supportati. Limiti: 4 MiB body HTTP, 8 MiB decompressione, 2.000 righe per report. Nessun dato cliente superfluo. Un documento con struttura/date invalide non produce scritture; valori di riga non validi o identità mancanti vengono isolati nell'audit di revisione. Non viene inventato un ID articolo.

Cutoff sulla data acquisto Europe/Rome dal 01/09/2026. Le righe precedenti non creano vendite marketplace: vengono conservate soltanto come osservazioni “pre-cutoff, già gestite a mano”. Finestre iniziali di aggiornamenti fino a 30 giorni, sovrapposizione 48 ore, checkpoint persistito solo dopo classificazione di tutte le righe. Report pending recuperato nelle esecuzioni successive; nessun salto per polling esaurito, FATAL o CANCELLED.

Identità unica account venditore + ordine Amazon + articolo Amazon. Trigger per riga: item-status Shipped e fulfillment-channel Merchant; un ordine PartiallyShipped non blocca una sua riga Shipped. Cancellazioni ricevute prima dello scarico prevalgono; snapshot vecchi non riaprono righe annullate, conflitti a timestamp uguale richiedono revisione. Dopo uno scarico, resi/annullamenti/modifiche restano segnalazioni, senza storno automatico.

Scarico FEFO solo dal centrale E-Keto, con moltiplicatore variante applicato una volta. Bundle pianificato interamente prima di scrivere: insufficienza di un componente significa zero scarico della riga. Giacenza insufficiente non impedisce l'import e non produce valori negativi. Ledger immutabile collegato agli UUID dei movimenti effettivi; data movimento = last-updated-date, etichetta “data aggiornamento Amazon”. Mapping congelato dopo il consumo.

Modalità prova attiva per default e senza timer: salva piano FEFO, quantità, lotti/scadenze, errori di mapping e insufficienze, senza ledger né movimenti. Le prenotazioni del piano sono solo in memoria e ricostruite dalle preview: nessuno stock è riservato nel DB. Il passaggio manuale a modalità reale richiede conferma e rende idonee anche le righe dry-run pendenti; le revisioni non vengono riprovate automaticamente.

Pagina admin `/marketplace/amazon`: configurazione, cutoff, prova, abilitazione, coda, riepiloghi e osservazioni paginate. Quantità realmente scaricate separate da quantità pianificate deduplicate per articolo. Righe FBA e fulfillment sconosciuto in revisione, nessuno scarico. Valori finanziari/currency non validi restano in revisione. EUR e GBP (Amazon UK) sono conservati nella valuta originale; i report mostrano totali per valuta e il confronto retailer è esplicitamente solo EUR. Nessuna conversione valutaria implicita.

Amazon resta fuori dal pannello Ordini B2B e dalla pagina Shopify. Il motore/retry Shopify rifiuta Amazon, quindi non può bypassare il dry run o il ledger. Report Marketplace legge il database e aggrega le quantità a livello ordine prima di sommare i lordi, evitando di moltiplicare il fatturato per il numero di righe.

## Validazione

- 78 test mirati Amazon riusciti in 7 file: parser/piano, 21 casi PostgreSQL core, 2 casi HTTP+PostgreSQL checkpoint, sicurezza HTTP, impostazioni/RBAC/presentazione, finestre e cambi ora Europe/Rome.
- Ultima regressione completa: 220 riusciti, 12 preesistenti saltati (routers 8, retailer-details 3, auth.logout 1); tutti gli script DB successivi con `TESTDB_REGRESSION=PASS`.
- I test DB Amazon sono agganciati automaticamente al runner tramite `LOCAL_TEST_DATABASE_URL` e rifiutano target diversi da localhost:55432/gestionalesoketo_test; non basta che esistano nel repository.
- `pnpm check`, build frontend/API, controlli strict dei nuovi test e `git diff --check` riusciti.
- Migration 0051 applicata solo al PostgreSQL isolato: quattro nuove tabelle con RLS, vincoli validati, indici e trigger ledger append-only.
- Blueprint verificato staticamente contro tutti i rami HTTP. Nessun collaudo reale Make/SP-API, nessuna attivazione o chiamata di import in produzione.

## Sequenza prima dell'attivazione

1. L'utente applica la migration 0051 e la query `VERIFICA-0051.sql` in Supabase.
2. Push/merge/deploy solo dopo autorizzazione esplicita.
3. Configurare uno store Amazon E-Keto con Seller Account ID corretto e mantenere dry run attivo. Impostare il relativo UUID e il segreto dedicato nelle variabili server e nel blueprint, senza inserirli nel repository.
4. Make resta OFF fino a nuovo ordine dell'utente. Le finestre storiche vengono recuperate senza avanzare oltre report ancora incompleti.
5. Controllare almeno la prima settimana di prova: SKU/multipack, cutoff, identità articolo presente nel report, quantità pianificate, FBA/UK, giacenze mancanti e cancellazioni ricevute. Nessun automatismo disattiva la prova.
6. L'utente abilita manualmente lo scarico reale solo dopo riconciliazione.

L'architettura Make/report conosce gli annullamenti solo quando arrivano nel report: non fa una verifica SP-API in tempo reale immediatamente prima di ogni movimento. Il test garantisce il blocco per ogni annullamento già ricevuto e persistito prima dello scarico.

## Verifiche separate, senza implementazione eventi

Il workbook allegato ripete cinque blocchi identici da aprile a ottobre; marzo presenta anche ripetizioni dieci volte e tipi misti. Nessun report applicativo risulta leggere quel Google Sheet come fonte. La nota completa è `amazon-foglio-fonti-report-readonly-2026-11-05.md`.

Read-only aggiornato: 0073/0074/0079/0088 risultano già delivered; solo 0085 transferring e 0086 pending sono ancora aperti. La proposta eventi non viene implementata in questo branch. Occorre separare la destinazione evento dal flusso retailer (OUT dal centrale, nessun carico su retailer fittizio), mantenendo piano FEFO e audit A/B/C. 0085 richiede riconciliazione preventiva: l'assenza di un riferimento documentale sui vecchi movimenti non dimostra assenza di scarico. Nessun reset a pending né nuovo scarico dell'intera quantità. Dettaglio in `SoKeto-proposta-eccezioni-ordini-evento.md`.
