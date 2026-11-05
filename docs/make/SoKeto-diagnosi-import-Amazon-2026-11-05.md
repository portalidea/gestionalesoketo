Il percorso **Make → webhook del gestionale → ordini marketplace → scarico FEFO E-Keto** è adatto a questa prima fase, senza introdurre subito un’integrazione Amazon SP-API diretta. Non è però sicuro copiare l’attuale import Shopify così com’è: il controllo dei duplicati non copre lo scarico concorrente e i retry possono riscaricare righe già elaborate. Inoltre, nel database verificato non risultano ancora uno store Amazon o varianti dedicate a uno store Amazon.

Diagnosi svolta il **5 novembre 2026**, sul codice `main` al commit `bd09d373256477739e5f39f4d1c6acc862abd5c4` e con sole query SELECT sul progetto Supabase `aejwoytoskihmtlgtfaz`. Aggiornata dopo la ricezione del blueprint mensile e di `AmazonVenditeReport.xlsx`. Nessun codice del gestionale o dato operativo modificato; nessun import, retry, cron o scenario Make eseguito. È stato preparato un nuovo blueprint locale, non attivato e non collaudato dal vivo in Make.

## Come funziona oggi Shopify

### Orari, finestre e data di partenza

`vercel.json` configura `/api/cron/dispatcher` una volta al giorno con `0 5 * * *`: **05:00 UTC, ossia 06:00 italiane in inverno e 07:00 in estate**. I cron Vercel utilizzano sempre UTC. [1] [2]

È emerso un disallineamento importante: il build di produzione compila `vercel-handler/index.ts`, che monta FiC e tRPC ma **non monta le route cron**. Queste sono montate soltanto nel server Node tradizionale. La configurazione dell’orario non dimostra quindi che la sincronizzazione giornaliera sia operativa nell’handler distribuito. Non ho chiamato il dispatcher per verificarlo, perché potrebbe eseguire scarichi e altri aggiornamenti: sarebbe contrario alla diagnosi read-only. [3]

Quando il servizio giornaliero viene invocato, seleziona tutti gli store Shopify attivi. La prima finestra parte dalla mezzanotte Europe/Rome di `orderImportStartDate`; le successive ripartono da `lastSyncAt` meno 48 ore, senza scendere sotto la data iniziale. Se il ritardo supera sette giorni, il recupero automatico si blocca e richiede intervento manuale. Scarica pagine da 50 ordini, filtrando **ordini pagati per data di creazione**, non soltanto ordini spediti del giorno. [4]

Esistono anche una sincronizzazione manuale, normalmente sulle ultime 24/48 ore, e una route legacy che cerca ordini delle ultime sei ore. La periodicità “ogni sei ore” della route legacy è un commento, non uno scheduler verificato. I percorsi condividono `lastSyncAt`, ma hanno regole differenti di aggiornamento del watermark. [4] [5]

**Valori reali letti in produzione:** l’unico store è `5b686d-2.myshopify.com`, company **SoKeto Srl**, attivo, con cutoff **28/08/2026**. L’ultima sincronizzazione salvata è il **03/09/2026 alle 17:33:39,963, ora italiana**. Sono presenti cinque ordini Shopify: uno elaborato, due Parziali e due saltati. Non risultano import successivi al 3 settembre nelle tabelle marketplace verificate. Questo dato è coerente con la criticità del dispatcher, ma non dimostra da solo quale sia stata la causa di ogni mancata esecuzione.

### Idempotenza: ordine e scarico non sono la stessa garanzia

La testata ha un vincolo univoco su `(storeId, channelOrderId)`: un secondo import sequenziale dello stesso ordine viene riconosciuto come duplicato. Testata e righe sono inserite insieme in transazione. Il duplicato, però, non aggiorna le righe o lo stato esterno: un ordine già presente non acquisirebbe automaticamente spedizioni successive. [4] [6]

Lo scarico avviene in una seconda transazione. Il controllo “già elaborato” è esterno alla transazione di scarico e non viene rivalidato sotto un lock della testata. I lock sui lotti proteggono la giacenza, ma non impediscono a due worker di scaricare lo stesso ordine in successione. Un’interruzione dopo l’import può inoltre lasciare un ordine `pending`. **Il solo vincolo sull’ID ordine non soddisfa quindi il requisito Amazon “mai due scarichi”.** [4]

### SKU, multipack e FEFO

La mappatura è `channel_variants`, distinta per store e SKU. Per una variante semplice la quantità interna fotografata nell’ordine è:

`quantità venduta nel canale × multiplier`

Il codice non moltiplica separatamente per `products.piecesPerUnit`. Nello schema `multiplier` significa già **pezzi interni per unità canale**, mentre alcuni testi UI parlano anche di confezioni. Per Amazon bisogna confermare la semantica delle mappature prima di applicare ulteriori moltiplicazioni. Esempio: se uno SKU Amazon contiene tre confezioni da sei pezzi, una unità Amazon deve scaricare 18 pezzi; un moltiplicatore già pari a 18 non va moltiplicato ancora per sei. I bundle hanno una gestione distinta, per componenti, non equivalente al semplice multipack. [4] [6]

Lo scarico cerca il centrale della company dello store e alloca per scadenza crescente, con lock sull’inventario. Scrittura della giacenza e movimento sono nella stessa transazione; lo schema vieta quantità inventario negative. Il processore esaminato, però, non esclude esplicitamente lotti scaduti e scrive sempre `SHOPIFY_EXIT`, anche se fosse richiamato per un ordine Amazon. Il nuovo ingresso dovrà usare **E-Keto** e `AMAZON_EXIT`, non ereditare automaticamente la company SoKeto dello store Shopify. [4] [6]

### Cosa significa “Parziale” e perché il retry va corretto

“Parziale” è lo stato dello **scarico interno**, non lo stato di spedizione comunicato da Shopify. Si verifica quando ci sono errori ma almeno una riga è stata completamente soddisfatta. Se nessuna riga è interamente soddisfatta, lo stato può essere `failed` **anche se è già stata scaricata una parte della giacenza**. Le righe non hanno oggi un proprio stato, motivo di errore o contatore di quantità scaricata. [4] [6]

In produzione ho verificato due esempi concreti:

- **Shopify 2775:** Parziale per SKU `9864` e `RISO250` non mappati; **11 pezzi già scaricati**, con quattro movimenti `SHOPIFY_EXIT`.
- **Shopify 2776:** Parziale per SKU `9864` non mappato; **5 pezzi già scaricati**, con tre movimenti `SHOPIFY_EXIT`.

Non ho ritentato questi ordini. Il retry attuale rielabora le quantità originarie senza sottrarre i consumi precedenti; può quindi duplicare scarichi riusciti. Inoltre, correggere il mapping della variante non aggiorna automaticamente il prodotto e la quantità già fotografati sulla riga importata. **Non va riusato questo retry per Amazon senza una tracciabilità per riga e componente.** [4] [5]

## Scenario Make 9129116 e “Amazon Vendite Report”

Il blueprint allegato usa la connessione Amazon `9605332` e la connessione Google `10776552`; crea il report `GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL` per il mese precedente. Ripete la richiesta per cinque marketplace, attende due volte 60 secondi e controlla lo stato una sola volta. Soltanto il ramo DONE è filtrato: i rami errore e riepilogo mensile non sono esclusivi. Non c’è alcun filtro FBM/Shipped. La pianificazione non è nel file esportato; la frequenza mensile è stata confermata dall’utente.

L’Excel contiene le schede raw e di riepilogo da marzo a ottobre 2026. Il raw ha nove colonne, senza intestazioni: data acquisto, canale di vendita, ID ordine, SKU, nome prodotto, quantità, valuta, prezzo articolo e imposta articolo, inferiti dai valori. Perde stato ordine/articolo, fulfillment-channel, ultimo aggiornamento e identità della riga. In settembre **525 righe corrispondono a 105 combinazioni distinte**, in ottobre **575 a 115**: ogni combinazione si ripete cinque volte. È una ripetizione osservata nell’output ridotto, non una prova dell’identità di eventuali righe genuine indistinguibili dopo la riduzione. A marzo alcuni prezzi sono stati convertiti anche in orari/durate. Non ho deduplicato o modificato lo storico.

Il database del gestionale contiene **318 varianti attive, tutte appartenenti allo store Shopify**: 100 semplici mappate, 215 semplici non mappate e tre bundle. La ricerca di store e varianti Amazon dedicate restituisce zero righe. Questo non esclude una mappatura nel foglio o in Make, ma **non conferma che le varianti Amazon siano già configurate nel gestionale**.

La documentazione corrente dei due report elenca 33 attributi, incluso `order-item-id`; la mappatura `colN` del blueprint non corrisponde alla sequenza pubblicata oggi. Il TSV originale di un’esecuzione non è stato fornito, quindi non posso attestare la sua sequenza storica. Il nuovo flusso trasferisce il documento originale completo e legge i campi per nome, senza indovinare posizioni. `LAST_UPDATE_GENERAL` individua aggiornamenti, anche di ordini acquistati prima, ma **non fornisce una data di spedizione esplicita**: non va rinominato `last-updated-date` in “data spedizione”. Shipped e FBM vanno verificati nei campi di stato ed evasione realmente restituiti. [7] [8]

## Proposta Make → webhook

### Vantaggi e limiti

È la scelta consigliata per la prima versione: riutilizza la connessione Amazon che indichi come esistente in Make, evita di gestire subito nuove credenziali e flussi SP-API nel gestionale e mantiene in SoKeto la responsabilità di mapping, inventario, idempotenza e report.

I limiti sono la latenza notturna, la dipendenza dai campi effettivamente esposti dallo scenario, il consumo operativo Make e la necessità di gestire recuperi, paginazione e timeout. Un timeout HTTP può verificarsi dopo che il gestionale ha già salvato l’ordine: un ritentativo deve essere sicuro, non considerato una nuova vendita. Make supporta POST HTTPS autenticati e timeout configurabili; retry ed esecuzioni incomplete vanno verificati nella configurazione effettiva. [9] [10]

### Flusso proposto, da approvare

1. **Make inoltra il report completo, il gestionale importa e scarica soltanto FBM completamente spediti**. Questo mantiene tutti i dati per verificare il filtro e segnalare annullamenti senza stock automatico. Per la prima versione non dedurrei quantità spedite dalle quantità ordinate di un ordine `PartiallyShipped`: l’inclusione di queste righe richiede prima un dato affidabile di riga/spedizione.
2. La ricerca notturna usa **ultimo aggiornamento e una finestra sovrapposta**, anziché soltanto “gli ordini acquistati ieri”. Un lookback iniziale di 48–72 ore è una scelta progettuale, non una garanzia della sorgente. Dopo interruzioni si riparte dall’ultimo intervallo completato, con paginazione e recupero dei giorni mancanti.
3. Il webhook è autenticato, con segreto obbligatorio, e associato server-side allo store Amazon e al centrale **E-Keto**. Company e magazzino non sono accettati liberamente dal payload. Il segreto assente deve bloccare l’endpoint, non renderlo pubblico.
4. Ordine, righe e scarico sono gestiti in una **transazione per ordine**, con controllo duplicati e stato sotto lock. Ogni riga mantiene identità, mapping congelato, quantità richiesta, quantità già scaricata, stato e motivo. I movimenti sono collegati alla riga/componente, così retry e concorrenza non riscaricano la quota riuscita.
5. Uno SKU non mappato viene salvato e segnalato; le altre righe valide possono essere elaborate. La testata risulta **Parziale** anche quando tutte le righe sono ancora da verificare, senza confondere un problema operativo con un errore tecnico di import.
6. **Politica proposta per stock insufficiente:** salvare la riga “Da verificare” senza scaricarla affatto; elaborare normalmente le altre righe. È la soluzione più semplice per evitare consumi ambigui. Uno scarico parziale sarebbe possibile soltanto con contatori e ledger espliciti, non copiando il comportamento Shopify attuale.
7. Il risultato notturno è persistito: ordini nuovi, duplicati, pezzi realmente scaricati per prodotto, SKU non mappati e righe da verificare. Annullamenti e resi producono segnalazioni, **nessuno storno automatico** in questa fase.

Gli ordini rimangono in `marketplace_orders`, mai in `orders` B2B. Non serve un agente Manus né un secondo scheduler Manus: la pianificazione resta di Make, mentre l’elaborazione è un endpoint dell’applicazione. Make usa il fuso dell’organizzazione; va esplicitato Europe/Rome, separando le date operative dai timestamp UTC. [11]

La funzione Vercel attuale ha un limite configurato di 60 secondi. Il payload dovrà essere suddiviso in batch contenuti oppure accodato in modo durevole; non va affidato a un processo “in background” dopo la risposta HTTP. Un batch parzialmente fallito deve rendere visibili gli esiti e consentire ritentativi idempotenti, senza avanzare silenziosamente il checkpoint. [1]

### Data iniziale e spedizioni tardive

È riusabile `sales_stores.orderImportStartDate`, ma il controllo server attuale è specifico per Shopify. Per Amazon deve essere applicato anche nel nuovo import e nei retry, in modo fail-closed.

Propongo che il cutoff rappresenti la **prima data di spedizione non già contabilizzata a mano**, non automaticamente la data di acquisto. Prima di fissare questa regola va verificato se la sorgente contiene la data effettiva di spedizione. `last-updated-date` non deve essere rinominata in “data spedizione”: un aggiornamento può avere altre cause. Se la data manca, occorre concordare il criterio iniziale e verificare gli ordini a cavallo prima del primo import con scarico. [7] [8]

## UI, report e schema necessari

Il canale `amazon`, il tipo movimento `AMAZON_EXIT`, gli store, le varianti canale e le tabelle marketplace esistono già. Non serve duplicare il modello degli ordini B2B. **Una migration append-only è prevedibile** per identità e stato della riga, tracciamento della quota elaborata e riepilogo delle esecuzioni; il contratto preciso dipende dalle colonne della sorgente. Non ho preparato o applicato SQL in questa fase. [6]

Il report marketplace accetta già Amazon, ma non è pronto da riusare senza verifica: alcuni totali sommano il lordo della testata dopo il join alle righe, ripetendolo per ogni riga; “pezzi venduti” conta le quantità importate, non i pezzi realmente scaricati. Sono inoltre assenti alcuni filtri company. Questi punti vanno corretti nel report coinvolto dalla feature, distinguendo vendita, import e scarico. [12]

Le attuali liste ordini sotto Shopify non filtrano sempre per canale/company: l’inserimento Amazon nelle tabelle comuni potrebbe farlo apparire impropriamente sotto “Ordini Shopify”. Servono separazione visiva del canale e scope server-side, senza portare Amazon nel pannello Ordini B2B. [5]

Il nuovo blueprint giornaliero locale conserva la connessione Amazon, fa una sola richiesta per finestra — oppure riprende il report pending già registrato — e fino a quattro controlli di stato esclusivi; trasferisce il file originale e segnala gli stati non riusciti. Riceve la finestra da un checkpoint server-side, invece di perderla dopo un’interruzione. Gli endpoint del gestionale **sono ancora da implementare**: gli URL del file sono intenzionalmente `example.invalid`, lo scenario non va attivato. Pianificazione proposta: Daily alle 03:00 nel fuso dell’organizzazione Europe/Rome.

Prima dello STEP 2 restano da chiudere **la verifica delle intestazioni del TSV runtime, la provenienza delle mappature Amazon e il criterio iniziale che esclude gli ordini già scaricati manualmente**. La proposta include test di duplicato sequenziale e concorrente, retry senza riscarico, SKU non mappato, multipack in pezzi, stock insufficiente senza quantità negative, FBM/FBA, recupero finestra e riconciliazione del report con i movimenti. Implementazione su branch dedicato soltanto dopo l’approvazione; nessun deploy autorizzato in questa fase.

## References

Autore: Manus AI. Fonti e verifiche del 5 novembre 2026. I riferimenti al codice sono fissati al commit analizzato; i dati di produzione derivano dalle query SELECT descritte nel rapporto.

[1]: https://github.com/portalidea/gestionalesoketo/blob/bd09d373256477739e5f39f4d1c6acc862abd5c4/vercel.json "SoKeto: configurazione Vercel e limite della funzione"
[2]: https://vercel.com/docs/cron-jobs "Vercel: cron jobs e fuso UTC"
[3]: https://github.com/portalidea/gestionalesoketo/blob/bd09d373256477739e5f39f4d1c6acc862abd5c4/vercel-handler/index.ts "SoKeto: handler serverless di produzione"
[4]: https://github.com/portalidea/gestionalesoketo/blob/bd09d373256477739e5f39f4d1c6acc862abd5c4/server/services/marketplaceOrderService.ts "SoKeto: import, scarico FEFO, stati e retry marketplace"
[5]: https://github.com/portalidea/gestionalesoketo/blob/bd09d373256477739e5f39f4d1c6acc862abd5c4/server/shopify-router.ts "SoKeto: configurazione, mapping, sync manuale e liste Shopify"
[6]: https://github.com/portalidea/gestionalesoketo/blob/bd09d373256477739e5f39f4d1c6acc862abd5c4/drizzle/schema.ts "SoKeto: schema store, varianti, ordini marketplace e movimenti"
[7]: https://developer-docs.amazon/sp-api/docs/report-type-values-order "Amazon: tipi di report ordini e relativi campi"
[8]: https://developer-docs.amazon/sp-api/reference/getorders "Amazon: stati ordine e canali di fulfillment"
[9]: https://apps.make.com/http "Make: modulo HTTP, autenticazione e timeout"
[10]: https://help.make.com/fix-errors-and-warnings "Make: errori, retry ed esecuzioni incomplete"
[11]: https://help.make.com/manage-time-zones "Make: fuso dell’organizzazione e pianificazione"
[12]: https://github.com/portalidea/gestionalesoketo/blob/bd09d373256477739e5f39f4d1c6acc862abd5c4/server/reports-router.ts "SoKeto: report marketplace e vendite per canale"


## Aggiornamento alle decisioni approvate e verifica completa Excel

Il 5 novembre sono state approvate le regole: item-status Shipped + Merchant, data movimento last-updated-date (data aggiornamento Amazon), cutoff purchase-date dal 01/09/2026 Europe/Rome, chiave account/ordine/articolo, dry run manuale e annullamenti/resi non stornati automaticamente. L’implementazione rimane locale e Make OFF.

Il controllo completo dei valori Excel tipizzati dà 4.325 righe raw e 862 combinazioni A:I distinte sommando gli otto mesi: 859 combinazioni ripetute cinque volte e tre dieci volte. Aprile–ottobre contengono cinque blocchi consecutivi identici; marzo ha tipi misti nelle colonne finali. I conteggi precedenti ottenuti convertendo tutti i valori in stringa sono superati dalla nota [verifica completa](amazon-foglio-fonti-report-readonly-2026-11-05.md). Non deduplicare vendite reali sulla sola coincidenza A:I: manca order-item-id nel vecchio foglio. Nessun report applicativo risulta leggere il foglio; i report usano il database.
