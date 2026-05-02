# MIGRATION_PLAN_M6.md — Portale retailer self-service

> **Status**: PLAN-ONLY. Nessuna implementazione. Documento generato 2026-05-02 per review architetturale.
>
> **Stima implementazione**: 15-25 ore distribuite su giornata dedicata. M6.1+M6.2+M6.3 indipendenti, schedulabili in session separate.
>
> **Decisioni aperte**: § D — da chiudere prima di partire con M6.1.

---

## 0. Goal & user stories

Trasformare i retailer SoKeto da soggetti passivi (anagrafica gestita
da admin) a utenti attivi che ordinano direttamente da un portale
self-service con prezzi già scontati per il loro pacchetto commerciale.

**Retailer-side stories**:
1. Loggarmi al portale con la mia email aziendale (no self-signup, invito-only).
2. Vedere stock corrente del mio magazzino (lotti + scadenze).
3. Sfogliare il catalogo SoKeto con prezzi già scontati (no calcolo manuale).
4. Aggiungere prodotti al carrello, qty, vedere subtotale netto + IVA + totale.
5. Confermare ordine → ricevere proforma su email.
6. Vedere stato ordini (Pending → Paid → Shipped → Delivered).
7. Scaricare PDF di proforma e fatture.
8. Caricare vendite finali (CSV o form) per audit lotti FEFO.

**Admin-side stories**:
1. Vedere lista ordini retailer con stato.
2. Marcare un ordine "Paid" su bonifico ricevuto (M6 manuale; M6+1 Stripe).
3. Triggerare TRANSFER alla transizione "Paid → Transferring".
4. Generare fattura definitiva su FiC dalla proforma.
5. Ricevere notifica email all'arrivo di un nuovo ordine.

---

## A. Architettura tecnica M6

### A.1 Routing: subdomain vs sub-path

| Opzione | PRO | CON |
|---|---|---|
| `partner.gestionale.soketo.it` (subdomain) | Separazione netta cookie scope, gating URL-level naturale, branding partner separabile, bundle distinto possibile | DNS+wildcard SSL+Vercel domain, JWT Supabase cross-subdomain via cookie domain `.soketo.it` (gestibile ma fragile in dev), 2 deploy targets o rewrite |
| `gestionale.soketo.it/partner-portal/*` (sub-path) | Zero infra change, stesso bundle, stessi cookie Supabase Auth, deploy unico | Tenant isolation enforce SOLO lato applicativo, no gating URL-level, branding misto |

**Raccomandazione**: **sub-path per M6.1** (ship-fast, basso rischio).
Subdomain valutabile in M6.5+ se servisse hard-separation per security
audit / branding distinto / bundle leggero retailer-side.

Motivazione tecnica: il JWT Supabase è gestito via cookies con
`SameSite=Lax`. Cross-subdomain richiede cookie con
`Domain=.soketo.it` — funziona ma genera edge case in localhost dev e
nel logout flow. Il sub-path preserva tutto lo stack auth attuale.

### A.2 Multi-tenant strategy: shared DB vs separate

| Opzione | PRO | CON |
|---|---|---|
| **Shared DB con RLS retailer-scoped** | Standard SaaS pattern, costi DB lineari (1 progetto Supabase), backup unificato, query cross-retailer per admin banali | Attacco/bug RLS = leak cross-tenant catastrofico; complessità test |
| Separate DB per retailer | Isolamento DB-level (gov/audit), perf scalabile linear | Costi 13× progetti Supabase, backup×13, sync schema, query admin su 13 conn distinti, deploy automation complessa |

**Raccomandazione**: **shared DB con RLS strict + defense-in-depth**.
SoKeto = 13 retailer, no requisiti governance specifici per separare.
Il pattern shared è già in uso per `users`/`retailers`/`stockMovements`
con RLS via `current_user_role()`. Estendiamo con
`current_user_retailer_id()` e nuove policy retailer-scoped.

Defense-in-depth (per evitare il leak catastrofico):
- RLS policy lato DB (primary control)
- `retailerProcedure` middleware tRPC che injecta
  `ctx.user.retailerId` e ignora qualsiasi `retailerId` dall'input
- Test cross-tenant esplicito in CI (creare 2 retailer test, login
  come retailer A, tentare di leggere ordini di B → 0 rows attesi)

### A.3 Auth retailer: Supabase Auth + invito admin-only

Workflow:
1. Admin SoKeto va su `/retailers/:id`, click "Invita partner",
   inserisce email + role (`retailer_admin` per il primo invitato,
   `retailer_user` per membri staff successivi).
2. Backend chiama `supabaseAdmin.auth.admin.inviteUserByEmail` con
   `user_metadata: { retailerId: X, role: 'retailer_admin' }`.
3. Trigger DB `handle_new_user` (esistente da migration 0002) legge
   `raw_user_meta_data`, crea row in `public.users` con `retailerId`
   e `role` valorizzati.
4. Magic link arriva al retailer, click → loggato.
5. Frontend `/login` route: post-auth, deriva redirect:
   - Role admin/operator/viewer → `/`
   - Role retailer_* → `/partner-portal`

NO self-signup (la spec utente è esplicita su `invito-only`). NO
password (coerenza con admin: magic link Supabase). Estensione futura
M6+1: SSO Google/Microsoft per retailer enterprise.

### A.4 Routing/middleware: separare admin vs retailer

Backend (tRPC):
- `protectedProcedure` (esistente): qualsiasi autenticato — retailer
  può chiamare procedure non-retailer-scoped (es. `auth.me`).
- `writerProcedure` (esistente): admin/operator → estendere con check
  esplicito `role NOT IN retailer_*` per evitare che retailer triggeri
  mutation admin-only.
- `adminProcedure` (esistente): solo admin → invariato.
- **NEW** `retailerProcedure`: richiede role retailer_admin/user,
  injecta `ctx.user.retailerId` nel context. Le procedure retailer-only
  (orders.create, catalog.list, ecc) usano questo.
- **NEW** `adminOrRetailerProcedure`: per query letture cross-role
  scopate dal RLS DB-level (es. `documents.getPdf` letto da entrambi
  ma RLS filtra per ownership).

Frontend:
- Single `App.tsx` con `<Switch>` esistente.
- Hook `useAuth` esistente esposto, in più ritorna `user.role` e
  `user.retailerId`.
- Componente `<RoleGuard role="admin">` wrappa rotte admin
  (`/products`, `/warehouse`, `/movements`, `/retailers`, …).
- Componente `<RoleGuard role={["retailer_admin","retailer_user"]}>`
  wrappa rotte retailer (`/partner-portal/*`).
- Login page (`/login`) post-auth deriva redirect default basato su
  role (vedi A.3 step 5).

### A.5 Frontend: stessa app React vs app separata

| Opzione | PRO | CON |
|---|---|---|
| **Stessa app, conditional layout/routes** | Code sharing massimo (UI primitives, tRPC client, types), build pipeline unica, deploy unico | Bundle unico (admin code servito a retailer), security-through-obscurity inadatta come solo controllo |
| Build separati Vite multi-entry | Bundle ridotto retailer-side, separation of concerns chiara | Build complesso, codice duplicato (ui/ shared), deploy doppio |

**Raccomandazione**: **stessa app con conditional layout** per M6.1+M6.2+M6.3.
La security NON dipende dal bundle (le procedure tRPC enforce role
lato server), quindi avere admin code nel bundle retailer è solo un
non-issue di privacy del codice. Bundle attuale è 883 KB (245 KB gzip)
— retailer code aggiunge ~50 KB più, totale ~300 KB gzip resta dignitoso.

Ottimizzazione opzionale M6.5+: `React.lazy` per code-split route
admin vs retailer. Bundle iniziale retailer ~150 KB se server le
admin pages on-demand.

Layout components:
- `<DashboardLayout>` esistente — admin sidebar 8 voci + footer user.
- **NEW** `<PartnerLayout>` — header con nome retailer + dropdown user
  (logout), no sidebar; navigation via top-level tabs (Dashboard /
  Catalogo / Carrello / Ordini / Inventario / Documenti / Vendite).

---

## B. Schema database M6

### B.1 Tabella `orders`

```sql
CREATE TYPE order_status AS ENUM (
  'pending',       -- creato, proforma generata, attesa pagamento
  'paid',          -- bonifico confermato, in coda preparazione
  'transferring',  -- TRANSFER in corso (admin sta evadendo)
  'shipped',       -- TRANSFER eseguito + spedizione partita
  'delivered',     -- consegna confermata (terminale)
  'cancelled'      -- annullato (terminale, da pending|paid)
);

CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "retailerId" uuid NOT NULL REFERENCES retailers(id) ON DELETE RESTRICT,
  status order_status NOT NULL DEFAULT 'pending',

  -- Totali snapshot al checkout (no recalc se cambia pacchetto dopo)
  "subtotalNet" numeric(12,2) NOT NULL,
  "vatAmount"   numeric(12,2) NOT NULL,
  total         numeric(12,2) NOT NULL,

  -- Riferimenti FiC (proforma generata su create, invoice su shipped)
  "ficProformaId" integer,
  "ficProformaNumber" varchar(50),
  "ficInvoiceId" integer,
  "ficInvoiceNumber" varchar(50),

  -- Riferimento TRANSFER eseguito (popolato su transferring→shipped)
  "transferMovementId" uuid REFERENCES "stockMovements"(id) ON DELETE SET NULL,

  -- Note
  "retailerNotes" text,    -- inserite dal retailer al checkout
  "adminNotes" text,        -- riservate admin (es. "ritardo bonifico")

  -- Audit timestamps
  "createdBy" uuid REFERENCES users(id) ON DELETE SET NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "paidAt" timestamptz,
  "transferringAt" timestamptz,
  "shippedAt" timestamptz,
  "deliveredAt" timestamptz,
  "cancelledAt" timestamptz,
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX orders_retailerId_idx ON orders ("retailerId");
CREATE INDEX orders_status_idx ON orders (status);
CREATE INDEX orders_createdAt_desc_idx ON orders ("createdAt" DESC);
CREATE INDEX orders_status_createdAt_idx ON orders (status, "createdAt" DESC);
-- Composite per filtri admin "tutti i pending recenti"
```

### B.2 Tabella `orderItems`

Tabella separata (NON jsonb snapshot) per query-ability + link
al `productBatches.id` post-TRANSFER.

```sql
CREATE TABLE "orderItems" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "orderId" uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  "productId" uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,

  -- batchId nullable: assegnato al TRANSFER (FEFO suggestion lato
  -- admin), non al checkout. Permette ordine prima che il batch
  -- esatto sia deciso.
  "batchId" uuid REFERENCES "productBatches"(id) ON DELETE SET NULL,

  qty integer NOT NULL CHECK (qty > 0),

  -- Pricing snapshot frozen al checkout (NO live recalc)
  "unitPriceBase" numeric(12,4) NOT NULL,
  "discountPercent" numeric(5,2) NOT NULL,
  "unitPriceFinal" numeric(12,4) NOT NULL,
  "vatRate" numeric(5,2) NOT NULL,
  "lineTotalNet" numeric(12,2) NOT NULL,
  "lineTotalGross" numeric(12,2) NOT NULL,

  -- Snapshot info prodotto (per stabilità storica anche se products edita)
  "productSku" varchar(100) NOT NULL,
  "productName" varchar(255) NOT NULL,

  "createdAt" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX orderItems_orderId_idx ON "orderItems" ("orderId");
CREATE INDEX orderItems_productId_idx ON "orderItems" ("productId");
```

Motivazione `batchId` nullable: il retailer ordina X pezzi del prodotto P;
l'admin decide quale lotto evadere al momento del TRANSFER (FEFO con
suggested batch da `getBatchesAvailableForTransfer`). `batchId` viene
popolato in transition `paid → transferring`.

### B.3 Tabella `retailerSales` (M6.4 — out-of-scope M6.1/2/3)

```sql
CREATE TABLE "retailerSales" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "retailerId" uuid NOT NULL REFERENCES retailers(id) ON DELETE CASCADE,
  "productId" uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  "batchId" uuid REFERENCES "productBatches"(id) ON DELETE SET NULL,
  qty integer NOT NULL CHECK (qty > 0),
  "soldAt" date NOT NULL,
  "customerInfo" jsonb DEFAULT '{}'::jsonb,
    -- nome, indirizzo, ricevuta_fiscale_number — PII (vedi GDPR § E)
  "uploadBatchId" uuid,         -- correla righe da uno stesso CSV import
  "createdAt" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX retailerSales_retailerId_soldAt_idx
  ON "retailerSales" ("retailerId", "soldAt" DESC);
```

### B.4 Estensione enum + users.retailerId

```sql
-- Migration 0007a (separata perché ALTER TYPE ADD VALUE non si può
-- usare nello stesso file in cui CHECK constraint lo referenzia)
ALTER TYPE user_role ADD VALUE 'retailer_admin';
ALTER TYPE user_role ADD VALUE 'retailer_user';

-- Migration 0007b
ALTER TABLE users ADD COLUMN "retailerId" uuid
  REFERENCES retailers(id) ON DELETE CASCADE;
ALTER TABLE users ADD CONSTRAINT users_retailerId_role_coherence
  CHECK (
    (role IN ('admin','operator','viewer') AND "retailerId" IS NULL)
    OR (role IN ('retailer_admin','retailer_user') AND "retailerId" IS NOT NULL)
  );
CREATE INDEX users_retailerId_idx ON users ("retailerId")
  WHERE "retailerId" IS NOT NULL;

CREATE OR REPLACE FUNCTION public.current_user_retailer_id()
  RETURNS uuid LANGUAGE SQL STABLE
AS $$ SELECT "retailerId" FROM public.users WHERE id = auth.uid() $$;
```

### B.5 RLS policies retailer-scoped (esempio)

```sql
-- orders: admin/operator vedono tutto, retailer vede solo i propri
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY orders_admin_all ON orders FOR ALL TO authenticated
  USING (current_user_role() IN ('admin','operator'))
  WITH CHECK (current_user_role() IN ('admin','operator'));
CREATE POLICY orders_retailer_select ON orders FOR SELECT TO authenticated
  USING (
    current_user_role() IN ('retailer_admin','retailer_user')
    AND "retailerId" = current_user_retailer_id()
  );
CREATE POLICY orders_retailer_insert ON orders FOR INSERT TO authenticated
  WITH CHECK (
    current_user_role() IN ('retailer_admin','retailer_user')
    AND "retailerId" = current_user_retailer_id()
  );
-- update/delete: solo admin (state machine controlled)

-- inventoryByBatch + locations già scoped via locations.retailerId,
-- estendere policy esistente per includere retailer_*

-- orderItems: scoped via JOIN su orders.retailerId (no policy diretta)
ALTER TABLE "orderItems" ENABLE ROW LEVEL SECURITY;
CREATE POLICY orderItems_admin_all ON "orderItems" FOR ALL TO authenticated
  USING (current_user_role() IN ('admin','operator'))
  WITH CHECK (current_user_role() IN ('admin','operator'));
CREATE POLICY orderItems_retailer_via_order ON "orderItems"
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM orders o
      WHERE o.id = "orderId"
        AND o."retailerId" = current_user_retailer_id()
    )
  );
```

### B.6 Workflow stati ordine — diagram transizioni

```
                    +-------------+
                    |  pending    |  ← retailer.create + proforma FiC
                    +------+------+
                           |
           +---------------+---------------+
           | admin: confirm                | retailer/admin: cancel
           v bonifico                      v
       +---+----+                      +---+-------+
       |  paid  |                      | cancelled |
       +---+----+                      +-----------+
           |                              ^
           | admin: start TRANSFER        |
           v                              | (rare: cancel from paid
       +---+---------+                    |  con refund manuale)
       | transferring|--------------------+
       +---+---------+                          (terminal)
           |
           | admin: TRANSFER completato + ship
           v
       +---+-----+
       | shipped |
       +---+-----+
           |
           | admin: confirm delivery (manuale o webhook M6+1)
           v
       +---+-------+
       | delivered |   (terminal)
       +-----------+
```

Transizioni permesse (state machine):
- `pending → paid` (admin)
- `pending → cancelled` (retailer o admin)
- `paid → transferring` (admin)
- `paid → cancelled` (admin, raro, refund manuale)
- `transferring → shipped` (admin, on TRANSFER success)
- `transferring → paid` (admin, on TRANSFER fail rollback — edge case)
- `shipped → delivered` (admin, manuale per M6; webhook M6+1)

Tutte le transizioni eseguite via `orders.updateStatus({id, newStatus})`
backend con check di coerenza state machine + side-effects (TRANSFER
su transferring→shipped, FiC invoice su shipped).

### B.7 Indici performance previsti (oltre a quelli sopra)

Nessuno extra rispetto a § B.1-B.4. Aggiunte se necessarie post-load
test:
- `orderItems_batchId_idx WHERE batchId NOT NULL` (per query
  "movement → ordini consumati di questo lotto")
- `orders_ficProformaId_idx WHERE ficProformaId NOT NULL` (per
  webhook FiC che linka indietro all'ordine)

---

## C. Fasi implementative — M6.1 / M6.2 / M6.3

### C.1 — Foundation auth + schema (5-7h)

**Schema**:
- Migration `0007a_phase_b_m6_user_role_enum.sql` (ALTER TYPE only)
- Migration `0007b_phase_b_m6_orders_schema.sql` (orders, orderItems,
  retailerSales, users.retailerId, RLS, helper SQL)

**Backend**:
- `retailerProcedure` middleware in `_core/trpc.ts`
- `users.inviteRetailer({retailerId, email, role})` in routers.ts
- `orders.create` (stub: solo INSERT in DB, no FiC ancora — M6.2 estende)
- `orders.list` + `orders.getById` (admin + retailer scoped)
- `auth.me` esteso per esporre `retailerId`

**Frontend**:
- `RoleGuard` component wrapper
- `PartnerLayout` component (header + tabs nav)
- Login redirect by role (in `useAuth` hook o nella Login page)
- `/partner-portal` stub dashboard (mostra solo nome retailer +
  "M6.2 incoming" placeholder)
- `/retailers/:id` aggiunge tab "Utenti retailer" con lista users
  associati + bottone "Invita"

**Test E2E**:
- Admin invita retailer test → email arriva → login OK
- Retailer logga → atterra su `/partner-portal`
- Retailer prova `/retailers` (admin route) → 403 / redirect
- Cross-tenant SQL test: 2 retailer test, login come A, query orders →
  RLS filtra correttamente (0 rows di B)

**Decisioni aperte risolvere prima**: A.1 (sub-path), A.2 (shared DB),
A.5 (single app).

**Dipendenze**: nessuna esterna. Schema 0007 è indipendente.

### C.2 — Catalog + Cart + Checkout (4-6h)

**Backend**:
- `catalog.list`: prodotti + prezzi calcolati server-side
  per il pacchetto del `ctx.user.retailerId`
- `catalog.previewCart({items})`: ricalcolo pricing live (per
  refresh del totale al cambio qty senza submit)
- `orders.create` esteso: chiama `createFicProforma` (riuso M3 modulo
  `fic-integration.ts`) DOPO l'INSERT della order, salva
  `ficProformaId/Number` sull'order. Su FiC API fail, salva in
  `proformaQueue` (riuso pattern M3) — ordine resta `pending` con
  warning UI per il retailer "proforma in coda di generazione".
- `orders.cancel` (retailer-only, status=pending only)

**Frontend**:
- `/partner-portal/catalog` — griglia prodotti con prezzi scontati,
  badge IVA (10%/22%), badge "scorta bassa" se centralStock < soglia
- `/partner-portal/cart` — state in localStorage (vedi D.5),
  preview pricing, modifica qty, remove item
- `/partner-portal/checkout` — review + retailerNotes + submit

**Email (Resend)**:
- Template HTML `order-confirmed-retailer.html`: ordine confermato +
  link download proforma PDF (link → backend proxy)
- Template `order-received-admin.html`: notifica nuovo ordine ad
  admin SoKeto (lista a config: `ORDER_NOTIFY_ADMIN_EMAILS` env var)

**Test E2E**:
- Retailer Premium aggiunge 3 prodotti (1×10%IVA, 1×22%IVA), modifica
  qty, checkout
- Order INSERT + orderItems INSERT con pricing snapshot corretto (-40%)
- FiC: proforma creata col cliente FiC del retailer + prezzi scontati
- Email: retailer riceve mail con link proforma; admin SoKeto riceve
  mail "nuovo ordine #42"

**Decisioni aperte risolvere prima**: D.5 (cart state), D.6
(email), D.7 (catalog filter per retailer type)

**Dipendenze**: M6.1 completata.

### C.3 — Order workflow admin + documents + email (5-7h)

**Backend**:
- `orders.updateStatus({id, newStatus})` con state machine:
  - `pending→paid`: nessun side-effect (solo timestamp paidAt)
  - `paid→transferring`: nessun side-effect
  - `transferring→shipped`: chiama `transferBatchToRetailer` per ogni
    orderItem (FEFO suggestion); su success aggiorna
    `transferMovementId` su orderItems (1 movement per item, oppure
    1 movement per ordine con `bundleId`?). Genera fattura FiC via
    `transformProformaToInvoice(ficProformaId)` — endpoint FiC
    `POST /issued_documents/{id}/transformer` o equivalente (verifica doc).
  - `shipped→delivered`: nessun side-effect (M6+1: webhook corriere)
  - `*→cancelled`: solo timestamp + retainProformaQueue rimosso
- `documents.getPdf({type: 'proforma'|'invoice', id})`: backend proxy
  a FiC `GET /c/{companyId}/issued_documents/{id}/pdf` con admin token
  (no esposizione token a retailer)
- `documents.listForRetailer`: ritorna proforme + fatture per
  ordini del retailer (RLS scoped)

**Frontend admin**:
- `/orders` nuova pagina lista ordini (filtro status, retailer, date
  range)
- `/orders/:id` dettaglio + state machine UI (bottoni transition
  abilitati per stato corrente; mostra TRANSFER associato; link
  proforma+fattura)

**Frontend retailer**:
- `/partner-portal/orders` storico con badge status
- `/partner-portal/orders/:id` dettaglio con timeline status changes,
  download proforma + fattura PDF
- `/partner-portal` dashboard: widget "Ordini recenti" + "Stock corrente"

**Email**:
- Template `order-paid-retailer.html`, `order-shipped-retailer.html`,
  `order-delivered-retailer.html`
- Admin riceve mail su transitions critiche (cancel, transferring fail)

**Test E2E**:
- Full lifecycle: pending→paid→transferring→shipped→delivered
- Ad ogni transition: email retailer arriva, dashboard widget
  aggiornato real-time (refetch on focus o polling 30s)
- Edge: TRANSFER fail (stock insufficiente nel warehouse) → status
  rollback a `paid` + alert admin

**Decisioni aperte risolvere prima**: D.4 (notifica retailer
email-only o anche dashboard widget)

**Dipendenze**: M6.1 + M6.2 completate.

### C.4 — Out of scope M6 (vedi § F)

CSV upload retailerSales (M6.4): pianificabile post-feedback uso M6.

---

## D. Decisioni aperte — DA CHIUDERE NEL REVIEW DOMATTINA

### D.1 Subdomain vs sub-path
**Raccomandazione**: sub-path `/partner-portal/*`. Sub-domain è
overkill per 13 retailer e introduce edge case Supabase Auth
cross-domain. Vedi § A.1.

### D.2 Email transactional: Resend (sm.soketo.it) o dedicato
**Raccomandazione**: **continua con Resend**. Già configurato, dominio
verificato. Pricing free 3000/mese, $20/mo per 50k. Volume atteso M6:
13 retailer × 4 email/ordine × 100 ordini/mese ≈ 5200 email/mese →
piano paid base. Cheap. Alternative (SES, Postmark, Mailgun) hanno
overhead di re-config zero benefit visibile.

Punto attenzione: gli email retailer-facing devono passare
SPF+DKIM check. Se Resend dominio è già configurato per admin
transactional (alert SoKeto interni), va verificato che le mail
verso terzi (retailer @loro-dominio.it) non finiscano in spam. Probe
necessario in M6.2.

### D.3 Pagamento: solo manuale admin (M6) o Stripe (M6+1)?
**Raccomandazione**: **manuale per M6**. Admin marca "Paid" su
verifica bonifico bancario. Stripe in M6+1 come increment:
- M6+1: Stripe Checkout link nella mail proforma → pre-payment
- Auto-transition pending→paid via webhook Stripe
- Pricing 1.4-2.9% + 0.25€/transaction, su ticket medio €500-2000
  costa 2-3€/ordine — accettabile.

Motivazione del rinvio: il flow M6 base (auth + portal + ordine + admin
state machine) è già grande. Stripe aggiunge 1 dipendenza più, webhook
config, error handling refund, complica il QA. Meglio shipare M6 base
e validare adoption prima di investire su payment integration.

### D.4 Notifica retailer: email-only o anche dashboard widget?
**Raccomandazione**: **entrambi**. Email è source-of-truth
(verifiable, audit), dashboard widget è "live status" interattivo.
Costo dashboard widget: piccolo (~30 min, già pensato in C.3).

Implementazione:
- Polling 60s su `/partner-portal/*` per refetch order list
- Toast notification (sonner) on status change detected nel polling
- Email rimane invariata

### D.5 Carrello state: localStorage o DB drafts
**Raccomandazione**: **localStorage** per M6.1+M6.2. Multi-device sync
è feature per ~5% utenti, costo non giustificato. Se feedback chiede
multi-device → tabella `cartDrafts` in M6+1 con auto-sync on login.

### D.6 Catalogo: tutti visibili a tutti, o filtrabili per retailer type?
Spec utente: "es. retailer farmacia vede solo alimenti, retailer
palestra vede tutto"

**Raccomandazione**: **NO filtering per M6.1**. Tutti i retailer
vedono tutto il catalogo. Filtering complica:
- products.allowedTags JSON o CategoryRules table
- retailers.businessType match logic
- catalog.list query con WHERE join che cresce

Per M6.1 passa la regola "il retailer è responsabile di non
ordinare prodotti fuori dal suo dominio". M6+1 estende con
filtering business-type-aware se feedback chiede.

### D.7 Accesso admin "come retailer" (impersonation)?
**Raccomandazione**: **NO impersonation in M6**. Audit log diventa
ambiguo, security surface aumenta, debug può essere fatto via
read-only "view as retailer X" mode (no actions).

In M6+1 considerare "view-only impersonation" (admin clicca
"Visualizza come retailer X" → tutto read-only, banner rosso
"Modalità ispezione, non puoi modificare").

### D.8 (extra mio) `retailer_admin` vs `retailer_user`
2 livelli o 1?

**Raccomandazione**: **2 livelli da M6.1**. Costo schema/RLS = 0
in più (basta filtrare nelle policy). UX:
- `retailer_admin`: ordina + gestisce utenti del proprio retailer
  (invita altri staff)
- `retailer_user`: solo ordina + vede storico

### D.9 (extra mio) Stock check al checkout
Bloccare ordine se SoKeto warehouse non ha stock sufficiente?

**Raccomandazione**: **warning soft**, no block. Il check fisico
avviene al TRANSFER (admin-side); il retailer può ordinare anche
sopra stock-on-hand (admin contatta per gestire la coda). Coerente
col modello B2B "ordino, mi confermi disponibilità".

### D.10 (extra mio) Edit ordine pending vs cancel + re-create
Retailer può modificare un ordine pending o solo cancellarlo?

**Raccomandazione**: **solo cancel + re-create per M6.1**. Edit
complica la state machine (proforma FiC andrebbe stornata e
ri-emessa = 2 chiamate API). Cancel ⇨ re-create è chiaro.

---

## E. Considerazioni rischio

### E.1 Sicurezza multi-tenant — leak cross-retailer
**Rischio**: bug in middleware tRPC o in policy RLS può esporre dati
di un retailer a un altro. Nel B2B questo è incident di severità alta
(violazione trust commerciale + potenziale GDPR breach).

**Mitigation**:
- **Defense-in-depth**: RLS DB-level + middleware tRPC + test E2E
  cross-tenant esplicito in CI
- Policy RLS sempre **deny by default** + allow esplicito (no
  USING (true) leftover)
- Code review obbligatoria per ogni procedure che tocca dati
  retailer-scoped
- Audit log delle query cross-tenant via Supabase log explorer

### E.2 Performance — N retailer + M ordini concorrenti
**Rischio**: a regime ~13 retailer × 100 ordini/mese ≈ 1300
ordini/mese. Crescita futura X10 = 13k/mese. Le query liste +
catalog + dashboard devono scalare.

**Mitigation**:
- Indici su `orders` come da § B.1 + `orderItems` come da § B.2 — già
  pianificati
- Catalog query: cacheable in-memory backend (TTL 5 min) se diventa
  hot path
- `getCatalogForRetailer` server-side compute pricing snapshot once,
  cache by retailerId+packageId pair
- Pagination obbligatoria su tutte le liste (orders, retailerSales)

### E.3 Race condition stock — 2 retailer ordinano stesso lotto
**Rischio**: order non lockano lo stock. 2 retailer pending sullo
stesso prodotto, primo ad essere TRANSFER vince, secondo va in
errore "stock insufficiente".

**Mitigation**:
- `orders.create` NON lock stock — è solo intent. UI retailer mostra
  warning "ordini più rapidi gestiti per primi" se vede stock low.
- `transferBatchToRetailer` (esistente M2) usa `SELECT FOR UPDATE`
  → serializza concorrenza al TRANSFER. Già robusto.
- Edge: se TRANSFER fallisce per stock insufficiente, status ordine
  rollback a `paid` + alert admin (già nel C.3 spec).
- Trade-off accettato: il retailer potrebbe vedere il "suo" prodotto
  esaurito tra checkout e TRANSFER. Soluzione fancy (lock at
  checkout) è M6+1.

### E.4 Backup / audit ordini
**Rischio**: cancellazione accidentale ordine, query corruption,
disaster recovery.

**Mitigation**:
- Postgres point-in-time recovery via Supabase (default 7 giorni
  Hobby, 30+ giorni Pro)
- Backup data-only via `scripts/dump-data.ts` esteso a includere
  `orders`, `orderItems`, `retailerSales` — su trigger pre-deploy
  rilevanti (manualmente per ora, automatizzabile come Vercel cron
  weekly in M6+1)
- Cancellazione ordine NON è DELETE fisico: status `cancelled` con
  `cancelledAt` timestamp (soft delete in essence)
- Audit log dei status changes: tabella `orderStatusHistory`?
  (over-engineered per M6.1 — gli `*At` timestamps su orders bastano)

### E.5 GDPR / privacy — dati retailer + clienti finali
**Rischio**: retailer + suoi clienti finali (in `retailerSales`) sono
soggetti GDPR (dati personali).

**Mitigation**:
- **Retailer data**: B2B (P.IVA, indirizzo aziendale), GDPR-relevant
  ma minimo. Diritto cancellazione = `deleteRetailer` esistente.
- **Customer info in retailerSales** (M6.4): PII pieno
  (nome, email, indirizzo). Trattamento:
  - Limitare accesso retailer-scoped (RLS)
  - Pseudonymizzazione opzionale al import (hash email, nome
    abbreviato) — flag opt-in per retailer
  - Retention 5 anni come da norma fiscale italiana, poi auto-delete
    via Vercel cron (M6+1)
  - Diritto cancellazione cliente: UI admin + Right-to-be-Forgotten
    workflow (lista soft-delete + hard-delete dopo 30gg)
- **Privacy policy** + termini retailer da aggiornare prima del go-live
  (legal task, non technical)
- Audit log accessi a customer data (chi, quando) per
  accountability — `accessLog` table opzionale M6+1

---

## F. Out of scope M6 (esplicito)

Le feature seguenti **NON** sono in M6.1+M6.2+M6.3. Pianificabili
in M6+N successive sulla base di feedback uso.

| Feature | Versione target | Note |
|---|---|---|
| Pagamento online integrato (Stripe/PayPal) | M6+1 | Auto-transition pending→paid su webhook |
| Tracking spedizione (corriere webhook) | M6+1 | Auto-transition shipped→delivered |
| Reso / storno ordine | M6+1 | Stato `returned`, ricreazione proforma negativa FiC |
| Multi-lingua (IT/EN) | M6+1 | i18n setup, oggi retailer SoKeto solo IT |
| App mobile retailer | Futuro | React Native o PWA |
| Subdomain partner.gestionale.soketo.it | M6.5+ | Sub-path basta per M6 |
| CSV upload vendite finali (`retailerSales`) | M6.4 | Schema previsto B.3 ma feature posticipata |
| Integrazioni gestionali retailer (Mago, TeamSystem, Danea) | M4+ Phase B | Già in roadmap originale |
| Stripe webhook + auto-paid | M6+1 | Schema orders supporta già flow |
| Notifiche push mobile / SMS | Futuro | Email è sufficient per M6 |
| Catalog filtering per retailer business type | M6+1 | Tutti vedono tutto in M6 |
| Edit ordine pending (non solo cancel+re-create) | M6+1 | UX più complessa |
| Multi-device cart sync | M6+1 | localStorage basta in M6 |
| View-only impersonation admin | M6+1 | Per support/debug retailer |
| Audit log strutturato accessi customer data | M6+1 | GDPR formal |
| Retention policy + auto-delete customer data | M6+1 | Vercel cron 5 anni |
| Stock check con lock al checkout | M6+1 | Warning soft basta in M6 |

---

## G. Smoke test plan post-implementazione M6

(Test funzionali da eseguire dopo M6.3 per validare il go-live.)

1. Admin invita partner per retailer test — email arriva
2. Retailer logga via magic link, atterra su `/partner-portal`
3. Naviga catalogo, vede prezzi -X% (X = sconto pacchetto suo)
4. Aggiunge 3 prodotti (mix 10% e 22% IVA), modifica qty, checkout
5. DB: `orders` row pending, `orderItems` con pricing snapshot
6. FiC: proforma su cliente FiC del retailer con prezzi scontati
7. Email retailer: arriva con link PDF proforma
8. Email admin: arriva notifica nuovo ordine
9. Admin marca "Paid" → email retailer "ordine pagato"
10. Admin marca "Transferring" → "Shipped" (TRANSFER eseguito,
    decremento warehouse, incremento retailer location, fattura
    FiC generata da proforma)
11. Retailer vede ordine "Shipped" + scarica fattura PDF
12. Cross-tenant test: login come retailer B, query orders →
    nessun ordine di A visibile

---

## H. Note di chiusura

- **M3 funzionale**: completato e in prod. Smoke test E2E TRANSFER+proforma
  ancora da fare lato utente (parked alla session successiva).
- **M3.0.8 perf**: parked. Diagnosi parziale dice DB veloce + cold start
  Vercel ~900ms; sintomo "30s caricamento" non riproducibile dal codice
  audit. Prossima session: DevTools Network timing + Vercel runtime
  logs analysis.
- **M6 implementazione**: NON partita. Plan-only fino a review
  architetturale + chiusura decisioni § D.

Fine plan M6.
