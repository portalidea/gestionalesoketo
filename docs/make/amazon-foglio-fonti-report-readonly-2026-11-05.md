# AmazonVenditeReport: ripetizioni e fonti dei report SoKeto

**Verifica in sola lettura — 5 novembre 2026.** Repository: `/home/ubuntu/gestionalesoketo-main-legacy-call-audit-release`, HEAD `bd09d373256477739e5f39f4d1c6acc862abd5c4`. Excel: `/home/ubuntu/upload/AmazonVenditeReport.xlsx`, SHA-256 `5e626b6ddebf8821ece8891140641f5f3acebe702ecfaee606035181407b3eac`.

## Risposta breve

**Sì: da aprile a ottobre il file contiene ogni riga raw ripetuta esattamente cinque volte**, ed è composto da cinque blocchi consecutivi identici per ciascun mese. Marzo non è descrivibile come «ogni vendita esattamente 5x» senza precisazioni: sui nove valori A:I letti conservando i tipi, 192 combinazioni compaiono cinque volte e tre dieci volte.

**Nel codice esaminato nessun report del gestionale risulta leggere il foglio Google `Amazon Vendite Report`** né l’ID `1qFuwtBsaqRXihBHyPkd0ZRO-61-Hb6YYlbMyIes78jg`. Il Report Marketplace usa il database (`marketplace_orders`, `marketplace_order_items`, `sales_stores`), non questo foglio. Non è quindi provato che le ripetizioni dell’Excel si propaghino ai report del gestionale.

## 1. Conteggio su tutte le schede raw

Workbook di 17 schede: `Foglio1` vuoto, otto raw marzo–ottobre 2026 e otto riepiloghi mensili. Tutte le righe non vuote sono state contate, **inclusa la prima riga**, perché i raw non hanno intestazioni.

Metodo: `openpyxl.load_workbook(..., read_only=True)`, `iter_rows(min_col=1, max_col=9, values_only=True)` e `collections.Counter` sulle tuple A:I. La lettura è stata confrontata con `data_only=True/False` e con la modalità ordinaria senza salvare il workbook. Le celle finali vuote sono uniformate a `None`, per non scambiare righe corte per dati differenti. Per marzo, controllo aggiuntivo dei tipi/valori XML memorizzati.

| Scheda | Righe raw | Combinazioni A:I distinte, conservando i tipi | Frequenza delle combinazioni |
|---|---:|---:|---|
| `2026-03-raw` | 990 | 195 | 192 × 5; 3 × 10 |
| `2026-04-raw` | 515 | 103 | tutte × 5 |
| `2026-05-raw` | 550 | 110 | tutte × 5 |
| `2026-06-raw` | 445 | 89 | tutte × 5 |
| `2026-07-raw` | 335 | 67 | tutte × 5 |
| `2026-08-raw` | 390 | 78 | tutte × 5 |
| `2026-09-raw` | 525 | 105 | tutte × 5 |
| `2026-10-raw` | 575 | 115 | tutte × 5 |
| **Totale** | **4.325** | **862, somma dei distinti mensili** | **859 × 5; 3 × 10** |

Da aprile a ottobre non si osserva soltanto una frequenza 5: l’intera sequenza mensile è ripetuta in cinque blocchi identici. Anche la somma della quantità F è quindi cinque volte quella di un singolo blocco. Ad esempio ottobre: 575 righe contro 115 combinazioni distinte; quantità F 840 contro 168.

### Precisazione su marzo e sull’audit precedente

Nel confronto A:I con i tipi conservati, i tre gruppi ripetuti dieci volte hanno la prima occorrenza alle righe **14, 28 e 29**. Considerando solo A:G si hanno 99 combinazioni, ciascuna presente dieci volte; dieci blocchi consecutivi A:G da 99 righe sono identici. H e I sono eterogenee fra i blocchi: stringhe, numeri e valori interpretati come ore/date/durate. Questo impedisce di trattare automaticamente tutti gli importi come numeri validi.

Il risultato precedente «182 combinazioni ×5 e otto ×10» (`/home/ubuntu/reports/amazon-supplied-report-fields-audit.md:17`) è riproducibile **convertendo ogni valore in stringa prima del confronto**: ad esempio stringa `"9.9"` e numero `9.9` diventano indistinguibili. Non è il conteggio delle tuple originali tipizzate. La tabella sopra riporta il conteggio sui valori letti senza questa conversione; l’audit precedente non è stato modificato.

**Limite importante:** una tupla identica di nove campi non equivale alla prova di una vendita reale duplicata. L’Excel ridotto non conserva un ID stabile della riga articolo (`order-item-id`). Non dimostra la causa delle ripetizioni, né autorizza a eliminare righe autentiche che siano diventate indistinguibili dopo la riduzione. I conteggi non sono una riconciliazione degli incassi Amazon né una validazione dei totali monetari dei riepiloghi.

## 2. Ricerca del collegamento al foglio

Ricerca case-insensitive su tutto il repository, inclusi file ignorati da Git e nascosti, esclusi `.git`, `node_modules`, `dist` e il bundle API generato `api/index.js`. Sono inclusi server, client, servizi, script, lib, shared, configurazioni e gli handler/API sorgente non generati. Sono stati cercati l’ID, varianti del nome, `AmazonVenditeReport`, `sheetdata`, `getmarketplace`, URL Google Sheets, `google-spreadsheet` e accessi `spreadsheets.get/values`.

**Nessuna occorrenza dell’ID, del nome o di un lettore Google Sheets/sheetdata/getmarketplace.** I riferimenti Google nel codice applicativo riguardano font, non lettura di dati. L’uso di XLSX riguarda l’esportazione inventario, non una sorgente Sheets dei report. La pagina Integrazioni mostra connessioni Fatture in Cloud (`client/src/pages/Integrations.tsx:38-50, 140-144`), non un’integrazione con questo foglio.

Il sorgente dell’handler Vercel importa il router applicativo (`vercel-handler/index.ts:18-34`), che registra `reportsRouter` (`server/routers.ts:41, 2238`). La connessione dei resolver è PostgreSQL via `DATABASE_URL` (`server/db.ts:57-74`). Nessun resolver è stato eseguito.

## 3. Quali report usano quali fonti

I riferimenti seguenti sono relativi alla radice del repository. **Tutti i report elencati leggono il database, non `Amazon Vendite Report`.**

| Report/procedura | Fonte nel codice | Riferimenti |
|---|---|---|
| **Marketplace** — `reports.marketplace.getOverview`, `getOrdersTable` | `marketplace_orders`, `marketplace_order_items`, `sales_stores`; il confronto Retailer/Marketplace aggiunge `orders` | UI `client/src/pages/reports/MarketplaceReport.tsx:45-55`; backend `server/reports-router.ts:689-710, 735-809, 812-847, 882-922` |
| **Vendite & Ordini** — `reports.sales.getOverview`, `getOrdersTable`, `getRetailerBreakdown` | `orders`, `orderItems`, `retailers`, `order_service_lines` | UI `client/src/pages/reports/SalesReport.tsx:59-75`; backend `server/reports-router.ts:370-402, 456-471, 501-534, 584-634, 645-671` |
| **Magazzino** — `reports.warehouse.getOverview`, `getMovementsTable`, `getExpiringBatches` | `inventoryByBatch`, `productBatches`, `products`, `locations`, `stockMovements` | UI `client/src/pages/reports/WarehouseReport.tsx:49-64`; backend `server/reports-router.ts:81-110, 148-159, 265-309, 328-355` |
| **Promozioni/Omaggi** — `reports.promozioni.getReport` | `orders`, `orderItems`, `products`, `retailers` | UI `client/src/pages/reports/PromozioniReport.tsx:42-49`; backend `server/reports-router.ts:1095-1137` |
| **Eccezioni di evasione** — `reports.fulfillmentExceptions.list` | `order_item_fulfillment_exceptions`, `orders`, `retailers`, `users` | UI `client/src/pages/reports/FulfillmentExceptionsReport.tsx:65`; backend `server/reports-router.ts:1224-1277` |
| **Scadenze**, route `/reports/scadenze` — `expiryAlerts.*` | `expiry_alert_settings`, `expiry_alert_runs`, `expiry_alert_notifications`, `expiry_alert_suppressions`, `email_log`; dettaglio `expiry_alert_items` | UI `client/src/App.tsx:254-255`, `client/src/pages/ExpiryAlerts.tsx:11-17`; backend `server/expiry-alert-router.ts:11-19, 39-86, 101-105` |
| **Report mensile commissioni affiliati** — `affiliates.monthlyReport`, route `/affiliates/report` | `affiliateCommissions`, `affiliates` | UI `client/src/pages/MonthlyCommissionReport.tsx:38`, `client/src/App.tsx:221-222`; backend `server/affiliates-router.ts:427-477` |
| **Travasi intercompany**, resolver presente ma senza route UI attiva rilevata | `stockMovements`, `products`, `productBatches`, `orders`, `users` | `server/reports-router.ts:50-74, 1180-1205`; consumer `client/src/pages/reports/IntercompanyTransfersReport.tsx:16-17`; nessuna importazione/route del componente in `client/src/App.tsx` |
| **Esportazioni CSV** dei report Magazzino, Vendite e Marketplace | Query alle medesime tabelle DB, non esportazione dal foglio | `server/reports-router.ts:939-1049`; specificamente Marketplace `1027-1049` |

L’hub Reportistica chiama le tre overview DB e mostra le schede Magazzino, Vendite & Ordini, Marketplace, Promozioni ed Eccezioni (`client/src/pages/reports/ReportsHub.tsx:15-71`). Il componente vecchio `client/src/pages/Reports.tsx:17-59` è un placeholder «Reportistica in Arrivo», non una lettura del foglio. Il riepilogo mensile commissioni via cron, se eseguito altrove, usa anch’esso il DB (`server/cron-monthly-report.ts:34-94`); il cron non è stato invocato.

Per Amazon, nel report Marketplace è presente il filtro di canale `"amazon"` (`server/reports-router.ts:687, 878`). Questo non prova che esistano ordini Amazon nel database o che siano stati importati dal foglio. Magazzino comprende il tipo DB `AMAZON_EXIT` nei movimenti in uscita (`server/reports-router.ts:151-159`), non legge le schede raw Amazon.

## 4. Perimetro e limiti

Verificati file e codice locali, non il runtime produttivo. Nessuna query DB, nessuna chiamata Make, Amazon o Google, nessun import/sync e nessuna modifica del repository o dell’Excel. SHA-256 dell’Excel e HEAD invariati; stato Git invariato rispetto all’inizio (già presente il percorso non tracciato `reports/prospect-premium-890-production/`). È stata scritta solo questa nota fuori dal repository.

**Conclusione utilizzabile in chat:** «Il file ha davvero righe ripetute 5x da aprile a ottobre; marzo ha un’eccezione e problemi di tipi negli importi. Nel codice attuale nessun report risulta usare quel Google Sheet: Marketplace legge le tabelle del database. Perciò l’Excel ripetuto non prova che il gestionale stia quintuplicando le vendite.»
