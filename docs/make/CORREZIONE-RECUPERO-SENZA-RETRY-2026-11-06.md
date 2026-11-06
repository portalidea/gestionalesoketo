# Recupero Amazon senza Retry — 6 novembre 2026

Per lo scenario già configurato, **modifica manualmente i gestori e le impostazioni: non serve reimportare il blueprint**. Così non tocchi le 36 chiavi HTTP già inserite privatamente. Mantieni Make **OFF** e dry run **ON**. Il [blueprint aggiornato](AmazonOrdiniGiornalieriEU-SoKeto.blueprint.json) contiene i filtri nativi corretti, nessun ramo `onerror`, `confidential:true`, `dlq:false` e `sequential:true`.

**Raccomandazione: Process data in order = Yes**, mantenuto nel blueprint. Con Store incomplete executions = No e tutti i Retry eliminati, non resta il blocco dovuto a incomplete executions nuove. Yes conserva invece la serializzazione degli avvii, importante perché il backend non ha una lease che copra la chiamata esterna CreateReport. No può essere usato per una sola prova manuale senza sovrapposizioni, ma non lo consiglio per la futura schedulazione. Non attivare Make con questo intervento.

Questa guida sostituisce le indicazioni precedenti sui gestori Break e sui retry delle esecuzioni incomplete contenute in `LEGGIMI-Amazon-giornaliero-SoKeto.md`. Non cambia la politica FBM, i cutoff, gli ordini evento o la configurazione privata.

## Impostazioni da salvare in Make

Nel builder apri l’ingranaggio **Scenario settings**. Imposta **Keep data confidential = Yes** e **Store incomplete executions = No**. Nelle interfacce precedenti il secondo campo può chiamarsi **Allow storing incomplete executions**. La riservatezza impedisce di trattenere i payload nei log di esecuzione, lasciando visibile che il run è avvenuto; riduce quindi le possibilità di diagnosi. Non rimuove automaticamente export privati, schermate o dati già conservati altrove. [1]

**Process data in order = Yes**, già presente nel JSON. Il nome precedente è **Sequential processing**. Yes serializza gli avvii e non trattiene un’esecuzione fallita come incompleta quando Store incomplete executions è No. No consentirebbe sovrapposizioni: qui non serve per evitare gli incompleti, e non è consigliato per la schedulazione. Prima di cambiare queste impostazioni verifica e gestisci le incomplete executions già esistenti e i retry ancora in corso: le preferenze nuove non sono una prova che la vecchia coda sia stata svuotata. [1] [3]

Non modificare le altre preferenze: restano `maxErrors:3`, `autoCommit:true`, `autoCommitTriggerLast:true`, `roundtrips:1`, `dataloss:false`, `freshVariables:false` e `slots:null`. Non aggiungere handler alternativi, moduli email, nuovi endpoint o connessioni.

## Eliminare tutti i 61 gestori, non i moduli ordinari

Rimuovi l’intero collegamento/ramo di gestione errore tratteggiato e il relativo modulo **Retry**, chiamato **Break** nei blueprint precedenti. Non basta disattivare **Automatically complete execution**: anche Retry manuale richiede Store incomplete executions = Yes. Nel sorgente corretto c’erano 60 gestori con retry automatico e uno con retry automatico No, collegato a CreateReport. Vanno rimossi tutti. [2]

Le coppie seguenti sono **modulo ordinario da conservare → ID del gestore da eliminare**. Non eliminare il numero a sinistra. La lista riguarda il blueprint fornito; in uno scenario Make che abbia rinumerato i moduli, individua anche funzione e collegamento, non soltanto il numero.

- Ingresso e creazione: **1→20, 3→21, 4→22**. Il modulo 3 è Create a report: eliminare anche il gestore 21, benché abbia retry automatico No.
- Primo controllo del report nuovo: **24→26, 27→28, 29→30, 31→32, 33→34, 35→36, 37→38**.
- Secondo controllo del report nuovo: **40→42, 43→44, 45→46, 47→48, 49→50, 51→52, 53→54**.
- Terzo controllo del report nuovo: **56→58, 59→60, 61→62, 63→64, 65→66, 67→68, 69→70**.
- Quarto controllo del report nuovo: **72→74, 75→76, 77→78, 79→80, 81→82, 83→84, 85→86, 87→88**.
- Primo controllo del report ripreso: **90→92, 93→94, 95→96, 97→98, 99→100, 101→102, 103→104**.
- Secondo controllo del report ripreso: **106→108, 109→110, 111→112, 113→114, 115→116, 117→118, 119→120**.
- Terzo controllo del report ripreso: **122→124, 125→126, 127→128, 129→130, 131→132, 133→134, 135→136**.
- Quarto controllo del report ripreso: **138→140, 141→142, 143→144, 145→146, 147→148, 149→150, 151→152, 153→154**.

I 78 moduli ordinari rimangono: 36 HTTP verso il gestionale, 8 download HTTP, 16 chiamate Amazon di stato/documento, 8 Sleep, 9 router e 1 CreateReport. Conserva anche i normali rami DONE, CANCELLED, FATAL, PENDING e UNEXPECTED: **non sono gestori Retry**. I quattro controlli con Sleep per ciascun percorso restano invariati.

Nel JSON la rimozione è ricorsiva: non restano chiavi `onerror`, neppure vuote. Non lasciare un ramo di errore senza direttiva: la documentazione Make indica che un ramo di errore che termina senza errori può far saltare il bundle, invece di segnalare il fallimento voluto. [3]

## Conservare filtri, segreti e mapping

Se non hai già applicato la correzione dei due filtri del primo router, usa in entrambi l’operando sinistro:

```text
{{ifempty(1.data.report_id; "NONE")}}
```

Nel ramo verso **Create a report, modulo 3**, scegli **Text operators → Equal to, case insensitive**, con operando destro **NONE**. Nel ramo verso **Sleep, modulo 89**, scegli **Not equal to, case insensitive**, sempre rispetto a **NONE**. Elimina la vecchia formula `if(equal(...))`, senza aggiungere condizioni OR/AND. I confronti del JSON sono `text:equal:ci` e `text:notequal:ci`: operatori nativi, non chiamate alla funzione `equal()`. `ifempty` gestisce il valore assente o vuoto. [8] [9]

Non aprire o modificare le chiavi dei moduli HTTP durante questa correzione. I **36 moduli con `X-SoKeto-Amazon-Key`** sono:

```text
1, 4, 31, 33, 35, 37, 47, 49, 51, 53, 63, 65, 67, 69,
79, 81, 83, 85, 87, 97, 99, 101, 103, 113, 115, 117, 119,
129, 131, 133, 135, 145, 147, 149, 151, 153
```

Nel file pubblico ogni chiave è ancora soltanto **DA_CONFIGURARE**. Nessun segreto configurato in Make è stato letto o trasferito. Tutti gli altri header, array dei marketplace, connessioni, ID ordinari, endpoint, filtri, body e riferimenti sono identici al blueprint con filtri nativi corretto, prima della sola rimozione dei gestori.

Reimportare il JSON pubblico è un’alternativa per **un nuovo scenario OFF**, non il modo migliore per aggiornare quello già configurato. L’import ricostruisce moduli, impostazioni e mapping; le connessioni dell’account devono essere verificate e associate privatamente. I segreti letterali del JSON sono segnaposto: non presumere che reimportare sullo scenario esistente preservi le 36 chiavi. Non esportare lo scenario configurato per recuperarle e non inviarne schermate. [7]

## Errori normali e notifiche: nessun rollback remoto dello stock

Senza gestori e con Store incomplete executions = No, un errore effettivo di modulo ferma il run con stato **Error**, senza salvarne il bundle per la ripresa Make. La fase di rollback è il comportamento predefinito. I moduli HTTP conservano `handleErrors:true`: non è stato introdotto un comportamento che nasconde gli errori HTTP. [1] [3]

**Rollback Make non significa annullare operazioni già eseguite nel gestionale o report già creati su Amazon.** Solo i moduli con supporto transazionale ACID possono annullare modifiche e `autoCommit:true` limita ulteriormente il rollback delle operazioni precedenti. Un POST HTTP già ricevuto dal backend non viene invertito da Make; neppure un movimento stock remoto viene stornato automaticamente. La sicurezza dello stock dipende da transazioni, identità delle righe e controlli del backend, non da questi handler. [3] [4]

Non aggiungiamo moduli email. Make dispone di notifiche native per errori e disattivazioni, abilitate per default ma configurabili per organizzazione in **Profile → Email preferences**. Verifica privatamente che **Errors** e **Deactivation** siano attive: il blueprint non può confermarne lo stato o garantire la consegna. Make può inviare una prima email e poi un riepilogo degli errori. [5]

`maxErrors:3` non equivale a tre retry dello stesso bundle: è il limite di errori consecutivi della pianificazione, con eccezioni per alcune categorie che possono disattivare subito lo scenario. Non promettiamo retry automatici dell’esecuzione fallita: quelli documentati per ConnectionError e RateLimitError si appoggiano alle esecuzioni incomplete, qui disabilitate. Eventuali tentativi interni al connettore non sono verificati da questo audit. [2] [3]

## Recupero dal server e intervallo non protetto di CreateReport

La lettura locale di `server/amazon-import-routes.ts` mostra che **import-window** blocca la configurazione durante la transazione e riusa un run `requested`, `pending` o `processing` prima di creare una nuova finestra. Se quel run ha un `report_id`, il filtro sceglie il ramo di ripresa e non CreateReport. Il modulo 4 salva il nuovo ID con **report-created** immediatamente dopo la chiamata Amazon. Nessuna richiesta ai servizi o interrogazione DB è stata eseguita in questa verifica.

Il lock di import-window termina prima di CreateReport. Due esecuzioni potrebbero leggere lo stesso run con `report_id:null` e creare due report Amazon. Il lock successivo di report-created può rifiutare il secondo ID, ma arriva **dopo** la seconda creazione esterna. Una sola definizione CreateReport nel blueprint non garantisce quindi una sola creazione quando i run si sovrappongono. Per consentire concorrenza servirebbe una protezione server verificata che copra anche quella fase; non è stata aggiunta qui.

Esiste inoltre un caso ambiguo anche senza sovrapposizioni: CreateReport può riuscire, ma il relativo ID può andare perso prima del salvataggio sul server. Se il modulo 3 va in timeout, oppure il modulo 4 fallisce e il server conserva `report_id:null`, **non rilanciare alla cieca**: occorre prima riconciliare privatamente lo stato del report/run. Questa guida non autorizza nuove scritture o una riassociazione manuale. Se invece l’ID è già salvato, il successivo Run once autorizzato parte dall’import-window e può riprendere quello stesso report.

Dopo un upload fallito o una risposta persa, il recupero dipende dallo stato realmente persistito. Nel servizio esaminato il documento già acquisito è riconosciuto da digest, report ID e document ID; un replay diverso è rifiutato. Non presumere però che un run già concluso venga riproposto dall’import-window, né che il checkpoint debba restare identico dopo qualsiasi timeout: il server può aver già completato la richiesta. La revisione del checkpoint e dei casi terminali è separata da questa modifica documentale.

Se il report rimane pending dopo quattro controlli, il normale endpoint report-status registra POLLING_EXHAUSTED; il prossimo avvio autorizzato può ripartire dal report salvato. CANCELLED, FATAL e stato inatteso non sono prove di “zero vendite”: i relativi rami ordinari restano presenti e non avanzano automaticamente il checkpoint nella route esaminata.

### Rinnovare un URL firmato scaduto

L’URL restituito da **getReportDocument** scade dopo **cinque minuti**. Non va salvato o reinviato al gestionale. Con questa correzione non si riprende un download incompleto dal vecchio bundle Make: un nuovo Run once autorizzato riparte dal modulo 1 e, se il report salvato è ancora recuperabile e DONE, richiama **getReportDocument** per ottenere un URL aggiornato prima del download. Non riprovare direttamente il solo vecchio Get a file con l’URL scaduto. [6]

Nel primo percorso di ripresa la catena è **90 → 93 → 95 → 97**: stato report, metadati documento, download, invio al gestionale. Non abbiamo aggiunto nuovi moduli per il rinnovo.

## Modulo 97: audit statico riservato, non diagnosi del payload reale

Il modulo **97** è il POST a `/api/marketplace/amazon/report-file` nel primo controllo del ramo di ripresa. Nel blueprint controllato il contratto è coerente:

```text
Method: post
Body type: raw
Content type: text/plain
Request content / data: {{95.data}}
Parse response: false

X-SoKeto-Amazon-Key: DA_CONFIGURARE soltanto nel file pubblico
X-Amazon-Import-Run-Id: {{1.data.run_id}}
X-Amazon-Report-Id: {{1.data.report_id}}
X-Amazon-Report-Type: GET_FLAT_FILE_ALL_ORDERS_DATA_BY_LAST_UPDATE_GENERAL
X-Amazon-Window-Start: {{1.data.window_start}}
X-Amazon-Window-End: {{1.data.window_end}}
X-Amazon-Processing-Status: {{90.body.processingStatus}}
X-Amazon-Marketplace-Ids: APJ6JRA9NG5V4,A1PA6795UKMFR9,A13V1IB3VIYZZH,A1RKKUPIHCS9HS,A1F83G8C2ARO7P
X-Amazon-Import-Policy: FBM_SHIPPED
X-Amazon-Report-Document-Id: {{90.body.reportDocumentId}}
X-Amazon-Compression-Algorithm: {{ifempty(93.body.compressionAlgorithm; "NONE")}}
X-Amazon-Body-Format: ORIGINAL_REPORT_DOCUMENT
```

Controlla i **riferimenti**, non condividere i valori risolti. Run ID e report ID provengono da import-window; il document ID proviene da getReport, modulo 90. Non scambiare report ID con document ID. Il documento 93 usa quel document ID e il download 95 usa `93.body.url`. La compressione proviene da **93**, non dal download e non dal nome del file. La chiave resta la stessa configurata privatamente, senza ricopiarla in chat.

Il backend legge gli header direttamente con `req.get(...)`, senza un JSON di metadati nel body. `data:{{95.data}}` deve essere un mapping al campo **Data** del download, non la stringa letterale delle parentesi, il nome del file, l’URL, il bundle completo o `{"data":...}`. Se un percorso `body.reportDocumentId` non è quello realmente restituito dal connettore, correggerlo richiede una verifica privata del tipo/schema: il solo test degli ID esistenti non prova che quel campo sia popolato nel runtime.

Per **GZIP** il body deve conservare i byte GZIP originali; per **NONE** deve contenere il documento originale non compresso con intestazioni TSV/CSV. Il tipo `text/plain` non prova che il body sia già testo decompresso. Amazon documenta anche `enableContentEncodingUrlHeader`: se abilitato, il client può decomprimere automaticamente tramite Content-Encoding. Il blueprint lascia `qs:[]` e `useNewZLibDeCompress:false` nei download, ma queste impostazioni non sono una prova di integrità dei byte nel runtime Make. La documentazione HTTP legacy descrive body Raw; non certifica da sola il trasporto byte-per-byte di questo report. Non sostituire con multipart: la route attuale richiede un body raw, non una busta multipart. [6] [10]

Sono casi di mismatch da distinguere: header obbligatorio assente o mapping letterale; report/document ID scambiati; stato diverso da DONE; algoritmo GZIP con testo già decompresso; algoritmo NONE con bytes GZIP; body vuoto, JSON, HTML/XML d’errore da URL scaduto, o testo del token invece del documento. Un errore del download non deve essere inoltrato come TSV. **Non è stato identificato il caso effettivo della prova utente:** non sono stati aperti input/output Make, documenti Amazon, URL firmati o dati di produzione.

Per la prossima verifica autorizzata, mantenendo la riservatezza, registra solo orario, ID del modulo, stato HTTP e un codice diagnostico server sanificato se disponibile. Non pubblicare messaggi d’errore arbitrari, payload, intestazioni compilate, righe ordine o URL firmati. Non disattivare Keep data confidential per ottenere una schermata. Il dry run non abilita scarichi stock, ma una prova può comunque creare report Amazon e salvare run, osservazioni o altri metadati: non equivale a “nessuna scrittura”. Nessuna prova è stata effettuata durante questo intervento.

## Controlli locali ripetibili

Sono passati **26 test offline**: i 6 controlli dei filtri nativi copiati dal relativo branch e 20 controlli nuovi. Verificano preferenze, assenza ricorsiva dei gestori, 78 ID ordinari, 36 chiavi segnaposto, integrità di tutti gli header e del flusso normale, errori HTTP non ignorati, polling conservato, rinnovo dei metadati prima del download, contratti di tutti gli otto upload e contratto esatto del modulo 97.

I casi sintetici aggiuntivi rilevano mismatch di header, body, codifica e compressione senza usare valori esterni. Sono esempi contrattuali deterministici: non chiamano il parser di produzione, non eseguono formule Make e non dimostrano né consegna reale né sicurezza concorrente. Le impronte SHA-256 nei test derivano esclusivamente dal JSON pubblico corretto; non richiedono che l’altro worktree esista per rieseguire i controlli.

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover \
  -s docs/make -p 'test_blueprint_*.py' -v
```

File: [test dei filtri nativi](test_blueprint_native_filters.py) e [test del recupero senza Retry](test_blueprint_recovery_without_retry.py). Il confronto strutturale con il sorgente nativefilters conferma che le sole variazioni sono la rimozione di `onerror` e le preferenze richieste; `confidential` era già true. L’aggiornamento locale non modifica lo scenario Make esistente. Non sono stati effettuati commit, push, merge, deploy, modifiche Vercel, accessi a segreti o scritture ai servizi di produzione.

## References

Fonti ufficiali consultate il 6 novembre 2026. Autore: Manus AI.

[1]: https://help.make.com/scenario-settings "Make — Scenario settings: riservatezza, ordine e incomplete executions"
[2]: https://help.make.com/retry-error-handler "Make — Retry error handler e requisito di incomplete executions"
[3]: https://help.make.com/overview-of-error-handling "Make — Errori predefiniti, transazioni e limiti di disattivazione"
[4]: https://help.make.com/rollback-error-handler "Make — Rollback limitato ai moduli con supporto transazionale"
[5]: https://help.make.com/manage-your-email-preferences "Make — Notifiche native per errori e disattivazioni"
[6]: https://developer-docs.amazon/sp-api/reference/getreportdocument "Amazon — GetReportDocument, scadenza URL e compressione"
[7]: https://help.make.com/blueprints "Make — Importazione blueprint e connessioni private"
[8]: https://help.make.com/general-functions "Make — Funzioni ifempty e switch"
[9]: https://help.make.com/filtering "Make — Filtri e operatori nativi"
[10]: https://apps.make.com/http-legacy "Make — Modulo HTTP legacy e body Raw"
