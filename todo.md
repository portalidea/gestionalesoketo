# TODO - Piattaforma Gestione Magazzino Sucketo

## Database e Schema
- [x] Progettare schema database per rivenditori, prodotti, inventario, movimenti stock e alert
- [x] Implementare tabelle con relazioni e indici ottimizzati
- [x] Aggiungere campi specifici per prodotti alimentari (scadenza, lotto, certificazioni)

## Backend API e Sincronizzazione
- [x] Implementare gestione anagrafica rivenditori con credenziali API
- [ ] Creare sistema di sincronizzazione con Fatture in Cloud (OAuth2)
- [x] Sviluppare endpoint per prodotti e movimenti stock
- [x] Implementare log completo movimenti magazzino
- [x] Creare sistema di alert automatici per scorte minime e scadenze

## Dashboard e Interfaccia
- [x] Progettare layout dashboard con sidebar navigation
- [x] Implementare dashboard principale con KPI aggregati e grafici
- [ ] Creare pagina dettaglio singolo rivenditore
- [x] Sviluppare gestione anagrafica prodotti centralizzata
- [x] Implementare visualizzazione alert con gestione stato

## Reportistica e Alert
- [x] Creare pagina alert con visualizzazione e gestione stato
- [ ] Implementare reportistica vendite per prodotto/rivenditore
- [ ] Implementare analisi trend e suggerimenti riordino
- [ ] Sviluppare sistema automatico generazione alert
- [ ] Aggiungere notifiche email per alert critici

## Alert Scadenze Rivenditori (M13)
- [x] Completare l’audit di tracciabilità lotto-ordine, scadenze, stati, email, cron e log invii
- [x] Generare CSV read-only degli ordini annullati dopo trasferimento senza movimento di storno
- [x] Verificare e correggere, se necessario, lo storno centrale/location retailer per ordini annullati in stato transferring
- [x] Verificare che sourceDocumentType/sourceDocument siano testo libero senza vincoli bloccanti prima dell’hotfix
- [x] Preparare un ambiente Postgres isolato con migration e seed versionato per i test futuri di magazzino e M13
- [x] Creare seed idempotente per i cinque casi hotfix e i lotti di scadenza M13
- [x] Documentare nel README l’avvio e il reset dell’ambiente isolato
- [x] Eseguire e documentare i cinque test richiesti del hotfix di storno prima del push
- [x] Aggiungere T6: storno di un transfer con giacenza retailer preesistente
- [x] Verificare e correggere l’anti-negativo nel reverseInterCompanyStock M11.D
- [x] Proporre e ottenere approvazione dello schema email_log generico prima della migration M13
- [x] Verificare RLS reale e il percorso frontend/PostgREST prima di applicare la migration M13
- [x] Rigenerare e validare la migration unica M13 con RLS, FK nullable, indici parziali, trigger settings e CHECK
- [x] Verificare il ruolo PostgreSQL effettivo del backend tRPC/Drizzle e il suo BYPASSRLS
- [x] Verificare scritture M13 con RLS attivo usando un ruolo locale non superuser
- [x] M13: aggiungere company_id ai run e vincolo cron univoco per company/finestra
- [x] M13: rendere esplicita la notifica interna con is_internal e retailer_id ON DELETE SET NULL
- [x] M13: recuperare nel job i run running oltre due ore prima di creare il run della finestra
- [x] M13: dichiarare il ruolo superuser dell'ambiente isolato e il limite della sua verifica RLS
- [x] M13: introdurre email_log idempotente per company/finestra/destinatario prima della chiamata a Resend
- [x] M13: marcare la notification come skipped/already_sent_in_window quando l'idempotenza database blocca il reinvio
- [x] M13: testare recovery+nuovo run e manuale+cron sulla stessa finestra senza doppio invio
- [ ] M13: verificare in produzione tabelle, colonne retailers, RLS, settings bootstrap, indici e constraint applicati
- [x] M13: registrare il cron M13 con invio reale esplicitamente disabilitato
- [ ] M13: produrre solo dry-run alignment e fermarsi prima di qualsiasi invio reale, in attesa di validazione HTML su rivenditore reale
- [x] Implementare dry-run, pagina risposta rivenditore e reportistica admin dopo le approvazioni di fase
- [x] M13: misurare in sola lettura la copertura storica dei lotti retailer riconducibili a TRANSFER con batchId e toLocationId
- [x] M13: censire senza implementazioni le fonti alternative per ricostruire la consegna lotto-location quando manca il TRANSFER
- [x] M13: rendere prioritaria la classificazione PEC rispetto alla soppressione riordino nel job e nel riepilogo SQL
- [x] M13: identificare in sola lettura l'UUID reale del retailer inter-company con giacenza e confrontarlo con la costante M11.D
- [x] M13: verificare in sola lettura il mantenimento della soglia min_pieces_threshold nel dispatcher e nel riepilogo per retailer
- [x] M13/M11.D: audit completo degli usi della costante inter-company, con distinzione retailerId/locationId e chiamanti isInterCompanyOrder
- [ ] M11.D: censimento read-only di ordini, carichi SoKeto, giacenze, costi con markup e consumo etichette per il retailer inter-company reale
- [x] M13: rinominare e usare la costante retailer inter-company reale per l'esclusione alert, senza modificare M11.D
- [x] M13: riallineare le query read-only all'UUID retailer inter-company reale
- [x] Audit read-only: mostrare la query M6.2.E di valorizzazione e stabilire se limita le location al centrale
- [x] Audit read-only: verificare l'impatto di batchNumber uguali con ID lotto differenti tra company
- [x] Documentare post-M13 che il carico SoKeto è manuale e che M11.D automatico non va corretto senza decisione di processo
- [x] M13: applicare min_pieces_threshold anche al riepilogo Query 2 read-only
- [x] M13: rieseguire typecheck e suite completa sul database isolato prima del commit autorizzato
- [ ] M13: committare e pushare esclusivamente feature/m13-expiry-alerts-safe, senza merge su main
- [ ] M13: eseguire il merge autorizzato su main, verificare deploy e confermare cron/invii reali disabilitati
- [ ] M13: risolvere il merge autorizzato tenendo le versioni branch dei conflitti M13 e todo.md, poi pushare main solo se pnpm check passa
- [x] M13: aggiungere MERGE_M13_ISTRUZIONI.md con dipendenze, router, file branch e sequenza verifiche per un merge futuro

## Promozioni Rivenditori
- [x] Ripristinare il pricing promo sul branch main: catalogo, dettaglio, carrello e checkout
- [x] Verificare in live i prezzi e i risparmi promo per tutti i rivenditori di test
- [x] Non mostrare una promo né un risparmio nullo quando il prezzo tier è già pari a zero
- [ ] Verificare che riepiloghi ordini, proforma e fatture admin usino il prezzo finale promozionale salvato
- [x] Rendere esplicito nel riepilogo admin che lo sconto di testata è il solo tier e che le promo sono applicate sulle righe

## Motore Tier
- [x] Aggiungere l’abilitazione manuale per includere o escludere singoli rivenditori dalla valutazione automatica
- [x] Eseguire il primo giorno di ogni mese il motore tier solo sui rivenditori abilitati, rispettando le modalità osservazione e attiva
- [x] Aggiungere nel pannello admin il toggle di abilitazione e lo stato dell’ultima valutazione per ogni rivenditore

## M13 — Dispatcher Cron Alert
- [x] Sostituire il cron mensile dedicato tier con un dispatcher giornaliero condiviso, preservando lo slot Hobby residuo
- [x] Eseguire M13 alert-only il giorno 10 con M13_CRON_ENABLED=true, senza chiamare il gateway email
- [x] Verificare in database isolato run completed, emails_sent=0, notifiche/item persistiti e zero righe email_log

## Travaso inter-company SoKeto → E-Keto
- [x] Ottimizzare allocatore FEFO con una query batch per tutti i prodotti ordine
- [x] Implementare preview staff e conferma atomica del travaso con due TRANSFER collegati
- [x] Implementare UI ordine e report mensile travasi con export CSV
- [x] Eseguire sette test isolati con evidenze giacenze, movimenti e annullamento senza contro-travaso
- [x] Preparare migration 0035 di soli indici per report e ricerca travasi, senza applicarla
- [x] Aggiungere test concorrente sulla stessa riga ordine: un solo travaso e due movimenti
- [x] Auditare letture e viste per ambiguità da fromLocationId cross-company e proporre correzione senza applicarla
- [x] Correggere le due righe ledger travaso affinché ciascuna referenzi solo la location della propria company
- [x] Applicare activeCompanyId a tutte le procedure di lettura stockMovements, eccetto vista aggregata protetta
- [x] Testare visibilità del ledger per company e isolamento di un utente mono-company
- [ ] Preparare query read-only di impatto del filtro companyId sui movimenti cross-company
- [ ] Committare e pushare feature/intercompany-transfer-soketo-to-eketo senza merge su main

## Test e Documentazione
- [x] Scrivere test per procedure critiche
- [ ] Creare documentazione tecnica
- [ ] Preparare guida utente

## Pagina Dettaglio Rivenditore
- [x] Creare endpoint backend per dettaglio rivenditore con inventario
- [x] Implementare query per movimenti stock del rivenditore
- [x] Sviluppare pagina dettaglio con informazioni rivenditore
- [x] Aggiungere tabella inventario con quantità e scadenze
- [x] Implementare sezione movimenti magazzino con tabs
- [x] Aggiungere statistiche specifiche del rivenditore

## Sincronizzazione Fatture in Cloud
- [x] Configurare variabili ambiente per OAuth2 Fatture in Cloud
- [x] Implementare flusso OAuth2 per autenticazione rivenditori
- [x] Creare endpoint per sincronizzazione prodotti da Fatture in Cloud
- [x] Implementare sincronizzazione inventario e movimenti stock
- [x] Sviluppare webhook per ricevere aggiornamenti automatici
- [x] Aggiungere interfaccia UI per connessione/disconnessione account
- [x] Implementare log sincronizzazioni con stato e errori
- [ ] Creare job schedulato per sincronizzazione periodica

## Shopify — import e scarico automatici dal 1 settembre 2026
- [x] Preparare query read-only sul possibile doppio scarico Shopify del 26 giugno
- [x] Salvare una data di inizio import per store e bloccare a livello di servizio ordini Shopify precedenti al cutoff
- [x] Rendere atomico lo scarico marketplace: aggiornamento inventario e movimento ledger nella stessa transazione
- [x] Valorizzare companyId nei movimenti SHOPIFY_EXIT e verificare gli analoghi writer AMAZON_EXIT e MARKETPLACE_RETURN
- [x] Integrare nel dispatcher giornaliero l’import Shopify paid idempotente con cutoff per-store
- [x] Validare cutoff, successo atomico, rollback del movimento e doppio import sul database isolato
- [x] Recuperare esplicitamente i gap Shopify fino a sette giorni e bloccare senza import quelli superiori
- [x] Aggiornare lastSyncAt Shopify solo se l'intera finestra è stata elaborata senza errori
- [x] Testare recupero gap di tre giorni, blocco gap di dieci giorni e watermark invariato dopo errore di processamento

## Travaso inter-company E-Keto → SoKeto
- [x] Estendere preview e conferma ordine staff al travaso E-Keto verso SoKeto, con lotto speculare e ledger mono-company
- [x] Rendere la UI ordine disponibile anche alle righe SoKeto senza lotto locale e con disponibilità E-Keto
- [x] Estendere il report travasi con la direzione E-Keto → SoKeto
- [x] Testare atomicità, lotto speculare, insufficienza, idempotenza e isolamento ledger per la nuova direzione
- [x] Verificare con dati isolati che il report mensile restituisca una sola riga per direzione e non raddoppi il totale dei travasi

## Audit M11.D — carico storico inter-company
- [x] Ricostruire in sola lettura il flusso isInterCompanyOrder/loadInterCompanyStock, includendo transizione, location, lotto, markup e rischio di doppia contabilizzazione

## Travaso manuale inter-company fra centrali
- [x] Documentare M11.D come codice morto da rimuovere senza correggere la costante legacy
- [x] Aggiungere preview e conferma staff per travasi manuali bidirezionali fra magazzini centrali
- [x] Riutilizzare lock, lotto speculare, costo origine e due ledger TRANSFER con sourceDocument di travaso manuale
- [x] Realizzare la pagina admin con company, prodotto, lotto, quantità e note obbligatorie
- [x] Verificare report mensile, atomicità e idempotenza dei travasi manuali per entrambe le direzioni
- [ ] Committare, pushare e fondere su main il travaso manuale bidirezionale dopo autorizzazione esplicita

## Audit Shopify — sincronizzazione varianti
- [ ] Ricostruire in sola lettura chiavi, creazione, paginazione e criteri della sync varianti Shopify per spiegare le varianti non importate
- [ ] Verificare in sola lettura parser Link, paginazione REST, filtro catalogo e metriche di completamento della sync varianti

## Shopify — paginazione varianti osservabile
- [x] Correggere il parser Link per rel=next con o senza virgolette
- [x] Segnalare partial quando una pagina piena da 250 prodotti non presenta un cursore next
- [x] Esporre nel pannello pagesFetched, productsFetched, variantsFetched, imported e updated
- [x] Testare i due formati Link e i due esiti senza header richiesti
- [ ] Committare, pushare e fondere su main la correzione della paginazione Shopify dopo autorizzazione esplicita

## Audit Shopify — varianti mancanti dopo sync
- [ ] Verificare bundle UI pubblicato, osservabilità server e punto esatto di perdita delle nuove SKU Shopify senza correggere prima della diagnosi

## Audit Shopify — fallimento bulk upsert varianti
- [ ] Ricostruire in sola lettura errore PostgreSQL completo e catalogo reale delle colonne inserite prima di correggere il writer o introdurre retry per-riga

## Shopify — bulk upsert varianti duplicate
- [x] Deduplicare per store e SKU tenendo l’ultima variante Shopify e riportare le SKU duplicate
- [x] Esporre message, code, detail e constraint dagli errori PostgreSQL della sync
- [x] Ritentare per-riga un chunk bulk fallito e riportare le SKU non scrivibili
- [x] Testare un chunk con SKU duplicate senza fallimento delle altre varianti
- [ ] Committare, pushare e fondere su main la correzione delle SKU duplicate Shopify dopo autorizzazione esplicita

## Simulatore prezzi prospect rivenditori — proposta
- [x] Censire catalogo, configurazioni commerciali, stagionalità e notifiche esistenti per proporre il simulatore pubblico senza modificare codice o database
- [x] Proporre storage configurazione fasce, modello richiesta contatto, catalogo prospect e gestione stagionalità

## Simulatore prospect — migration in revisione
- [x] Preparare migration append-only per configurazione JSONB, flag prodotti, richieste e righe snapshot senza applicarla

## Simulatore prospect — implementazione
- [x] Allineare lo schema Drizzle ai nuovi oggetti prospect della migration 0037
- [x] Implementare calcolo prospect server-side isolato dal pricing dei rivenditori attivi
- [x] Esporre catalogo e submit pubblici con rate limit, honeypot e ricalcolo autorevole
- [x] Salvare richiesta, righe e snapshot, quindi notificare direttamente il destinatario configurato
- [x] Realizzare pagina pubblica simulatore e pagina admin con lista/dettaglio richieste
- [x] Validare soglie, margini netti, IVA mista, input invalidi, catalogo e configurazione assente sul database isolato
- [ ] Committare e pushare il simulatore prospect esclusivamente sul branch dedicato dopo autorizzazione esplicita
