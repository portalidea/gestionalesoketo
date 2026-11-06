# SoKeto — acquisizione durevole e lotti Amazon (0052)

Implementazione locale sul branch `fix/amazon-durable-batch-processing`, 6 novembre 2026. Nessun push, merge, deploy, avvio Make o modifica ai dati di produzione.

## Tentativo di produzione dopo il timeout

Lettura Supabase del 6 novembre alle 17:33 Europe/Rome: run `pending`, report atteso corrispondente, documento non acquisito (digest e ID documento non persistiti), 0 osservazioni, 0 righe in revisione e 0 allocazioni di stock. Dry run attivo sul run e sulla configurazione; import abilitato. La finestra è settembre, dalle 00:00 del 1 settembre alle 00:00 del 1 ottobre Europe/Rome.

L’ultima diagnostica salvata è il precedente `DOCUMENT_ROW_INVALID`, delle 14:53:55 Europe/Rome. Non è un nuovo errore del tentativo in timeout. Il DB attuale non registra inizio/fine della sua elaborazione: non permette di misurare la durata del documento di settembre né di attribuire con certezza l’interruzione a Make o a Vercel. L’assenza di acquisizione e osservazioni dimostra che non risulta un completamento committato dopo il timeout.

## Limiti Vercel e percorso corretto

`api/index.js`, dove è montato Amazon, è configurata per 60 secondi in `vercel.json`; Make attende 40 secondi. Questi valori non sono stati alzati. Su Hobby con Fluid Compute il limite/default del piano è 300 secondi, ma una configurazione esplicita più bassa resta applicabile; sul modello Hobby legacy il massimo configurabile è 60 secondi. L’attivazione effettiva di Fluid sul progetto non è stata verificata. [1] [2]

Il vecchio endpoint acquisiva documento, righe e osservazioni in un’unica transazione. Il nuovo `POST /api/marketplace/amazon/report-file` valida il documento e salva nel DB i byte originali e i metadati prima di rispondere **202 Accepted**. Non crea osservazioni, ordini marketplace, movimenti o avanzamento del checkpoint. La validazione locale dell’intestazione/formato resta prima del salvataggio; un 202 non significa elaborazione completata.

Ripetere lo stesso report/documento e gli stessi byte restituisce 202 se ancora in coda, 200 se completato, senza rielaborare o azzerare il cursore. Report, documento o contenuto in conflitto vengono rifiutati con la diagnostica sicura esistente. Gli import legacy già acquisiti non vengono riscritti retroattivamente.

## Elaborazione separata e ripresa

`POST /api/marketplace/amazon/process-batch` usa l’autenticazione Make già esistente. `amazon.processBatch` è l’azione staff della pagina admin. Una chiamata usa 5 righe e un budget cooperativo di 12 secondi; il budget viene controllato fra le righe/operazioni, con timeout SQL locali e lock brevi. Non viene interrotta arbitrariamente una transazione a metà. I passi finali di commit/metadati possono aggiungere un breve overhead.

Ogni lotto committa osservazioni, righe e cursore insieme. Una nuova invocazione riprende il cursore committato. I vincoli univoci e i lock configurazione-prima impediscono doppie osservazioni e doppi scarichi. Le righe strutturalmente invalide e i problemi dati/constraint confinati a una riga sono isolati in revisione; gli errori infrastrutturali lasciano il cursore invariato. Il tempo worker salvato è la somma dei passi committati, non il tempo HTTP di acquisizione e non il tempo di attesa fra i lotti.

Non viene elaborato stock finché tutti i documenti già acquisiti dello store non hanno completato l’ingestione. In questo modo una cancellazione più avanti nel file può aggiornare lo stato prima dello scarico. Restano invariati cutoff, identità venditore/ordine/articolo, FBM/FBA/sconosciuti, dry run, multipack, FEFO e divieto di stock negativo.

La nuova tabella `amazon_import_documents` conserva il contenuto soltanto per il backend, con RLS senza policy client. Il payload è immutabile, il cursore non può arretrare e il router admin espone soltanto metadati, mai i byte/base64. Il limite già esistente di 2.000 righe rimane. Il limite d’ingresso Vercel di 4,5 MB resta più basso del limite difensivo di storage del DB: questa correzione non risolve upload sopra il limite di piattaforma. [3]

## Pagina admin, cron e Make

In `/marketplace/amazon` compaiono acquisizione, righe ingerite/totali, fase stock, completamento, tempo worker e codici di errore. “Elabora prossimo lotto” avvia una sola chiamata. “Avvia elaborazione a lotti” richiede conferma e ripete richieste sequenziali con un secondo di pausa finché resta lavoro. “Pausa”, cambio store o chiusura pagina fermano soltanto le chiamate successive; il lotto già inviato può completare la propria transazione. Aprire la pagina non avvia elaborazione.

Il recupero `/api/cron/amazon-processing`, autenticato tramite `CRON_SECRET` già previsto dai cron, è aggiunto alle 06 UTC una volta al giorno. Il lavoro è limitato e riprendibile. Su Hobby il cron può essere invocato durante l’ora prevista, è best effort e non ritenta automaticamente i fallimenti: è un recupero lento, **non una garanzia di svuotare subito tutto settembre**. Per la prima prova ampia si usa l’azione sequenziale dalla pagina, mantenendola aperta. Il progresso già salvato sopravvive alla chiusura della pagina. [4] [5]

**Make non richiede modifiche, reimportazione o nuove Keys** per acquisire il 202. Il suo modulo POST continua a inviare lo stesso file e gli stessi metadati. Non sono stati modificati blueprint, timeout HTTP, scenario o segreti. Dopo l’acquisizione bisogna verificare la fase distinta di elaborazione nel gestionale; per uno svuotamento totalmente automatico e immediato di backlog grandi servirebbe un dispatcher più frequente della capacità cron Hobby, da concordare separatamente.

## Verifiche concluse

- Core PostgreSQL: 38/38 (15 test nuovi durevoli e 23 invarianti Amazon esistenti).
- Gateway, checkpoint, cron e presentazione: 56/56.
- Regressione completa su PostgreSQL isolato porta 55432: `TESTDB_REGRESSION=PASS`, 338 test Vitest passati in 43 file. Restano 12 test preesistenti saltati in 3 file: `routers.test.ts`, `retailer-details.test.ts`, `auth.logout.test.ts`. Tutti gli script standalone del runner hanno completato.
- `pnpm check`, TypeScript strict anche dei nuovi test, `pnpm build`, `git diff --check`: PASS. `api/index.js` ripristinato, nessun artefatto build versionato.
- Migration 0052 e `VERIFICA-0052.sql` applicati/eseguiti soltanto sul DB isolato. Nessuna migration applicata autonomamente su Supabase.

Sono state corrette due assunzioni nei soli test standalone: il test catalogo percorre tutte le pagine anziché cercare la fixture nei primi dieci risultati; quello prospect verifica esplicitamente due fixture visibili e l’esclusione della fixture hidden anziché imporre un conteggio globale di due prodotti. Nessuna logica del catalogo o del prospect è stata cambiata.

Copertura nuova: acquisizione senza lavoro righe/stock/checkpoint; replay 202 e 200; conflitti contenuto/report/documento; ripresa dopo riconnessione; cursore e osservazioni atomici; consumatori concorrenti; cancellazione tardiva nel file; quarantena strutturale e overflow aggregato; zero righe; import disabilitato; gate globale prima dello stock; GZIP; legacy; limiti; autorizzazione cron/staff e privacy. Un lock configurazione trattenuto fa fallire l’acquisizione in circa 764 ms nel test locale, senza scritture parziali. Non è una misura della latenza del deployment reale.

## Sequenza prima del rilascio

1. L’utente applica manualmente la 0052 e verifica con `VERIFICA-0052.sql`.
2. Solo dopo conferma/OK: push del branch, merge e deploy.
3. Mantieni dry run ON e nessuna schedulazione Make attiva. Dopo READY: un solo Run once acquisisce il documento con 202.
4. In Amazon avvia i lotti in prova e controlla avanzamento, righe in revisione e piano FEFO. Non disattivare il dry run senza il controllo e l’autorizzazione dell’utente.

## References

[1]: https://vercel.com/docs/functions/configuring-functions/duration "Vercel: durata delle funzioni"
[2]: https://vercel.com/docs/fluid-compute "Vercel: Fluid Compute e precedenza configurazione"
[3]: https://vercel.com/docs/functions/limitations "Vercel: limiti payload e funzioni"
[4]: https://vercel.com/docs/schedules/cron-jobs/usage-and-pricing "Vercel: cron Hobby e frequenza giornaliera"
[5]: https://vercel.com/docs/cron-jobs/manage-cron-jobs "Vercel: errori, concorrenza e assenza di retry cron"
