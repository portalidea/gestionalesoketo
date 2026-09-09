# Proposta — storico delle composizioni dell’ordine prospect

## Obiettivo e perimetro

La funzionalità registra l’evoluzione del carrello per ciascun invito personale, così che l’amministrazione possa vedere gli assortimenti realmente composti, la fascia raggiunta e la distanza dalla fascia superiore. Non modifica la procedura di invio dell’ordine, la conversione amministrativa, i prezzi, i tier, gli inviti o il catalogo pubblico.

Una sessione conserva esclusivamente l’identificativo del prodotto, la quantità e i totali autorevoli calcolati dal server. Non conserva prezzi unitari, nomi prodotto, dati di consegna, dati di contatto o altri snapshot aggiuntivi. In amministrazione i nomi attuali sono letti dal catalogo tramite gli ID prodotto; se un prodotto fosse rimosso, la sessione resta comunque leggibile tramite il relativo ID.

## Modello dati

La migration proposta è `drizzle/migrations/0041_prospect_composition_sessions.sql`. La 0040 della deroga tracciata al minimo ordine risulta applicata su conferma dell’utente; la sequenza operativa resta quindi continua: `0039 → 0040 override minimo → 0041 sessioni composizione`. La 0041 resta da revisionare e applicare manualmente prima di qualsiasi codice che la utilizzi.

| Campo | Tipo | Regola |
|---|---|---|
| `id` | `uuid` | Chiave primaria, generata dal database. |
| `invitation_id`, `company_id` | `uuid` | Relazione composta con l’invito: impedisce un’associazione tra inviti e company diverse. |
| `started_at`, `last_activity_at` | `timestamptz` | Apertura della sessione e ultima attività; la seconda non può precedere la prima. |
| `cart_snapshot` | `jsonb` | Solo array `[{"productId":"uuid","quantity":integer}]`; array vuoto alla semplice apertura. |
| `list_total` | `numeric(10,2)` | Totale listino calcolato server-side all’ultima attività. |
| `discounted_net` | `numeric(10,2)` | Netto merce della fascia raggiunta, calcolato server-side. |
| `reached_tier` | `varchar(50)` nullable | Codice fascia; `NULL` per carrello senza prodotti. |
| `next_tier_distance_eur` | `numeric(10,2)` nullable | Netto scontato ancora necessario per la fascia successiva; `NULL` senza fascia superiore o per carrello vuoto. |
| `submitted` | `boolean` | `true` soltanto per la sessione culminata nell’ordine inviato. |

L’indice `idx_prospect_composition_sessions_invitation_activity` serve il dettaglio cronologico dell’invito; l’indice parziale sugli elementi `submitted = false` serve l’indicatore dei prospect che hanno composto ma non inviato. La nuova tabella ha RLS abilitata e nessuna policy permissiva: ogni lettura o scrittura avviene solo dal backend.

## Flusso pubblico proposto

| Passaggio | Comportamento | Garanzia |
|---|---|---|
| Apertura link valido | `getInvitationPublicData` risolve il token e crea o riprende una sessione. | Token, invito e company sono risolti solo dal server. |
| Ripresa entro 30 minuti | Viene aggiornata `last_activity_at` della sessione non inviata più recente. | Non si generano nuove righe per refresh o ritorni ravvicinati. |
| Ritorno dopo oltre 30 minuti | Viene creata una nuova sessione con carrello iniziale vuoto. | Il dettaglio admin conserva i tentativi distinti. |
| Modifica carrello | Il browser salva dopo **5 secondi** di inattività usando una mutation fire-and-forget. | Nessun salvataggio a ogni tasto e nessun messaggio/blocco al prospect se fallisce. |
| Salvataggio | Il server riceve soltanto token, ID sessione e righe `{productId, quantity}`; ricalcola catalogo, fascia e totali. | Il browser non invia né company, né invitation ID, né importi fidati. |
| Invio ordine | La mutation esistente riceve l’ID sessione come campo opzionale e, nella stessa transazione dell’ordine prospect, aggiorna l’ultima composizione finale e pone `submitted = true`. | Un errore o un ID sessione assente/non coerente non blocca l’ordine attuale. |

La mutation di persistenza applicherà rate limit dedicato per IP, pari a **120 richieste in 10 minuti**, coerente con il calcolo pubblico. Il debounce client di cinque secondi rende il limite sufficiente anche durante una composizione attiva, senza inviare una richiesta per ogni modifica di input.

Per inviti revocati, scaduti, già inviati o inesistenti, la mutation risponde in modo neutro e non crea o aggiorna sessioni. Le sessioni già registrate non vengono eliminate né dalla revoca né dalla scadenza, e restano disponibili agli amministratori della company corretta.

## Contratti e componenti da estendere dopo approvazione

| Area | Estensione proposta |
|---|---|
| `server/services/prospectInvitationService.ts` | Funzioni server-side per creare/riprendere la sessione con lock per invito, salvare una composizione ricalcolata e marcare la sessione nel submit. |
| `server/prospect-simulator-router.ts` | Nuova `publicProcedure` `saveInvitationComposition`; `getInvitationPublicData` restituisce anche `compositionSessionId`; `submitInvitationOrder` accetta l’ID sessione solo come riferimento non fidato. |
| `client/src/pages/InvitedRetailerOrder.tsx` | Debounce di 5 secondi dopo le variazioni del carrello; mutation senza stato di errore mostrato; informativa visibile: “Le composizioni del carrello vengono registrate per finalità di assistenza commerciale.” con il link privacy già configurato. |
| `server/services/prospectInvitationService.ts` e router | Nuovo dettaglio amministrativo dell’invito, sempre filtrato da `ctx.activeCompanyId`, con timeline delle sessioni e righe carrello. |
| `client/src/pages/ProspectInvitations.tsx` | Colonna “Composizione” con segnale “Da richiamare” soltanto se esiste una sessione non inviata con carrello non vuoto; azione “Attività” per un dialog cronologico espandibile. |

Il dettaglio sessione mostrerà data avvio/ultima attività, totale listino, netto scontato, fascia, distanza dalla successiva e un’espansione delle quantità per prodotto. I prezzi non verranno mostrati come snapshot della sessione, perché non vengono memorizzati.

## Test obbligatori proposti

| ID | Caso | Risultato atteso |
|---|---|---|
| S1 | Apertura con token valido | Una sola sessione vuota, legata alla company dell’invito. |
| S2 | Riaccesso entro 30 minuti | Stesso `id` sessione e aggiornamento di `last_activity_at`. |
| S3 | Riaccesso dopo 30 minuti | Seconda sessione distinta, con la precedente conservata. |
| S4 | Salvataggio carrello | Snapshot limitato a ID/quantità e totali/fascia ricalcolati solo dal server. |
| S5 | Token scaduto, revocato o inesistente | Nessuna nuova scrittura; le sessioni storiche già create restano in admin. |
| S6 | Submit da sessione valida | Sessione aggiornata sul carrello finale e `submitted = true` nella transazione dell’ordine. |
| S7 | Submit senza sessione valida | Il flusso ordine esistente riesce comunque e nessuna sessione estranea viene marcata. |
| S8 | Lista inviti | “Da richiamare” appare solo per carrello non vuoto e sessione non inviata. |
| S9 | Isolamento company | Un amministratore della company A non ottiene sessioni o indicatori della company B. |
| S10 | Debounce e fallimento salvataggio | Il client non salva a ogni input e l’errore di persistenza non impedisce la composizione né il submit. |

## Punto da completare prima del rilascio

La riga visibile nel modulo informa l’utente, ma l’informativa collegata da `prospect_simulator_config.privacy_policy_url` dovrà includere anche la relativa finalità di assistenza commerciale e la conservazione dello storico. L’aggiornamento della policy è esterno al repository e non viene eseguito da questa proposta.
