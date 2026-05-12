# MANUS_DIAGNOSIS_2026-05-12.md — Diagnosi stato attuale SoKeto Gestionale

> **Data**: 12 maggio 2026
> **Autore**: Manus AI
> **Repo**: `portalidea/gestionalesoketo` — commit `ceb9bc5` (HEAD main)
> **Produzione**: https://gestionale.soketo.it
> **Scope**: diagnosi Feature A (DDT PDF AI), Feature B (Portale retailer M6), Feature C (Admin ordine per retailer)

---

## 1. Stato attuale del progetto

Il progetto SoKeto Gestionale si trova alla **milestone M3 completata** con il piano M6 documentato ma non implementato. Lo stack in produzione comprende React 19, tRPC 11, Drizzle ORM su Supabase Postgres, deploy su Vercel, autenticazione via Supabase Auth (magic link). Lo schema database include 13 tabelle distribuite su 7 migration (0000–0006). L'ultimo commit (`ceb9bc5`) è la chiusura documentale di M3 con il piano architetturale M6.

Le milestone completate e in produzione sono:

| Milestone | Descrizione | Status |
|---|---|---|
| M0 | Migrazione Manus → Supabase (schema, auth, deploy) | ✅ Completata |
| M1 | Phase B — Produttori, lotti FEFO, locations, inventoryByBatch | ✅ Completata |
| M2 | Phase B — TRANSFER warehouse→retailer, EXPIRY_WRITE_OFF | ✅ Completata |
| M2.5 | UX tabellari, pagina /movements globale | ✅ Completata |
| M3 | Pricing packages, FiC single-tenant, proforma queue | ✅ Completata |
| M5 | DDT PDF AI auto-extraction | ❌ Non iniziata |
| M6 | Portale retailer self-service | ❌ Solo piano documentale |

---

## 2. Feature A — Upload DDT PDF con AI auto-extraction (M5)

### 2.1 Diagnosi

La Feature A è **completamente assente** dal codebase. L'analisi ha coperto file, procedure tRPC, dipendenze, variabili d'ambiente, componenti UI e storage, senza trovare alcun artefatto implementativo.

| Componente | Esistente? | File path | Status | Note |
|---|---|---|---|---|
| File `*ddt*`, `*pdf*`, `*vision*`, `*upload*` | No | — | Missing | Nessun file con naming correlato nel repo |
| Procedure tRPC DDT/batch-import | No | — | Missing | `server/routers.ts` non contiene procedure DDT |
| `@anthropic-ai/sdk` in package.json | No | — | Missing | Dipendenza non installata |
| `pdf-parse` / `pdfjs-dist` / `multer` / `sharp` | No | — | Missing | Nessuna dipendenza di parsing/upload |
| `ANTHROPIC_API_KEY` in env.ts | No | — | Missing | Non dichiarata in `server/_core/env.ts` |
| Componenti UI (DdtUpload, PdfImport, BatchImport) | No | — | Missing | Nessun componente in `client/src/` |
| Bucket Supabase Storage per PDF DDT | No | — | Missing | Nessun codice storage nel server |
| Resend per notifiche DDT | No | — | Missing | Resend non integrato nel codice (menzionato solo in CLAUDE.md come stack futuro) |

**Verdetto: 0% implementato. Tutto da costruire.**

### 2.2 Nota su implementazione precedente Manus

Il progetto originale su Manus (pre-migrazione) aveva un modulo `ddt-import.ts` con parsing CSV/Excel tramite la libreria `xlsx`. Questo modulo è stato **rimosso durante la migrazione** a Supabase/Vercel (non era compatibile con lo stack serverless e non gestiva PDF). La Feature A richiede un approccio completamente nuovo basato su Claude Vision per estrazione da PDF, non un porting del vecchio modulo.

---

## 3. Feature B — Portale retailer M6

### 3.1 M6.1 — Foundation

La milestone M6.1 è **completamente assente** dal codebase. Il documento `MIGRATION_PLAN_M6.md` (759 righe) contiene un piano architetturale dettagliato ma è esplicitamente marcato come "PLAN-ONLY. Nessuna implementazione."

| Componente | Esistente? | File path | Status | Note |
|---|---|---|---|---|
| Migration `0007a_phase_b_m6_1_user_role_enum.sql` | No | — | Missing | Il prompt le menziona ma non esistono nel repo |
| Migration `0007b_phase_b_m6_1_orders_auth.sql` | No | — | Missing | Idem |
| Schema tabella `orders` | No | `drizzle/schema.ts` | Missing | Non presente nello schema |
| Schema tabella `orderItems` | No | `drizzle/schema.ts` | Missing | Non presente nello schema |
| Enum `user_role` con `retailer_admin`/`retailer_user` | No | `drizzle/schema.ts` L.32 | Missing | Enum attuale: `["admin", "operator", "viewer"]` |
| Colonna `users.retailerId` | No | `drizzle/schema.ts` L.58-65 | Missing | Tabella users non ha retailerId |
| Helper `current_retailer_id()` | No | — | Missing | Nessuna funzione DB |
| RLS policies multi-tenant | No | — | Missing | Nessuna policy retailer-scoped |
| `retailerProcedure` middleware | No | `server/_core/trpc.ts` | Missing | Solo `protectedProcedure`, `writerProcedure`, `adminProcedure` |
| `PartnerLayout` componente | No | `client/src/components/` | Missing | Solo `DashboardLayout` esistente |
| `PartnerDashboard` pagina | No | `client/src/pages/` | Missing | Non presente |
| Routing `/partner-portal` | No | `client/src/App.tsx` | Missing | Non configurato |
| Admin UI "Invita partner" su `/retailers/:id` | No | `client/src/pages/RetailerDetail.tsx` | Missing | Pagina esiste ma senza sezione invito |
| Email Resend template invito retailer | No | — | Missing | Resend non in package.json |

**Verdetto M6.1: 0% implementato. Foundation interamente da costruire.**

### 3.2 M6.2 — Catalogo + Carrello + Checkout

Dipende interamente da M6.1. Nessun artefatto presente.

| Componente | Esistente? | Status |
|---|---|---|
| Catalogo prodotti retailer con prezzi scontati | No | Missing — dipende da M6.1 |
| Carrello con calcolo real-time (localStorage) | No | Missing |
| Checkout → conferma ordine | No | Missing |
| Generazione proforma FiC su checkout | No | Missing — la logica proforma FiC esiste in M3 ma per TRANSFER, non per ordini |
| IVA visualizzata per prodotto | No | Missing — `vatRate` esiste su products (M3), riusabile |

**Verdetto M6.2: 0% implementato. Dipende da M6.1.**

### 3.3 M6.3 — Workflow admin ordini

Dipende da M6.1 + M6.2. Nessun artefatto presente.

| Componente | Esistente? | Status |
|---|---|---|
| Dashboard admin ordini ricevuti | No | Missing |
| State machine ordine (pending→paid→transferring→shipped→delivered) | No | Missing |
| TRANSFER automatico su pagamento | No | Missing — logica TRANSFER esiste in M2, riusabile |
| Generazione fattura definitiva FiC | No | Missing — logica proforma FiC esiste in M3, estendibile |

**Verdetto M6.3: 0% implementato. Dipende da M6.1 + M6.2.**

---

## 4. Feature C — Admin crea ordine per conto di retailer

La Feature C è **completamente assente** dal codebase e non era nemmeno prevista nel piano M6 originale (è una feature nuova).

| Componente | Esistente? | File path | Status | Note |
|---|---|---|---|---|
| Procedura `orders.createForRetailer` | No | `server/routers.ts` | Missing | Nessuna procedura ordini |
| UI `/orders/new` o pulsante su `/retailers/:id` | No | — | Missing | Nessuna pagina ordini |
| Selettore retailer + prodotti + pricing | No | — | Missing | Riuserà componenti M6.2 |

**Verdetto: 0% implementato. Dipende da M6.2 (riuso logica catalogo/pricing).**

---

## 5. Inconsistenze rilevate

### 5.1 Migration 0007a/0007b inesistenti

Il prompt di diagnosi menziona esplicitamente i file `drizzle/0007a_phase_b_m6_1_user_role_enum.sql` e `drizzle/0007b_phase_b_m6_1_orders_auth.sql` come "migration recenti" da leggere. Questi file **non esistono** nel repository. L'ultima migration è `0006_phase_b_perf_indexes.sql`. Questo indica che il prompt è stato scritto in anticipo rispetto all'implementazione, assumendo che M6.1 fosse già stato avviato. Non è un blocker, ma è importante saperlo: **M6.1 non è mai partito**.

### 5.2 Resend non integrato

`CLAUDE.md` dichiara Resend con dominio custom `sm.soketo.it` come stack email. Tuttavia, il package `resend` **non è presente in `package.json`** e non esiste alcun codice di invio email nel server. Il dominio Resend potrebbe essere configurato a livello DNS/account ma il codice applicativo non lo utilizza ancora. Questo è un prerequisito per M6.1 (invito retailer via magic link) e M6.2 (email proforma).

### 5.3 Supabase Storage non configurato

Nessun codice nel server interagisce con Supabase Storage (bucket, upload, download). Questo è un prerequisito per M5 (archiviazione PDF DDT originali).

### 5.4 Schema coerente ma incompleto per M6

Lo schema attuale (13 tabelle, 7 migration) è coerente e ben strutturato per le milestone M0–M3. Non ci sono migration applicate fuori sequenza o schema rotti. Tuttavia, mancano completamente le tabelle `orders`, `orderItems` e le estensioni auth per i ruoli retailer.

---

## 6. Piano implementazione

### 6.1 Feature A — DDT PDF AI (M5)

La Feature A è indipendente da M6 e può essere implementata in parallelo. Richiede le seguenti fasi:

**Fase 1 — Setup infrastruttura (2–3 ore)**

Installare `@anthropic-ai/sdk` come dipendenza. Aggiungere `ANTHROPIC_API_KEY` a `env.ts` e alle env vars Vercel. Configurare un bucket Supabase Storage `ddt-documents` con policy admin-only. Creare helper `server/supabase-storage.ts` per upload/download PDF.

**Fase 2 — Backend parsing AI (4–6 ore)**

Creare `server/ddt-vision.ts` con funzione che invia il PDF a Claude Vision API e riceve JSON strutturato (prodotto, batchNumber, scadenza, quantità per ogni riga). Implementare logica di matching prodotti contro anagrafica `products` (per nome fuzzy o SKU esatto). Gestire i casi edge: prodotto non trovato (flag per conferma utente), lotto duplicato (merge con incremento quantità).

**Fase 3 — Procedure tRPC (3–4 ore)**

Creare router `ddtImport` con procedure: `parse` (upload PDF → estrazione AI → ritorna righe pre-compilate), `confirm` (righe confermate dall'utente → crea lotti in `productBatches` + `inventoryByBatch` + movimento `RECEIPT_FROM_PRODUCER`), `list` (storico DDT importati). Upload PDF via endpoint Express multipart (non tRPC, che non gestisce bene i file binari).

**Fase 4 — Frontend UI (4–5 ore)**

Creare pagina `/ddt-import` con: zona drag-and-drop per PDF, stato di elaborazione AI (spinner + progress), tabella righe estratte con campi modificabili (prodotto, lotto, scadenza, quantità), badge per match prodotto (trovato/non trovato/ambiguo), pulsante conferma importazione, storico DDT importati.

**Fase 5 — Test e integrazione (2–3 ore)**

Test unitari per parsing AI (mock Claude response), test integrazione per flusso completo, verifica deploy Vercel (dimensione bundle con SDK Anthropic).

| Fase | Stima | Dipendenze |
|---|---|---|
| Setup infrastruttura | 2–3h | Nessuna |
| Backend parsing AI | 4–6h | Fase 1 |
| Procedure tRPC | 3–4h | Fase 2 |
| Frontend UI | 4–5h | Fase 3 |
| Test e integrazione | 2–3h | Fase 4 |
| **Totale M5** | **15–21h** | — |

**Decisioni architetturali aperte per M5:**

1. **Limite dimensione PDF**: consigliato 10 MB max (Claude Vision accetta fino a 20 MB ma il costo per pagina è significativo). Implementare check lato client + server.
2. **Caching risultati AI**: salvare il JSON estratto nel record DDT per evitare re-parsing se l'utente torna sulla pagina? Raccomandazione: sì, salvare in colonna `extractedData` jsonb.
3. **Multi-pagina**: un DDT può avere più pagine. Claude Vision gestisce multi-pagina nativamente, ma il prompt deve essere specifico. Testare con DDT reali.

### 6.2 Feature B — Portale retailer M6

M6 è la feature più complessa e richiede implementazione sequenziale in 3 sub-milestone. Il piano architetturale in `MIGRATION_PLAN_M6.md` è già molto dettagliato e le decisioni chiave sono state prese (sub-path, shared DB con RLS, stessa app React, localStorage per carrello, Resend per email, pagamento manuale in M6).

**M6.1 — Foundation (8–12 ore)**

Schema: estendere `user_role` enum con `retailer_admin` e `retailer_user`. Aggiungere `retailerId` a `users` con FK nullable verso `retailers`. Creare tabelle `orders` e `orderItems` come da piano B.1/B.2 in MIGRATION_PLAN_M6.md. Generare migration 0007.

Auth: creare `retailerProcedure` in `trpc.ts` che verifica ruolo retailer e inietta `ctx.user.retailerId`. Estendere `writerProcedure` per escludere ruoli retailer. Aggiungere RLS policies su Supabase per `orders` e `orderItems` scoped per retailerId.

Email: installare `resend` in package.json. Creare `server/email.ts` con template invito retailer (magic link Supabase). Aggiungere `RESEND_API_KEY` a env.ts e Vercel.

Frontend: creare `PartnerLayout` (header con nome retailer + tabs). Creare `PartnerDashboard` (pagina iniziale retailer). Configurare routing `/partner-portal/*`. Aggiungere `RoleGuard` component. Aggiungere UI "Invita partner" su `/retailers/:id`.

**M6.2 — Catalogo + Carrello + Checkout (10–14 ore)**

Backend: creare procedure `catalog.list` (prodotti con prezzo scontato per pacchetto retailer), `orders.create` (checkout → record ordine + generazione proforma FiC), `orders.list` (storico ordini retailer).

Frontend: creare pagina catalogo con griglia prodotti e prezzi scontati. Implementare carrello in localStorage con hook `useCart`. Creare pagina checkout con riepilogo, calcolo IVA per prodotto, note retailer. Creare pagina storico ordini con stato e download PDF.

**M6.3 — Workflow admin ordini (6–8 ore)**

Backend: creare procedure `orders.listAll` (admin vede tutti gli ordini), `orders.updateStatus` (state machine con validazione transizioni), `orders.triggerTransfer` (esegue TRANSFER warehouse→retailer + genera fattura FiC).

Frontend: creare pagina admin `/orders` con lista ordini filtrabili per stato/retailer. Implementare dialog cambio stato con validazione. Integrare notifiche email su cambio stato (Resend).

| Sub-milestone | Stima | Dipendenze |
|---|---|---|
| M6.1 Foundation | 8–12h | Nessuna |
| M6.2 Catalogo + Carrello + Checkout | 10–14h | M6.1 |
| M6.3 Workflow admin ordini | 6–8h | M6.1 + M6.2 |
| **Totale M6** | **24–34h** | — |

**Decisioni architetturali già chiuse** (da MIGRATION_PLAN_M6.md):

Le 10 decisioni in sezione D del piano sono state tutte risolte con raccomandazioni chiare: sub-path (non subdomain), Resend (non SES), pagamento manuale (non Stripe in M6), email + dashboard widget per notifiche, localStorage per carrello, catalogo senza filtering per business type, no impersonation, 2 livelli retailer (admin/user), warning soft su stock check, solo cancel+re-create per ordini pending.

### 6.3 Feature C — Admin crea ordine per retailer

La Feature C è un modulo aggiuntivo a M6.2 che riusa la logica catalogo/pricing.

**Implementazione (4–6 ore)**

Backend: creare procedura `orders.createForRetailer` (admin seleziona retailer, prodotti, quantità → stesso flow di `orders.create` ma con `createdBy` = admin e `retailerId` = selezionato).

Frontend: creare pagina `/orders/new` con selettore retailer (dropdown), catalogo prodotti con pricing automatico (sconto pacchetto del retailer selezionato), riepilogo con IVA e totale, pulsante conferma. Aggiungere pulsante "Nuovo ordine" su `/retailers/:id`.

| Fase | Stima | Dipendenze |
|---|---|---|
| Backend procedure | 2–3h | M6.2 completato |
| Frontend UI | 2–3h | M6.2 completato |
| **Totale Feature C** | **4–6h** | M6.2 |

---

## 7. Decisioni aperte

### 7.1 Hosting Claude Vision API per M5

Claude Vision richiede l'invio del PDF come base64 nell'API call. Su Vercel Hobby, le serverless functions hanno un timeout di **10 secondi** (60s su Pro). Un DDT di 3–5 pagine richiede tipicamente 5–15 secondi di elaborazione Claude. Questo è un **potenziale blocker** su Vercel Hobby.

**Raccomandazione**: verificare il piano Vercel attuale. Se Hobby, valutare upgrade a Pro (20$/mese) oppure implementare un pattern asincrono: la procedura tRPC avvia il parsing, salva lo stato "processing" nel DB, e il frontend fa polling fino al completamento. Questo aggiunge complessità ma risolve il timeout.

### 7.2 Resend setup

Resend è dichiarato come stack email in CLAUDE.md ma non è integrato nel codice. Prima di M6.1 serve: installare il package, configurare `RESEND_API_KEY` su Vercel, verificare che il dominio `sm.soketo.it` sia ancora attivo e che le email non finiscano in spam verso domini esterni (test con Gmail, Outlook).

### 7.3 Supabase Storage per PDF DDT

Serve creare il bucket `ddt-documents` su Supabase Dashboard e configurare le policy di accesso (admin-only write, admin-only read). Il codice helper per upload/download va creato da zero.

---

## 8. Ordine implementazione consigliato

**Raccomandazione: M5 prima, poi M6.**

La motivazione è triplice. In primo luogo, M5 è **indipendente** da M6 e può essere completata in 2–3 sessioni di lavoro senza bloccare nulla. In secondo luogo, M5 ha un **impatto operativo immediato**: oggi l'inserimento lotti dal DDT del produttore è manuale, e automatizzarlo con AI riduce errori e tempo. In terzo luogo, M6 è significativamente più complesso (24–34 ore) e richiede decisioni infrastrutturali (Resend, RLS, auth retailer) che beneficiano di una fase di stabilizzazione dopo M5.

L'ordine consigliato è:

```
Settimana 1:  M5 (DDT PDF AI)              — 15-21h
Settimana 2:  M6.1 (Foundation portale)     — 8-12h
Settimana 3:  M6.2 (Catalogo + Checkout)    — 10-14h
Settimana 4:  M6.3 + Feature C (Admin flow) — 10-14h
```

Alternativa se il portale retailer è più urgente commercialmente: invertire M5 e M6.1, ma in quel caso M5 slitterebbe a settimana 4–5.

**Stima totale: 43–61 ore di implementazione** distribuite su 4–6 settimane.

---

## 9. Riepilogo

| Feature | Status | Effort stimato | Dipendenze | Blocker |
|---|---|---|---|---|
| **A — DDT PDF AI (M5)** | 0% — completamente mancante | 15–21h | Nessuna | Timeout Vercel Hobby per Claude Vision |
| **B — Portale retailer M6.1** | 0% — solo piano documentale | 8–12h | Nessuna | Resend non integrato |
| **B — Portale retailer M6.2** | 0% — completamente mancante | 10–14h | M6.1 | — |
| **B — Portale retailer M6.3** | 0% — completamente mancante | 6–8h | M6.1 + M6.2 | — |
| **C — Admin ordine** | 0% — completamente mancante | 4–6h | M6.2 | — |

Nessun blocker critico è stato rilevato nello schema o nel codice esistente. Il progetto è in uno stato pulito e coerente alla milestone M3. Le 3 feature richieste sono tutte da costruire da zero, ma possono poggiare su fondamenta solide (schema lotti FEFO, logica TRANSFER, pricing packages, proforma FiC) già implementate nelle milestone precedenti.

---

*Fine diagnosi. Generato da Manus AI il 12 maggio 2026.*
