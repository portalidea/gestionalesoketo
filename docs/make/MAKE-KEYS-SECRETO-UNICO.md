# Amazon SoKeto: una sola chiave in Make Keys

Il nuovo blueprint usa **HTTP legacy v3 → Make an API Key Auth request** nei 36 moduli rivolti al gestionale. La chiave non è più un valore di header nel JSON: ogni modulo riferisce la stessa credenziale custodita in **Make Keys**. Non abbiamo introdotto HTTP v4, variabili contenenti il segreto, Retry o esecuzioni incomplete. Il cambio di modulo e `parameters.auth` derivano da un export reale, non da nomi inventati. [1] [2] [6]

La diagnostica server autorizzata è in produzione: commit `3909781`, merge `67e0cb444a9397e22c29277becf6e83f7d221206`, deploy Vercel riuscito **6 novembre 2026 alle 14:25:23, Europe/Rome**. `/api/health` risponde 200; il gateway senza chiave risponde 401 con `errorCode: UNAUTHORIZED`, senza aprire import.

**Nessuno scenario Make è stato modificato, avviato o cancellato durante questo lavoro.** I blueprint sono verificati offline, non ancora importati/collaudati nell’account dell’utente. Dry run del gestionale deve rimanere ON e schedulazione Make OFF durante la sostituzione.

## File da scaricare

Scarica [SoKeto-Amazon-Make-Keys.zip](SoKeto-Amazon-Make-Keys.zip) dalla pagina GitHub usando **Download raw file**, poi estrailo in una sola cartella, per esempio `~/Downloads/soketo-amazon-make`.

Il pacchetto contiene:

- [AmazonOrdiniGiornalieriEU-SoKeto.blueprint.json](AmazonOrdiniGiornalieriEU-SoKeto.blueprint.json): collector completo, con 36 riferimenti Keys **non ancora associati**.
- [CollegaChiaveMake-SoKeto.blueprint.json](CollegaChiaveMake-SoKeto.blueprint.json): piccolo scenario con un solo modulo API key, destinato soltanto a selezionare la credenziale. La sua URL è `/api/health`, non un endpoint che crea finestre.
- [collega_chiave_make.py](collega_chiave_make.py): utility locale che associa l’unico riferimento Keys ai 36 moduli. Non chiede il segreto, non chiama Make o il gestionale, non stampa identificativi.
- Questo LEGGIMI e una copia breve delle istruzioni di accesso.

Nel JSON pubblico `auth: 0` significa **credenziale da associare**, non una chiave reale. Non eseguirlo così. Make non documenta che selezionare una chiave in un modulo la propaghi automaticamente agli altri 35: l’utility evita di affidarsi a quella ipotesi. [4]

## 1. Metti al sicuro le vecchie incomplete executions

1. Mantieni il vecchio collector Amazon **OFF**. Non attivarlo per sbloccare gli incompleti e non premere Retry/Resolve.
2. Apri **Incomplete executions** del solo vecchio collector. Controlla gli stati. Se esiste un elemento **In progress**, non avviare il nuovo scenario in parallelo: attendi che termini e verifica l’esito nel gestionale.
3. Prima di cancellare, conserva privatamente solo le informazioni necessarie: data del tentativo, report ID, modulo fallito e codice errore, se presente. **Non esportare o condividere il vecchio blueprint con i 36 segreti in chiaro**, né payload o URL firmati.
4. Per i tentativi di prova già falliti, quando non ci sono retry in corso, seleziona gli elementi **Unresolved/Pending** e usa **Delete selected**. Make dichiara questa cancellazione irreversibile. Se trovi esecuzioni estranee alla prova Amazon o un esito nuovo, non cancellarle alla cieca. [3]

La cancellazione degli incompleti elimina i bundle di Make; **non annulla POST, report Amazon o dati già salvati nel gestionale**. La fotografia read-only delle 13:38 mostrava report `213175020763`, run pending, documento non persistito, zero righe e zero allocazioni. Il recupero del report avviene dal checkpoint del gestionale, indipendente dall’ID scenario Make. Se nel frattempo hai eseguito altri tentativi, va verificato lo stato aggiornato prima di considerarli eliminabili.

Non riprendere una vecchia incomplete execution a partire dall’upload: Make riusa configurazione e input originari, incluso un eventuale URL firmato scaduto. Il nuovo collector riparte da import-window e richiede nuovamente il documento quando il report è pronto. [3]

## 2. Crea la chiave una sola volta e selezionala in un solo modulo

1. In Make crea un **nuovo scenario temporaneo**, denominato per esempio “SoKeto — collegamento Key — NON eseguire”. Mantienilo OFF.
2. Nel builder apri **⋯ → Import blueprint** e importa `CollegaChiaveMake-SoKeto.blueprint.json`. [4]
3. Apri l’unico modulo **HTTP legacy → Make an API Key Auth request**. Nel campo **Credentials**, scegli **Add** per creare la keychain. Se la chiave esiste già, selezionala invece: non crearne una seconda.
4. Compila privatamente:
   - **Name:** un nome riconoscibile, per esempio `SoKeto Amazon Gateway`.
   - **Key:** il segreto già configurato in `AMAZON_IMPORT_WEBHOOK_KEY` su Vercel. Incollalo qui **una sola volta**; non aggiungere `Bearer`, virgolette o spazi.
   - **API key placement:** **In the header**.
   - **API key parameter name:** `X-SoKeto-Amazon-Key`.
5. Salva la credenziale e il piccolo scenario. **Non premere Run once.** Verifica le tre impostazioni: **Keep data confidential Yes**, **Store incomplete executions No**, **Process data in order Yes**.
6. Esporta soltanto questo piccolo scenario: **⋯ → Export blueprint**. Salva il file nella cartella estratta, rinominandolo `chiave-make.privato.blueprint.json`.

L’export API key contiene il **riferimento** alla Key, non la sua stringa segreta dentro gli header. Mantieni comunque l’export privato: non allegarlo in chat o pubblicarlo. La credenziale è gestita in **Credentials → Keys**; il vecchio layout può chiamare la voce semplicemente **Keys**. Make documenta che modificarla aggiorna tutti i moduli che la usano. Non serve editarli per una rotazione del valore. [1] [2]

Se in futuro cambi il valore segreto, aggiorna anche **AMAZON_IMPORT_WEBHOOK_KEY su Vercel, ambiente Production**, e applicalo con redeploy: il valore lato server deve coincidere con quello nell’unica Make Key, altrimenti il gateway risponde 401. Se aggiorni soltanto il blueprint, invece, non occorre ruotare il segreto.

Questo lavoro non ha verificato dal vivo il numero di asterischi mostrati nel dialog di modifica: la protezione usata è la custodia Keys, non un campo header o una variabile mascherata solo graficamente.

## 3. Collega la Key ai 36 moduli senza digitare ID o segreti

Sul Mac serve **Python 3** per la piccola utility; non occorrono pacchetti Python o installazioni di librerie. Se `python3 --version` non è disponibile, non eseguire download/installazioni alla cieca: resta disponibile la selezione della stessa Key nei moduli, senza reinserire il valore, oppure chiedi assistenza per la utility.

Apri Terminale e, adattando soltanto il percorso se hai scelto un’altra cartella, esegui:

```sh
cd "$HOME/Downloads/soketo-amazon-make"
python3 collega_chiave_make.py \
  --export-chiave chiave-make.privato.blueprint.json \
  --output Amazon-Giornaliero-Keys.privato.blueprint.json
```

L’utility legge dal piccolo export solo il riferimento numerico della credenziale e costruisce l’output dal **template pubblico**, non dai moduli o dai dati privati dell’export. Associa la stessa Key ai 36 moduli, lasciando invariati tutte le altre impostazioni. Non legge variabili Vercel e non riceve il valore della chiave. Il nuovo file locale viene creato con permessi privati, senza sovrascrivere input o file già esistenti.

Se ricevi “esattamente una keychain API key selezionata”, riapri il piccolo scenario e seleziona/salva la credenziale, poi riesportalo. Non correggere il JSON aggiungendo manualmente il segreto. Il file finale contiene un ID privato di credenziale: **non pubblicarlo nel repository e non condividerlo**.

## 4. Importa il collector completo nel nuovo scenario

1. Crea un secondo **nuovo scenario**, denominato per esempio “Amazon giornaliero SoKeto — Keys”. Mantienilo OFF. Non sovrascrivere il vecchio e non attivare la schedulazione.
2. Importa **il file locale generato** `Amazon-Giornaliero-Keys.privato.blueprint.json`, non il template pubblico non associato.
3. Nei moduli Amazon seleziona/verifica la connessione Amazon Seller Central esistente. Il blueprint non include nuove credenziali Amazon né connessioni Google Sheets.
4. I 36 moduli API key hanno già la stessa Key nel JSON. Verifica che Make mostri il nome della tua credenziale; se l’import avviene in un’altra organizzazione/team o Make richiede una riassociazione, scegli la Key esistente nel campo Credentials. **Non incollare il valore negli header.** Non promettiamo una propagazione implicita del primo menu agli altri moduli.
5. Salva e controlla esplicitamente:
   - **Keep data confidential = Yes**.
   - **Store incomplete executions = No**.
   - **Process data in order = Yes**.
   - **Scheduling = OFF**.
   - Gestionale `/marketplace/amazon`: **dry run ON**, cutoff acquisto **2026-09-01**, store Amazon E-Keto corretto.
6. Non cambiare compressione, body raw, riferimenti report o filtri per tentativi. Le 8 richieste agli URL firmati Amazon rimangono **senza** la Key SoKeto; non devono riceverla.

Gli unici cambiamenti del collector sono il tipo API-key-auth dei 36 moduli, il riferimento Keys e la rimozione dei campi di autenticazione generici vuoti e dell’header segreto manuale. Conservati ID, URL, 8 download, corpo raw, metadati di compressione, filtri, polling e checkpoint. `handleErrors` resta true: un errore ferma il run, non viene nascosto. **37 controlli offline superati**, incluso confronto del flusso normalizzato con il precedente e mancata copia di dati dall’export privato. L’importazione e il comportamento Make corrente devono ancora essere verificati nell’account dell’utente.

## 5. Collaudo e rimozione del vecchio scenario

Prima di una prova controllata, verifica che il vecchio scenario sia OFF, nessun retry sia In progress e il nuovo abbia tutte le impostazioni sopra. Non attivare l’orario giornaliero durante il collaudo. Quando scegli di eseguire il nuovo **Run once**, usa solo questo collector, con dry run ON; poi controlliamo il riepilogo read-only e gli eventuali nuovi codici diagnostici.

**Rimuovi il vecchio collector soltanto dopo aver validato il nuovo.** In **Scenarios**, menu **⋯** accanto al vecchio collector → **Move to trash** → conferma. La documentazione corrente Make prevede 30 giorni nel cestino prima della cancellazione permanente. Non toccare lo scenario mensile storico 9129116 se è un oggetto diverso dal collector che sostituisci, né connessioni Amazon o la Key condivisa. Puoi spostare nel cestino anche il piccolo scenario temporaneo dopo il collegamento. [5]

Elimina i due export locali privati quando non ti servono più, oppure custodiscili solo localmente. Il template pubblico e l’utility rimangono riutilizzabili: per il prossimo aggiornamento ricrei il file collegato con lo stesso export di riferimento Keys, **senza riscrivere il segreto e senza cancellare gestori manualmente**. La schedulazione giornaliera rimane una decisione separata, dopo una prova valida.

## References

[1]: https://apps.make.com/http-legacy "Make — HTTP legacy e API Key Auth request"
[2]: https://help.make.com/keys-and-certificates "Make — Custodia Keys e aggiornamento centralizzato"
[3]: https://help.make.com/manage-incomplete-executions "Make — Stati, retry e cancellazione irreversibile degli incompleti"
[4]: https://help.make.com/blueprints "Make — Importazione, esportazione e riassociazione delle credenziali"
[5]: https://help.make.com/delete-a-scenario "Make — Spostamento di uno scenario nel cestino"
[6]: https://community.make.com/t/api-get-token-with-privatekey-publickey/15482 "Make Community — Export reale API Key Auth legacy v3"
