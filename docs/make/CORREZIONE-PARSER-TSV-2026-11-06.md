# SoKeto — correzione parser TSV Amazon e quarantena per riga

## Stato del rilascio

L’hotfix è preparato sul branch dedicato `fix/amazon-tsv-row-quarantine`. Nessun push, merge o deploy senza autorizzazione. Il blueprint, Make Keys e le impostazioni dello scenario non cambiano. Non serve una migration: i metadati usano il JSONB delle osservazioni già previsto dalla 0051; l’unica variazione Drizzle è il tipo TypeScript del JSON, non una colonna o un vincolo SQL.

## Diagnosi read-only della prova indicata

La diagnostica di produzione contiene `DOCUMENT_ROW_INVALID`, fase `document`, numero riga **29**. Il run è `pending`, entrambi i controlli di corrispondenza report/documento sono `true`, l’hash del documento è `NULL` e le osservazioni persistite sono **0**.

La versione precedente conservava solo `rowNumber`, non `expectedColumns`, `actualColumns` o il campo problematico. Questi dettagli non sono recuperabili dal DB per il tentativo passato; non si attribuisce quindi alla riga 29 un conteggio colonne inventato. Il vecchio parser trattava i doppi apici come quoting CSV: è un difetto certo di compatibilità con il TSV Amazon, ma da solo non prova il contenuto della riga ricevuta.

Non sono stati letti né esposti dati cliente e non è stato modificato alcun dato di produzione.

## Comportamento corretto

Il parser accetta il formato Amazon **TSV senza quoting**. Tab e newline separano sempre campi e righe fisiche. Le virgolette sono caratteri ordinari, incluse quelle non accoppiate o ripetute. Sono gestiti BOM UTF-8, LF, CRLF e CR; il solo terminatore finale non crea una riga aggiuntiva. Una riga vuota interna conserva la propria posizione ed è isolata se non ha le colonne richieste.

Il numero colonne viene confrontato con l’intestazione **prima di mappare gli identificativi**. Le righe con colonne mancanti o aggiuntive vanno in `review_required` / **Da verificare**. Per queste righe non vengono dedotti ordine, articolo o SKU e non vengono salvati i valori ricevuti: soltanto il numero riga, il codice diagnostico, il campo statico `column-count` e i conteggi atteso/trovato. Non producono articoli marketplace, allocazioni FEFO o movimenti.

Anche valori di riga non interpretabili — date, identificativi oltre limite, importi — vengono isolati senza bloccare le righe valide. Una data acquisto invalida non può diventare una falsa data precedente al cutoff; le righe realmente pre-cutoff restano ignorate e tracciate, come da specifica iniziale. Date non affidabili non vengono usate per aggiornare articoli già noti.

Le righe valide continuano nell’import e nel dry run. L’import può completarsi con righe da verificare: il checkpoint non resta bloccato da una singola riga strutturale. Queste osservazioni restano consultabili e non vengono scaricate automaticamente.

Intestazioni obbligatorie mancanti, duplicate o con nomi vuoti restano errori documentali bloccanti. Restano inoltre le protezioni esistenti sul trasporto: formato/compressione, UTF-8 valido, byte NUL, dimensione massima e limite di 2.000 righe. Non vengono allentate per accettare un file non sicuro.

## Consultazione in admin

In `/marketplace/amazon`, scegliere il run e premere **Visualizza righe**. La tabella mostra **Riga N del file**, esito e motivo; per una riga strutturale mostra **Colonne attese: X; trovate: Y**. I dettagli sono filtrati tramite una lista chiusa: nessun valore delle celle, messaggio SQL, credenziale o payload cliente compare nella diagnostica. Le osservazioni sono ordinate per numero fisico di riga.

## Prossima prova

Non occorre modificare o reimportare Make e non occorre chiudere il run nel DB. Dopo il deploy autorizzato dell’hotfix, un solo **Run once** può riprendere il report `pending` tramite il checkpoint del gestionale. Confermare prima **dry run ON**. Il digest del documento e il vincolo run/riga impediscono doppie osservazioni nei retry dello stesso documento; i controlli d’identità e di replay restano attivi.

Il valore del segreto resta soltanto nella credenziale Make Keys e nelle variabili server; non va inserito in chat o nel repository.

## Verifiche

Sono coperti: virgolette normali/ripetute/non accoppiate; BOM e CRLF; numero fisico 29; colonne in meno/in più; righe valide prima e dopo una riga invalida; data invalida senza falso pre-cutoff; intestazione invalida senza persistenza del documento; upload HTTP misto accettato; quarantena persistita; piano dry run delle sole righe valide; stock e ledger invariati; replay senza doppioni; filtraggio dei metadati e presentazione admin.

Risultati verificati:

- `pnpm check`: PASS.
- TypeScript strict dei test nuovi e modificati: PASS.
- `pnpm run testdb:regression`: PASS; 40 file Vitest superati, 3 saltati; 298 test superati, 12 saltati, più gli script standalone del runner.
- `pnpm build`: PASS; artefatto `api/index.js` generato ripristinato e non incluso nel commit.
- `git diff --check`: PASS.

Le prove PostgreSQL sono state eseguite soltanto su `127.0.0.1:55432`, con `prepare:false` e credenziali fittizie per i servizi esterni. Nessuna esecuzione Make o scrittura su Supabase di produzione.
