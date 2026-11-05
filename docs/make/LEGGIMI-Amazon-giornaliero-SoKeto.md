Il file **AmazonOrdiniGiornalieriEU-SoKeto.blueprint.json** prepara il nuovo flusso giornaliero **Make → gestionale SoKeto**, usando la connessione Amazon già presente nel blueprint mensile. Non modifica lo scenario 9129116 o il foglio esistente. È un blueprint JSON verificato offline, **non ancora collaudato importandolo/eseguendolo in Make**. [1]

File in questa cartella: [blueprint JSON](AmazonOrdiniGiornalieriEU-SoKeto.blueprint.json) e [diagnosi completa](SoKeto-diagnosi-import-Amazon-2026-11-05.md). Dalla pagina GitHub del JSON usa **Download raw file** per ottenere il file da importare in Make.

Pubblicazione autorizzata sul solo branch `docs/amazon-daily-make-blueprint`, senza merge. Il `vercel.json` del branch disabilita esplicitamente i deployment automatici di questo branch; la produzione e `main` non vengono modificati. Nessun endpoint viene implementato. La scelta della data operativa resta da approvare.

**Importalo soltanto in un nuovo scenario e lascialo OFF.** Gli endpoint del gestionale non sono ancora implementati: tutti gli URL di ingresso sono intenzionalmente `https://example.invalid/api/marketplace/amazon/...` e la chiave è `DA_CONFIGURARE`. Il primo modulo si blocca su questa configurazione, prima di creare un report Amazon. Nessuna chiamata Amazon, nessun import e nessuno scarico sono stati eseguiti durante la preparazione.

## Cosa cambia rispetto al mensile

Una sola richiesta Amazon con i cinque marketplace già configurati, anziché una richiesta ripetuta per ciascun paese. Se il checkpoint restituisce un report ancora da completare, il flusso riprende quello stesso report e non ne crea un altro; dopo una nuova creazione, registra subito il report ID nel gestionale prima del polling. Nel file Excel ogni riga ridotta di settembre e ottobre compare cinque volte: 525 righe contro 105 combinazioni distinte a settembre e 575 contro 115 a ottobre. Queste ripetizioni sono state osservate, **non cancellate**; non ho alterato il file storico né assunto che una deduplicazione delle nove colonne basti a ricostruire le righe originali.

Il report diventa `GET_FLAT_FILE_ALL_ORDERS_DATA_BY_LAST_UPDATE_GENERAL`. Cerca ordini aggiornati nella finestra, non soltanto acquisti del giorno prima: così può trovare un ordine acquistato giorni prima e successivamente spedito. Non contiene però una data esplicita di spedizione. Il filtro “spediti” deve usare gli stati effettivi, senza chiamare `last-updated-date` “data di spedizione”. [2]

Dopo la richiesta, Make attende 60 secondi e controlla lo stesso report. Sono previsti fino a quattro controlli. I rami DONE, CANCELLED, FATAL, pending e stato inatteso sono mutuamente esclusivi; al primo DONE il flusso scarica e inoltra il documento una volta e non continua a fare polling. Il limite di quattro minuti è una scelta pratica, **non una garanzia del tempo di elaborazione Amazon**. Se il report non è pronto, viene segnalato e la finestra non va persa. [3]

Il documento è trasferito integralmente come buffer, senza `ParseCSV`, `colCount:33`, `colN`, `parseNumber` o scrittura Google Sheets. Il gestionale dovrà leggere le intestazioni per nome, verificare charset e compressione e importare/scaricare **soltanto FBM completamente spediti**. FBA, `Non-Amazon`, righe pending e spedizioni parziali non producono scarichi in questa prima versione; annullamenti e resi vanno segnalati senza storno automatico. Se gli attributi obbligatori mancano, il report va bloccato per verifica, non completato con valori inventati. [2] [4]

## Come importarlo in Make

1. Crea un **nuovo scenario**, senza sostituire il mensile 9129116. Dal menu del builder scegli **Import blueprint** e carica il JSON. Mantieni il nuovo scenario disattivato. [1]
2. Nei moduli Amazon verifica che sia selezionata la connessione esistente **My Amazon Seller Central connection (A3SX60AF2FDUDC)**, ID esportato `9605332`. Se Make richiede di riassociarla, scegli quella già autorizzata; non crearne un’altra. Il nuovo flusso non usa Google Sheets.
3. Nella pianificazione seleziona **Daily**, con un solo orario **03:00**. La pianificazione non è trasferita dal blueprint; va impostata nel builder. [1] [5]
4. Controlla che il **fuso dell’organizzazione** sia **Europe/Rome**. Il fuso del profilo utente cambia soltanto la visualizzazione. Non cambiare alla cieca il fuso dell’organizzazione: la modifica può spostare anche gli altri scenari. [6]
5. Verifica le opzioni **Sequential processing** e **Store incomplete executions**, predisposte nel JSON. Il salvataggio dei dati d’esecuzione è impostato come riservato (`confidential:true`) per non esporre il documento Amazon nei normali log. [7]
6. **Non premere Run once e non attivarlo ora.** Dopo l’implementazione e i test del gestionale, serviranno gli URL reali e la chiave dedicata. Sarà preferibile consegnare il JSON aggiornato con gli URL definitivi, anziché chiederti di correggere manualmente tutti i rami HTTP.

Gli handler Break conservano i fallimenti HTTP come esecuzioni incomplete. I GET e gli upload ammettono tentativi limitati; `createReport` non ha retry automatico, perché un timeout potrebbe verificarsi dopo la creazione effettiva del report. Un retry Make non garantisce “un solo scarico”: questa garanzia dovrà essere applicata nel gestionale, sotto lock e per riga. [7]

## Contratto del gestionale predisposto nel blueprint

Questi sono **endpoint proposti, non endpoint già disponibili**. La chiave `X-SoKeto-Amazon-Key` deve essere obbligatoria e associata server-side allo store Amazon e alla company E-Keto. Company e magazzino non possono essere scelti dal payload; un header che dichiara `FBM_SHIPPED` non sostituisce la verifica dei campi reali.

### GET `/api/marketplace/amazon/import-window`

Il primo modulo riceve una finestra congelata dal checkpoint server, in UTC, con questa forma:

```json
{
  "run_id": "identificativo-della-esecuzione",
  "report_id": null,
  "window_start": "2026-11-04T00:00:00Z",
  "window_end": "2026-11-05T00:00:00Z"
}
```

Le date sopra sono **esempi di formato**, non il cutoff scelto e non un giorno Europe/Rome convertito. Make mappa `1.data.run_id`, `1.data.window_start` e `1.data.window_end`: `data` è il corpo JSON parsato del modulo HTTP; la risposta non deve aggiungere un secondo involucro `{ "data": ... }`.

`report_id:null` indica che serve una nuova richiesta; se il report della finestra esiste già e non è stato acquisito, il server restituisce il suo ID in `report_id` e il flusso lo riutilizza. Il ramo nuovo usa `3.reportId`, quello di recupero usa `1.data.report_id`. La finestra deve restare la stessa del report riutilizzato.

La finestra deve essere derivata dall’ultima acquisizione valida, con sovrapposizione, rispettando il cutoff configurato. Il backend deve proporre intervalli contenuti — per esempio sette giorni al massimo — e riprendere dal punto non completato dopo un’interruzione, non impostare sempre “ieri” perdendo un fermo di più giorni. Le finestre dei report Amazon non devono superare il limite documentato di 30 giorni. [2]

Finché manca il cutoff/configurazione necessaria, la GET deve rispondere con errore e impedire la richiesta Amazon. Le date non devono essere formattate nel fuso locale aggiungendo semplicemente una Z.

### POST `/api/marketplace/amazon/report-created`

Subito dopo `createReport`, il modulo 4 salva il report ID sul run della finestra. Invia un body statico `{"schema_version":1,"outcome":"REPORT_CREATED"}` e gli header di run, report, tipo, finestra e marketplace. La scrittura deve essere idempotente: in caso di risposta persa, il retry riassocia lo stesso report allo stesso run. Nessun avanzamento del checkpoint e nessuno scarico.

Questo permette alla notte successiva di riprendere un report ancora pending. Un timeout ambiguo di `createReport` prima di ricevere il suo ID resta invece un errore da verificare, non una creazione da ritentare alla cieca.

### POST `/api/marketplace/amazon/report-file`

Riceve il buffer originale del download, **non un JSON con le righe**. Il blueprint usa il formato HTTP v3 verificato `bodyType:raw`, `contentType:text/plain`, `data:{{modulo-download.data}}`. Il tipo `text/plain` è un contenitore raw compatibile con questa configurazione Make, non una dichiarazione che eventuali byte GZIP siano già TSV decompresso. Il futuro server deve usare un parser **raw/buffer** per questa route, non un middleware che converta immediatamente il body in stringa. [4] [8]

Il contesto viaggia in questi header:

```text
X-SoKeto-Amazon-Key
X-Amazon-Import-Run-Id
X-Amazon-Report-Id
X-Amazon-Report-Type
X-Amazon-Window-Start
X-Amazon-Window-End
X-Amazon-Processing-Status
X-Amazon-Marketplace-Ids
X-Amazon-Import-Policy
X-Amazon-Report-Document-Id
X-Amazon-Compression-Algorithm
X-Amazon-Body-Format: ORIGINAL_REPORT_DOCUMENT
```

Il server deve verificare la firma del formato GZIP e la dichiarazione `GZIP`/`NONE`, gestire il charset e validare l’intestazione. Se Make dovesse cambiare la rappresentazione rispetto al documento dichiarato, l’incompatibilità deve fermare il trattamento: nessuno scarico e nessun avanzamento del checkpoint. La trasmissione corretta e la decodifica andranno testate con il TSV effettivo di una prova autorizzata, perché l’Excel allegato non conserva il documento originale. [4]

Il file viene scaricato in Make prima dell’upload. Così un retry dell’upload riusa i byte già acquisiti e non dipende dalla scadenza dell’URL firmato Amazon. L’URL firmato non viene inviato al gestionale, scritto in un foglio o inserito nel blueprint. Il download iniziale deve essere tempestivo: l’URL Amazon scade dopo cinque minuti. Se un’esecuzione incompleta del download viene ripresa molto dopo, bisogna rinnovare `getReportDocument`, non insistere su un URL vecchio. [4]

Risposta 2xx soltanto dopo acquisizione **durevole** del documento e del run. Per non superare i 60 secondi della funzione Vercel attuale, l’elaborazione può avvenire poi da una coda durevole, non da un processo non garantito dopo la risposta. Il checkpoint avanza soltanto dopo la validazione e la contabilizzazione durevole di tutti gli esiti, comprese le righe “Da verificare”. L’idempotenza su report/documento evita upload doppi; **quella su ordine e riga** evita riscarichi di snapshot sovrapposti o report diversi.

La chiave proposta per la riga è **account venditore + `amazon-order-id` + `order-item-id`**. Il nome ufficiale del campo nel report è `order-item-id`, non `amazon-order-item-id`. Deve essere realmente presente e valido nel TSV: l’Excel ridotto non lo conserva, quindi non consente di applicare retroattivamente questa chiave allo storico allegato. `ordine + SKU` non è automaticamente univoco. Se il campo manca, la riga va fermata per verifica, senza inventare un identificativo. Un vincolo sulla chiave, insieme al lock e al consumo salvato per riga, impedirà che snapshot ripetuti e retry producano un secondo scarico; il blueprint da solo non implementa questa garanzia. [2]

### POST `/api/marketplace/amazon/report-status`

Riceve un JSON statico con `schema_version:1` e uno dei seguenti `outcome`, più gli header del contesto:

- `CANCELLED`: stato terminale Amazon, che può anche significare assenza di dati. Non è automaticamente una finestra completata con zero ordini.
- `FATAL`: errore di elaborazione Amazon.
- `POLLING_EXHAUSTED`: ancora IN_QUEUE/IN_PROGRESS dopo quattro controlli.
- `UNEXPECTED_STATUS`: stato assente o diverso da quelli previsti.

Il backend deve rendere l’esito visibile e mantenere il run recuperabile, senza scarico e senza avanzare automaticamente il checkpoint. Per un report ancora pending, il GET della successiva esecuzione deve poter verificare quel report prima di creare una nuova richiesta. Per CANCELLED il checkpoint può essere concluso soltanto dopo che il gestionale ha verificato esplicitamente un esito “nessun dato”. [3]

## Decisioni ancora necessarie prima del primo scarico

Il report individua **ordini aggiornati che risultano spediti**, non eventi di spedizione datati con certezza. La sola impostazione di una data iniziale non garantisce che un vecchio ordine già scaricato manualmente, ma aggiornato dopo il cutoff, sia escluso. Prima di attivare lo scarico serve un criterio di avvio verificato: elenco iniziale di ordini già contabilizzati oppure un’altra riconciliazione approvata. Non ho scelto una data di partenza né autorizzato uno scarico retroattivo.

Le varianti Amazon dedicate non risultavano configurate nel database verificato; i nomi SKU nel foglio non sono una mappatura al prodotto interno. Occorre acquisire o confermare SKU → prodotto → **pezzi per unità Amazon**, senza moltiplicare due volte i multipack. Il blueprint non risolve questa mappatura e non accede a stock o ordini B2B.

## Controlli eseguiti

JSON valido, riferimenti dei moduli accessibili, ID univoci, una sola richiesta report, quattro stadi di polling e rami esclusivi. Simulati DONE al primo/secondo/terzo/quarto controllo, CANCELLED, FATAL, stato vuoto/inatteso e pending persistente. Controllato l’invio raw del file e la conservazione degli header. **378 controlli locali passati**, senza chiamate esterne.

Non sono stati verificati dal vivo l’import Make, gli output del connettore o una consegna al webhook. I percorsi Amazon `body.processingStatus`, `body.reportDocumentId` e `body.url` sono conservati dal blueprint fornito. Il gestionale non è stato implementato, non è stata preparata una migration e non sono stati effettuati push, merge o deploy.

## References

Autore: Manus AI. Analisi del blueprint e dell’Excel forniti il 5 novembre 2026.

[1]: https://help.make.com/blueprints "Make — Scenario blueprints e importazione"
[2]: https://developer-docs.amazon/sp-api/docs/report-type-values-order "Amazon — Report ordini per data e ultimo aggiornamento"
[3]: https://developer-docs.amazon/sp-api/docs/verify-that-report-processing-is-complete "Amazon — Stati di elaborazione dei report"
[4]: https://developer-docs.amazon/sp-api/docs/retrieve-a-report "Amazon — Download, charset e GZIP del report"
[5]: https://help.make.com/schedule-a-scenario "Make — Pianificazione Daily dello scenario"
[6]: https://help.make.com/manage-time-zones "Make — Fuso dell’organizzazione e del profilo"
[7]: https://help.make.com/break-error-handler "Make — Esecuzioni incomplete e retry Break"
[8]: https://apps.make.com/http-legacy "Make — Modulo HTTP legacy v3 e body raw"
