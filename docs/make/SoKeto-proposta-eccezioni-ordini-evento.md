# SoKeto — Proposta per le eccezioni di evasione degli ordini interni/evento

## Sintesi e perimetro

**Proposta soltanto: nessuna implementazione, modifica di codice, migrazione applicata, query DB o chiamata esterna è stata eseguita in questa analisi.** Repository esaminato: `/home/ubuntu/gestionalesoketo-main-legacy-call-audit-release`. I riferimenti sotto sono relativi a questa copia locale, non una certificazione del codice effettivamente in produzione.

L’estensione consigliata riusa il **pianificatore FEFO e il coordinamento transazionale già presenti**, separando la risoluzione della destinazione, la scrittura del movimento, la politica degli stati e gli effetti commerciali. Non serve un secondo motore di stock e non basta togliere il blocco `eventType` dal servizio retailer.

In base all’aggiornamento DB ricevuto dal coordinatore — non verificato direttamente in questa analisi — i sei ordini sono tutti E-Keto, `retailerId = NULL`, `eventType = internal`:

| Ordine, suffisso | Stato comunicato | Perimetro proposto |
|---|---|---|
| 0073, 0074, 0079, 0088 | `delivered`, il 5 novembre, circa 20:29–20:38 UTC | Esclusi da ogni retroazione: nessun nuovo scarico, consumo etichette, audit di eccezione o riscrittura di stato. |
| 0085 | `transferring`, dal 21 agosto | Caso storico da riconciliare separatamente; escluso dall’abilitazione iniziale delle eccezioni. |
| 0086 | `pending` | Primo candidato all’estensione ordinaria, dopo verifica di righe, lotti e assenza di scarichi già imputabili all’ordine. |

L’assenza di movimenti `TRANSFER` trovati tramite `sourceDocument` **non dimostra assenza di scarico evento**. Possono esistere movimenti di altro tipo, riferimenti diversi o movimenti senza `sourceDocument`.

## 1. Modello effettivamente presente nella copia locale

### Ordine interno non significa location interna

In `drizzle/schema.ts:43–67` il tipo movimento comprende `OUT` e `TRANSFER`, ma **non `EVENT_EXIT`**; l’enum `location_type` contiene soltanto `central_warehouse` e `retailer`. In `drizzle/schema.ts:1053–1061` gli ordini evento hanno `eventType`, `eventName`, `eventDate` e `fiscalReceiptRef`: **non hanno `eventId`**. Le location non hanno `eventId` né un campo separato `locationType`: il campo si chiama `type` (`drizzle/schema.ts:657–684`). La ricerca locale in server, schema, migrazioni, client, shared e script non ha trovato `EVENT_EXIT`, `event_exit` o `eventId`.

Il vincolo SQL `orders_retailer_or_event_check` consente esattamente ordine retailer oppure ordine evento, mai entrambi: per un evento il rivenditore deve essere nullo (`drizzle/0016_m6_2d_event_orders.sql:18–24`). Questo vincolo non è ripetuto nella definizione Drizzle attuale: occorre distinguere schema TypeScript e migrazioni SQL.

Il CHECK delle location ammette centrale con rivenditore nullo oppure retailer con rivenditore valorizzato. **Non ammette una location evento autonoma** (`drizzle/schema.ts:674–680`; definizione storica in `drizzle/0003_phase_b_m1_lots.sql`). Non va aggirato creando un rivenditore fittizio per un ordine interno.

### Due percorsi oggi diversi

Il percorso condiviso esclude tutti gli ordini con `eventType`, sia in anteprima sia sotto lock (`server/services/orderConfirmDelivery.ts:619–629, 713–738`). Inoltre il resolver pretende una location retailer nella company dell’ordine (`:320–340`). L’interfaccia replica l’esclusione (`client/src/pages/OrderDetail.tsx:625–628`) e usa un pulsante evento separato (`:1505–1519`).

Il percorso evento locale `deliverEventOrder` effettua invece `pending → delivered` con movimenti **`OUT` dal centrale, senza carico di destinazione** (`server/orders-router.ts:1953–1982`). Presenta criticità che l’estensione deve evitare:

- legge ordine e righe prima della transazione, senza lock sulla riga ordine;
- risolve il centrale dalla company attiva senza vincolare la lettura dell’ordine alla stessa company;
- confronta/sottrae `item.quantity` senza moltiplicare per `piecesPerUnit`, pur essendo le righe in confezioni e la giacenza in pezzi;
- salta righe senza lotto o insufficienti, poi imposta comunque `delivered`;
- non inserisce audit A/B/C, eventi di stato, consumo etichette o riferimento `sourceDocument` al movimento.

Queste osservazioni valgono per il file locale, non provano come siano stati evasi i quattro ordini già chiusi. L’eventuale presenza in produzione di `EVENT_EXIT`, location `event` o `eventId` indicherebbe una divergenza da verificare prima di approvare il disegno definitivo.

## 2. Architettura proposta: un piano, adattatori distinti

### Nucleo comune da riusare

Riutilizzare o estrarre dal servizio esistente caricamento/lock delle righe e delle giacenze, costruzione del piano, validazione delle eccezioni, snapshot audit, sostituzione/split delle sole righe FEFO e aggiornamento atomico del centrale:

- `loadItems` e `loadCentralInventory`: `orderConfirmDelivery.ts:342–410`;
- `buildAllocationPlan`: `:154–270`;
- `appendPartialStockAllocations`: `:272–318`;
- validazione e transazione con lock ordine: `:694–759`;
- piano misto e inserimento audit: `:779–874`;
- split FEFO e scarico aggregato per lotto: `:448–480, 876–932`.

Il piano deve essere indipendente dalla destinazione: stabilisce **quali pezzi, da quali lotti del centrale della company di origine, per quali righe**. Non deve conoscere FiC, affiliate o email.

### Resolver e politiche per tipo ordine

| Caso | Risoluzione e movimento | Effetti esclusi/inclusi |
|---|---|---|
| Retailer ordinario | Centrale della company → location retailer della stessa company; `TRANSFER`, carico destinazione reale. | Preservare il comportamento esistente, etichette, FiC/email post-commit e asse pagamento separato. |
| Interno/evento nel modello locale | Centrale della company → uscita per uso interno/evento; `OUT`, `toLocationId = NULL`, nessun inventario destinazione. Collegare il movimento all’ordine tramite `sourceDocument` e un discriminatore esplicito concordato. | Nessun rivenditore fittizio, proforma/fattura retailer, email retailer, provvigione automatica o travaso M11.D. |
| Evento con deposito reale, **solo se già presente e verificato in produzione** | Centrale → location evento esistente, attiva e coerente con ordine/evento/company. Tipo movimento e discriminatore devono seguire quel contratto reale. | Non interpretare automaticamente una location evento come retailer; non usare le sue giacenze come disponibilità centrale. |

Il resolver deve verificare tipo ordine, company, unicità/coerenza e attività della location eventualmente richiesta, e fallire se la destinazione è assente o ambigua. Le attuali FK semplici di inventario e movimenti verso `locations.id` non garantiscono da sole coerenza di company (`drizzle/schema.ts:695–715, 753–773`).

Per il modello locale consiglierei di mantenere per l’evento il passaggio diretto `pending → delivered`, aggiungendo l’evento di audit corretto, senza inventare una storia di trasferimento a un retailer. Il coordinamento transazionale può essere comune, mentre la politica degli stati resta diversa. Il CHECK di `0047_order_status_events.sql:20–27` permette questo passaggio diretto; la 0049 ammette già `delivery_exception`.

**L’endpoint evento precedente non deve restare una via alternativa per chiudere righe saltando controlli.** In un’implementazione futura dovrà delegare al medesimo nucleo oppure essere reso non utilizzabile per il perimetro nuovo. Le eccezioni restano un’azione amministrativa esplicita, non una scelta automatica del sistema.

## 3. Contratto A/B/C da mantenere

Definire `Q = quantità confezioni × piecesPerUnit`; disponibilità e movimenti sono sempre in pezzi. Usare il fattore del prodotto verificato e congelarlo nell’audit. Un fattore nullo/zero o dati incoerenti richiedono controllo, non una conversione improvvisata.

**A — `reallocated`.** Il lotto storico è insufficiente e il prodotto è disponibile nel centrale della company di origine. Riutilizzare FEFO per l’intera riga, eventualmente includendo il residuo del lotto storico; scaricare Q pezzi. Nel modello interno locale il movimento è un’uscita, non un carico retailer. Gli split delle righe commerciali devono restare in confezioni intere. Il pianificatore usa `floor(pezzi disponibili / piecesPerUnit)` per lotto (`orderConfirmDelivery.ts:234–252`): una disponibilità totale apparentemente sufficiente non garantisce confezioni intere allocabili su ciascun lotto. L’anteprima non autorizza a bypassare questo controllo.

**B — `no_stock_movement`.** Mantenere la regola applicativa più restrittiva attuale: **lotto storico e prodotto entrambi a zero nel centrale di origine** (`:576–581`). Chiudere la riga con audit e motivazione, senza scarico, carico destinazione o consumo etichette. Il CHECK DB 0049/0050 accetta una condizione sul prodotto più larga, `< Q`: non va usato come giustificazione per allargare B. B non è un modo per ignorare stock positivo o correggere a posteriori uno scarico incerto.

**C — `partial_no_stock_movement`.** Il prodotto ha disponibilità positiva ma inferiore a Q; il lotto storico può essere a zero. Scaricare soltanto i pezzi realmente allocati dal piano FEFO condiviso; il resto rimane senza movimento. Conservare **identificativo, lotto storico, quantità commerciale, prezzi e importi della riga**; le frazioni di confezione nelle allocazioni sono descrittive e non vanno scritte in `orderItems.quantity` (`:272–318, 829–865`).

Le eccezioni attuali richiedono una riga con lotto storico reperibile: l’anteprima filtra `batchId` presente e richiede numero/scadenza originali (`:561–575`); l’audit impone `originalBatchId` e snapshot non nulli. Per righe senza lotto, FEFO ordinario se la disponibilità basta; se non basta, blocco. **Estendere B/C a righe prive di lotto storico è un’altra modifica di contratto e potrebbe richiedere DDL: non è inclusa.**

### Ordini con righe miste

Un solo piano per l’intero ordine. Prima riservare righe normali con lotto, quindi righe da allocare/A, infine C sui residui; B è esclusa dal piano fisico. Conservare l’ordine deterministico delle righe e dei lotti. Se più C competono e una resta senza pezzi, annullare l’intera transazione e richiedere nuova verifica, senza convertirla implicitamente in B (`:814–827`, `:283–315`).

L’anteprima corrente mostra disponibilità grezze per riga, mentre il piano definitivo considera le altre righe: evitare di promettere la quantità C dell’anteprima come definitiva. Audit e quantità effettive devono derivare dal piano sotto lock. Stock dell’altra company è soltanto informativo (`:412–437, 603–609`); eventuale travaso deve precedere l’evasione attraverso il flusso dedicato. Né stock retailer né stock evento possono entrare nel FEFO centrale. Non cambiare in questo intervento la politica di selezione dei lotti scaduti, che il pianificatore locale non filtra esplicitamente.

### Etichette: regola corretta, ma nessun nuovo effetto implicito sugli interni

Il ramo retailer consuma etichette per le confezioni fisicamente evase; B non ne consuma; C usa `ceil(somma pezzi della riga / piecesPerUnit)`, **una volta per riga dopo la somma dei lotti**, non una volta per lotto (`:935–950`). Lo stock etichette è condiviso e il consumo è tracciato sotto lock (`:483–531`). Lo zero etichette non è un blocco di evasione nel contratto corrente.

Il ramo evento locale oggi non consuma etichette. Per non introdurre un addebito nuovo e non richiesto sull’uso interno, la scelta conservativa iniziale è **mantenere esplicitamente disabilitato il consumo etichette evento**. Se viene approvata l’uniformità con i retailer, riusare esattamente le regole A/B/C sopra e il consumo atomico; non dedurre etichette dalla quantità commerciale integrale di C. Questa decisione funzionale va resa esplicita prima dell’implementazione e non richiede di per sé una nuova tabella.

## 4. Atomicità, stati e side effect da proteggere

La conferma deve bloccare prima l’ordine, selezionato per `id + companyId`, poi leggere/validare righe e inventario nella stessa transazione. Stock, movimenti reali, audit, etichette eventualmente abilitate e stato devono essere indivisibili. Retry su `delivered` deve risultare senza nuovi effetti. Le eccezioni restano consentite soltanto da `pending`, con motivo per ogni riga anomala e divieto di scelte duplicate (`orderConfirmDelivery.ts:694–711, 739–759, 782–799`).

Non invocare in cascata la vecchia `transitionOrder`: crea proforma, consuma etichette e aggiorna stati tramite un altro percorso (`server/services/orderStateMachine.ts:125–267, 290–325`). Non trasferire questi side effect commerciali sugli ordini interni. Il wrapper retailer corrente chiama FiC dopo il commit; FiC ed email hanno già guardie su `retailerId`, ma i flag restituiti `needsProforma/needsInvoice` non distinguono il tipo ordine (`orders-router.ts:103–124, 204–226`; `orderConfirmDelivery.ts:977–987`). Nell’estensione serve una politica esplicita: per interni nessun documento retailer e flag non applicabili, anche nell’interfaccia di retry.

La consegna non registra un pagamento e non deve creare provvigioni. Oggi le provvigioni sono legate alla registrazione pagamento, non alla consegna (`orderStateMachine.ts:378–459`); il servizio commissioni cerca un retailer (`server/services/commissionService.ts:27–37`). Preservare questo confine senza assegnare retailer artificiali agli eventi. Mantenere separati prezzi evento e prezzi retailer: la consegna non ricalcola il pricing (`orderStateMachine.ts:617–637`). Per A verificare anche gli arrotondamenti degli split; B/C non devono ridurre importi commerciali perché i pezzi senza scarico sono una scelta di audit, non un rimborso.

## 5. Ordine 0085: riconciliazione prima di qualsiasi abilitazione

0085 è già `transferring`: il servizio condiviso assume che lo scarico sia avvenuto all’uscita da `pending` e salta ogni nuovo scarico negli stati successivi (`orderConfirmDelivery.ts:634–638, 757–771`). Questo sarebbe sicuro solo se tale assunzione fosse provata per il suo percorso storico. Oggi il servizio di annullamento stornerebbe merce soltanto quando `retailerId` è presente (`server/services/orderTransferReversal.ts:129–165`); non è uno strumento di recupero affidabile per l’interno 0085.

**Nessun reset automatico a `pending`, nessun annullamento/ricreazione e nessuna C applicata all’intera quantità per compensare un passato incerto.** Prima serve una ricostruzione read-only dei movimenti evento/uscita, anche `EVENT_EXIT` se esiste realmente nel DB, dei lotti, della company di origine, dei riferimenti e degli eventuali consumi etichette. Cercare solo `order_transfer` o solo `sourceDocument = UUID` non basta: il ramo locale evento omette proprio quel riferimento.

- Se è provato uno scarico completo già registrato, il recupero eventuale è una finalizzazione di stato con evidenza della riconciliazione, **senza riscaricare e senza inventare audit A/B/C retrodatati**.
- Se è provata l’assenza totale di scarico, serve un percorso di recupero amministrativo esplicito, transazionale e deduplicabile che usi il pianificatore esistente. Non si deve far credere al percorso ordinario che un vecchio `transferring` equivalga a un nuovo `pending`.
- Se lo scarico è parziale, prima determinare quantità già consumate e residuo effettivo. Il piano sull’intera riga commerciale duplichererebbe lo scarico; l’audit A/B/C attuale non va piegato a rappresentare una riconciliazione storica senza un contratto distinto.
- Se l’evidenza non è univoca, mantenere 0085 fermo e richiedere verifica amministrativa. La sola giacenza attuale non prova il consumo di quello specifico ordine.

**Rollout iniziale consigliato: 0086 soltanto.** L’eventuale recupero 0085 è un’approvazione separata, dopo le verifiche del coordinatore; non blocca la proposta architetturale per 0086. Anche per 0086 verificare movimenti preesistenti anomali prima del primo scarico: `pending` è una precondizione applicativa, non una prova storica assoluta.

## 6. Migrazione necessaria oppure no?

### Estensione minima nel modello locale: nessuna nuova DDL obbligatoria

L’audit 0049 **non ha una FK verso location** e non contiene alcun vincolo che richieda un retailer. La FK composta è `("orderId", "companyId") → orders(id, "companyId")`: consente anche ordini interni validi. `orderItemId` e `originalBatchId` sono deliberatamente senza FK per preservare gli snapshot dopo gli split (`drizzle/migrations/0049_order_item_fulfillment_exceptions.sql:28–59`). Non bisogna cambiarli o rendere nullable il rivenditore dell’audit: quel campo non c’è.

Prerequisiti già esistenti da verificare nell’ambiente: storico stati 0047, vincolo univoco ordine/company introdotto dalla **0048:155–165**, audit 0049 e colonne/contratti C della 0050. La 0049 da sola non basta per C. Se mancano, occorre allineare le migrazioni esistenti, non costruire una nuova migrazione specifica «per gli interni».

`delivery_confirm` e `delivery_exception` sono già ammessi per qualsiasi ordine (`0049:16–26`), quindi non serve un nuovo valore `source` per distinguere evento/retailer: il tipo si ricava dall’ordine. L’audit mantiene UNIQUE per riga, append-only, snapshot, indici e RLS (`0049:58–135`; `0050:86–88`). La 0050 mantiene audit A/B precedenti con quantità fisiche nulle e formalizza somma pezzi scaricati + pezzi senza scarico = Q (`0050:8–35, 40–73`). Nessun backfill o aggiornamento dei vecchi audit.

Con uscita `OUT` e destinazione nulla, i campi movimento attuali bastano (`drizzle/schema.ts:738–773`). Anche un discriminatore `sourceDocumentType` concordato non richiede DDL, essendo un varchar.

### Se si vuole introdurre davvero un deposito evento: progetto e DDL separati

Nel modello locale occorrerebbero almeno estensione dell’enum location, definizione dell’entità evento/identità stabile, collegamento delle location e degli ordini, FK e CHECK di coerenza e regole di unicità/attività. Un semplice `eventName` non è una chiave; `eventType = internal` non identifica un deposito. Le FK di inventario/movimenti possono già referenziare `locations.id`, ma prima la location deve essere legittima e coerente con la company. Non va eliminato il CHECK attuale senza sostituirlo con un contratto esplicito centrale/retailer/evento.

L’introduzione di `EVENT_EXIT`, se richiesta come tipo movimento nuovo nella copia locale, richiederebbe anche enum SQL e aggiornamento Drizzle/consumatori. **Non proporre tale DDL finché non è verificato se questi oggetti esistono già in produzione.** Il disegno di una prova persistente di riconciliazione per 0085 potrebbe richiedere campi/tabella aggiuntivi: non è parte dell’estensione minima A/B/C.

## 7. Compatibilità dei report e collaudo futuro

Il report eccezioni è già compatibile con un ordine senza retailer: JOIN interno a `orders` per ordine/company e **LEFT JOIN a retailers** (`server/reports-router.ts:1233–1277`). I record interni non vengono scartati. Restano validi filtri company, periodo, tipo e fallback per vecchi A/B della 0050.

Serve un piccolo adattamento di presentazione/API: aggiungere tipo/nome evento al risultato e mostrare «Ordine / destinazione o uso» invece di «Ordine / rivenditore». Oggi il retailer nullo viene rappresentato con un trattino (`client/src/pages/reports/FulfillmentExceptionsReport.tsx:132, 158`). Per C continuare a mostrare pezzi effettivi, non confezioni equivalenti come quantità scaricata (`:169–175`). Se la politica etichette evento resta disabilitata, il testo informativo deve distinguerla da quella retailer.

I KPI di magazzino locali comprendono `OUT` e `TRANSFER`, quindi un’uscita interna `OUT` continua a essere conteggiata (`reports-router.ts:147–189`). **Non comprendono `EVENT_EXIT` in quelle liste**: se quello è il tipo reale in produzione, la compatibilità del report di magazzino va verificata/allineata prima del rilascio. Il report travasi intercompany usa discriminatori specifici (`:64–68`): non usare quei discriminatori per gli eventi. Non conteggiare B e la quota senza scarico C come uscita fisica; restano visibili nel report eccezioni.

I collaudi futuri devono coprire interno normale, A/B/C, confezioni con più pezzi, C su più lotti e confezione incompleta, righe miste, conflitti fra C e righe normali, company errata, assenza/ambiguità della destinazione reale, doppia conferma, retry, rollback completo e assenza di FiC/email/provvigioni retailer. Conservare i test retailer/M11.D. Lo script locale già documenta questi casi per il ramo retailer (`scripts/test-order-confirm-delivery-atomic.ts:116–145, 245–277, 347–456` e casi C da `:487` in avanti); **non è stato eseguito**, perché scrive dati. Aggiungere prove esplicite che i quattro ordini già `delivered` restino immutati e che 0085 non entri nel percorso ordinario prima della riconciliazione.

## Decisione consigliata

Approvare il principio «un unico pianificatore transazionale, risoluzione della destinazione e side effect per tipo ordine». Per la copia locale, partire dall’uscita interna senza deposito e senza nuova DDL audit; limitare il primo caso a 0086 dopo verifica dei suoi dati. Tenere esclusi i quattro ordini chiusi e sospendere 0085 fino alla riconciliazione. Prima di qualsiasi implementazione verificare la divergenza fra repository e schema/runtime di produzione su `EVENT_EXIT`, `location_type = event` ed `eventId`, e approvare esplicitamente la politica etichette per l’uso interno.
