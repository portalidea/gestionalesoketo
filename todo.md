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
