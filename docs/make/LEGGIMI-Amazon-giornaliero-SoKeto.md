**Versione Make Keys, 6 novembre 2026:** il JSON di questo branch elimina i Retry e usa una sola credenziale custodita in Make Keys, senza 36 valori segreti negli header. Segui la nuova [guida completa Keys](MAKE-KEYS-SECRETO-UNICO.md): il piccolo export di collegamento e la utility locale permettono una sola selezione della Key prima di importare il collector completo. Scarica il [pacchetto ZIP](SoKeto-Amazon-Make-Keys.zip), non cambiare gestori manualmente. La diagnostica `3909781` è in produzione dal deploy delle 14:25:23 italiane, merge `67e0cb4`. Make rimane OFF, dry run ON.

Il file **AmazonOrdiniGiornalieriEU-SoKeto.blueprint.json** prepara il nuovo flusso giornaliero **Make → gestionale SoKeto**, usando la connessione Amazon già presente nel blueprint mensile. Non modifica lo scenario 9129116 o il foglio esistente. È un blueprint JSON verificato offline, **non ancora collaudato importandolo/eseguendolo in Make**. [1]

File in questa cartella: [blueprint JSON](AmazonOrdiniGiornalieriEU-SoKeto.blueprint.json) e [diagnosi completa](SoKeto-diagnosi-import-Amazon-2026-11-05.md). Dalla pagina GitHub del JSON usa **Download raw file** per ottenere il file da importare in Make.

## Stato del branch di implementazione

Decisioni approvate il 5 novembre 2026: trigger su **item-status Shipped + fulfillment-channel Merchant**; movimento datato `last-updated-date`, chiamato **data aggiornamento Amazon**. Cutoff su `purchase-date` nel calendario Europe/Rome dal **01/09/2026**. Righe precedenti archiviate come “pre-cutoff, già gestite a mano”. FBA e fulfillment sconosciuto: Da verificare, zero scarico. Identità composta account/ordine/ID articolo. Dry run attivo per default, disattivato solo manualmente dall’amministratore, senza timer a sette giorni. Annullamenti prima dello scarico impediscono il consumo; annullamenti/resi successivi sono segnalati senza storno automatico.

Gli endpoint e la pagina admin sono in produzione. **Scenario Make OFF** fino a istruzione esplicita dell’utente. Il JSON pubblico contiene gli URL definitivi e riferimenti `auth: 0` non associati: non contiene il valore segreto e non va eseguito prima del collegamento privato della Key.

Configurazione backend prevista dopo l’applicazione manuale della 0051 e il deploy autorizzato: `AMAZON_IMPORT_STORE_ID` (UUID dello store Amazon configurato in admin) e `AMAZON_IMPORT_WEBHOOK_KEY` (segreto dedicato, almeno 32 caratteri, non committato e mai mostrato nei log). Il segreto va associato anche ai moduli HTTP Make. Store/company provengono dal server: E-Keto soltanto. Nessuna credenziale Amazon nuova nel gestionale.

Le finestre di recupero iniziale coprono fino a **30 giorni** di aggiornamenti Amazon per report, con checkpoint e sovrapposizione di 48 ore; il cutoff di acquisto viene verificato sulle righe, indipendentemente dalla finestra. Il riepilogo identifica la coda ancora da elaborare; non si dichiara completato un recupero con elementi ancora pending.

## Cosa cambia rispetto al mensile

Una sola richiesta Amazon con i cinque marketplace già configurati, anziché una richiesta ripetuta per ciascun paese. Se il checkpoint restituisce un report ancora da completare, il flusso riprende quello stesso report e non ne crea un altro; dopo una nuova creazione, registra subito il report ID nel gestionale prima del polling. Nel file Excel ogni riga ridotta di settembre e ottobre compare cinque volte: 525 righe contro 105 combinazioni distinte a settembre e 575 contro 115 a ottobre. Queste ripetizioni sono state osservate, **non cancellate**; non ho alterato il file storico né assunto che una deduplicazione delle nove colonne basti a ricostruire le righe originali.

Il report diventa `GET_FLAT_FILE_ALL_ORDERS_DATA_BY_LAST_UPDATE_GENERAL`. Cerca ordini aggiornati nella finestra, non soltanto acquisti del giorno prima: così può trovare un ordine acquistato giorni prima e successivamente spedito. Non contiene però una data esplicita di spedizione. Il filtro “spediti” deve usare gli stati effettivi, senza chiamare `last-updated-date` “data di spedizione”. [2]

Dopo la richiesta, Make attende 60 secondi e controlla lo stesso report. Sono previsti fino a quattro controlli. I rami DONE, CANCELLED, FATAL, pending e stato inatteso sono mutuamente esclusivi; al primo DONE il flusso scarica e inoltra il documento una volta e non continua a fare polling. Il limite di quattro minuti è una scelta pratica, **non una garanzia del tempo di elaborazione Amazon**. Se il report non è pronto, viene segnalato e la finestra non va persa. [3]

Il documento è trasferito integralmente come buffer, senza `ParseCSV`, `colCount:33`, `colN`, `parseNumber` o scrittura Google Sheets. Il gestionale legge le intestazioni per nome e valida il documento UTF-8 e la compressione. Il trigger è **item-status Shipped + fulfillment-channel Merchant**: una riga Shipped di un ordine PartiallyShipped è idonea. FBA, fulfillment sconosciuto e righe non Shipped non producono scarichi; annullamenti e resi successivi allo scarico sono segnalati senza storno automatico. Se gli attributi obbligatori mancano, il report va bloccato per verifica, non completato con valori inventati. [2] [4]

## Come importarlo in Make

Segui [MAKE-KEYS-SECRETO-UNICO.md](MAKE-KEYS-SECRETO-UNICO.md), che sostituisce le istruzioni precedenti. Crea/seleziona la chiave una volta dal piccolo scenario di associazione; la utility prepara privatamente i 36 riferimenti nel collector completo. Non pubblicare gli export privati e non inserire il segreto negli header.

Importa il file finale in un nuovo scenario, verifica la connessione Amazon esistente e mantieni **Keep data confidential Yes**, **Store incomplete executions No**, **Process data in order Yes**, **Scheduling OFF**. Le istruzioni per gestire i vecchi incompleti e spostare nel cestino il vecchio collector sono nella stessa guida. La schedulazione giornaliera viene solo dopo una prova valida. [1] [7]

Gli handler Break/Retry sono stati eliminati da questo JSON: nessun bundle viene trattenuto per una incomplete execution nuova. Un errore ferma il run, mentre il checkpoint server consente il successivo recupero autorizzato se il report ID è già persistito. Il timeout di CreateReport prima del salvataggio dell'ID resta un caso ambiguo da verificare, non da rilanciare alla cieca. Il rollback Make non annulla POST o stock remoti. [7]

## Contratto del gestionale predisposto nel blueprint

Questi sono gli endpoint implementati; sono utilizzabili dopo il deploy e la configurazione privata, mantenendo Make OFF fino alla prova autorizzata. La chiave `X-SoKeto-Amazon-Key` deve essere obbligatoria e associata server-side allo store Amazon e alla company E-Keto. Company e magazzino non possono essere scelti dal payload; un header che dichiara `FBM_SHIPPED` non sostituisce la verifica dei campi reali.

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

La finestra deve essere derivata dall’ultima acquisizione valida, con sovrapposizione, rispettando il cutoff configurato. Il backend deve proporre intervalli contenuti — fino a trenta giorni al massimo — e riprendere dal punto non completato dopo un’interruzione, non impostare sempre “ieri” perdendo un fermo di più giorni. Le finestre dei report Amazon non devono superare il limite documentato di 30 giorni. [2]

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

La politica iniziale è stata approvata dall’utente: vengono ignorate e tracciate le righe con `purchase-date` prima del 01/09/2026. Il nome del movimento resta “data aggiornamento Amazon”, non “data spedizione”. La modalità prova serve a verificare i piani e i casi senza giacenza prima del passaggio manuale allo scarico reale.

Le varianti Amazon dedicate non risultavano configurate nel database verificato; i nomi SKU nel foglio non sono una mappatura al prodotto interno. Occorre acquisire o confermare SKU → prodotto → **pezzi per unità Amazon**, senza moltiplicare due volte i multipack. Il blueprint non risolve questa mappatura e non accede a stock o ordini B2B.

## Controlli eseguiti

JSON valido, riferimenti dei moduli accessibili, ID univoci, una sola richiesta report, quattro stadi di polling e rami esclusivi. Simulati DONE al primo/secondo/terzo/quarto controllo, CANCELLED, FATAL, stato vuoto/inatteso e pending persistente. Controllato l’invio raw del file e la conservazione degli header. **378 controlli locali passati**, senza chiamate esterne.

Non sono stati verificati dal vivo l’import Make, gli output del connettore o una consegna al webhook. I percorsi Amazon `body.processingStatus`, `body.reportDocumentId` e `body.url` sono conservati dal blueprint fornito. L’implementazione e la migration 0051 sono documentate nel [rapporto di implementazione](IMPLEMENTAZIONE-Amazon-giornaliero.md); questa sezione conserva i controlli offline del blueprint, non un collaudo reale Make.

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

## Configurazione privata dopo il deploy — 6 novembre 2026

Nel gestionale seleziona l’azienda E-Keto e apri **Marketplace → Amazon**, pagina `/marketplace/amazon`. Usa **Configura store Amazon** per il primo account: inserisci **Nome store** e **Seller Account ID**, mantieni **Cutoff acquisto = 2026-09-01**, **Modalità prova (dry-run) ON** e, per ora, **Import abilitato OFF**. Dopo **Salva configurazione**, la pagina mostra **Store ID**: è l’UUID interno da copiare privatamente, non il Seller Account ID. Se l’account è già configurato, seleziona quello esistente e non creare un duplicato. Il Seller Account ID è persistito nella configurazione DB dello store, non nelle variabili server e non nel blueprint.

Nel progetto Vercel **gestionalesoketo → Settings → Environment Variables**, seleziona soltanto **Production** e aggiungi:

- `AMAZON_IMPORT_STORE_ID`: lo **Store ID** mostrato dal gestionale. Tipo **Config**; può anche essere **Secret** se vuoi renderlo non rileggibile nel pannello.
- `AMAZON_IMPORT_WEBHOOK_KEY`: un segreto casuale dedicato generato nel tuo password manager, almeno 32 caratteri, consigliati 64. Tipo **Secret**, oppure **Sensitive** nella precedente interfaccia. Conservane una copia privata nel password manager prima di salvarlo, perché il valore Secret non è rileggibile dopo il salvataggio.

Non usare prefissi `VITE_` o `NEXT_PUBLIC_`, non inserirli in `.env` committati e non copiarli in chat. Non servono credenziali Amazon nel server: Make usa la connessione Amazon esistente. Le modifiche alle variabili richiedono un nuovo deployment: usa **Deployments → ultimo deployment Production → Redeploy** e attendi **Ready** prima di qualsiasi prova. [9] [10]

In un nuovo scenario Make, ancora **OFF**, importa il blueprint di questo branch: gli URL definitivi sono già impostati. Nei moduli Amazon seleziona privatamente la connessione Amazon Seller Central già autorizzata. Per ciascuno dei **36 moduli HTTP diretti al gestionale**, apri **Headers** e sostituisci esclusivamente il valore `DA_CONFIGURARE` dell’header `X-SoKeto-Amazon-Key` con lo stesso segreto salvato su Vercel. Non basta compilare il primo modulo: anche i rami di recupero, errore e upload devono avere la chiave. Non aggiungere il segreto ai moduli Amazon o al download del documento Amazon.

**Seller Account ID e UUID dello store non vanno nel blueprint:** il backend ricava entrambi dalla configurazione dello store indicato dalla variabile server. Non aggiungere company o warehouse al payload. Mantieni schema, body raw, mapping e altri header del blueprint invariati.

Non esportare o committare il blueprint dopo avervi inserito la chiave; non condividere schermate dei campi compilati. Il JSON pubblico deve conservare `DA_CONFIGURARE`. Mantieni le esecuzioni riservate, la pianificazione disattivata e non premere **Run once**. La configurazione privata non autorizza ancora la prova: l’utente deciderà quando accendere **Import abilitato** nel gestionale e avviare Make. Il dry run rimane ON fino alla riconciliazione esplicita della prova Amazon. Nessun intervento sugli ordini evento 0085 e 0086.

[9]: https://vercel.com/docs/environment-variables "Vercel — Variabili Config e Secret, ambiti e nuovi deployment"
[10]: https://vercel.com/kb/guide/how-to-add-vercel-environment-variables "Vercel — Impostare variabili nel dashboard e applicarle con redeploy"
