# M13 — Audit iniziale alert scadenze lotti presso i rivenditori

**Data audit:** 20 agosto 2026
**Ambito:** sola ispezione; nessuna migration, modifica applicativa o email inviata.

## 1. Tracciabilità lotto → ordine

**Esiste già una tracciabilità persistita, ma non una tabella dedicata `order_item_batches`.** La tabella `orderItems` contiene il campo nullable `batchId`. Quando l’allocazione FEFO coinvolge più lotti, il checkout crea più righe ordine, una per lotto, ciascuna con quantità e `batchId` propri. La relazione è quindi persa solo per la quota non assegnata/backorder (`batchId = NULL`), non per le allocazioni FEFO effettivamente assegnate.

Estratto schema (`drizzle/schema.ts`, righe 798–829):

```ts
export const orderItems = pgTable("orderItems", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  orderId: uuid("orderId").notNull().references(() => orders.id, { onDelete: "cascade" }),
  productId: uuid("productId").notNull().references(() => products.id, { onDelete: "restrict" }),
  batchId: uuid("batchId").references(() => productBatches.id, { onDelete: "set null" }),
  quantity: integer("quantity").notNull(),
  // ...
});
```

Il checkout partner applica FEFO e divide le righe per lotto (`server/retailer-checkout-router.ts`, righe 195–255):

```ts
for (const alloc of pi.allocations) {
  itemValues.push({
    orderId: order.id,
    productId: pi.productId,
    quantity: alloc.quantity,
    batchId: alloc.batchId,
    // snapshot prezzo e prodotto
  });
}
```

Lo scarico standard avviene in `server/db.ts`, funzione `transferBatchToRetailer`, dentro una transazione (`righe 1028–1124`). Il decremento del magazzino centrale è:

```ts
await tx
  .update(inventoryByBatch)
  .set({ quantity: central.quantity - input.quantity, updatedAt: new Date() })
  .where(eq(inventoryByBatch.id, central.id));
```

La stessa transazione incrementa l’inventario della location del rivenditore e registra un movimento `TRANSFER` con `retailerId`, `batchId`, origine e destinazione:

```ts
await tx.insert(stockMovements).values({
  type: "TRANSFER",
  retailerId: input.retailerId,
  batchId: input.batchId,
  fromLocationId: warehouse.id,
  toLocationId: retailerLoc.id,
  quantity: input.quantity,
});
```

### Percorsi di scarico censiti

| Percorso | Punto codice | Allocazione persistita | Nota |
|---|---|---|---|
| Ordini retailer standard / portale | `orders.startTransfer` → `transferBatchToRetailer` | Sì: `orderItems.batchId` + `stockMovements` | Quantità in `orderItems` è in confezioni; il transfer converte in pezzi (`quantity × piecesPerUnit`). |
| Checkout partner FEFO multi-lotto | `retailer-checkout-router.ts` | Sì: una riga `orderItems` per lotto | Il prodotto può generare più righe ordine, una per lotto. |
| Ordini evento/fiere | `orders.deliverEventOrder` | Sì: `orderItems.batchId` + movimento `OUT` | Lo scarico è diretto dal centrale; non ha un retailer destinatario. |
| Trasferimenti manuali magazzino | `routers.ts` → `transferBatchToRetailer` | Solo movimento `TRANSFER` | Non essendo legati a un ordine, non devono entrare nella query M13 basata su ordini. |

**Conclusione Fase 1:** la migration `order_item_batches` non è necessaria per il caso attuale, perché la relazione lotto–riga ordine è già persistita tramite `orderItems.batchId` e la divisione FEFO delle righe. Per M13 servirà calcolare i pezzi spediti come `orderItems.quantity × products.piecesPerUnit` e gestire esplicitamente le righe `batchId IS NULL` come non tracciabili.

## 2. Scadenze lotti

La scadenza è già obbligatoria su `productBatches.expirationDate`, tipo SQL `date` (`drizzle/schema.ts`, righe 321–349):

```ts
export const productBatches = pgTable("productBatches", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  productId: uuid("productId").notNull(),
  batchNumber: text("batchNumber").notNull(),
  expirationDate: date("expirationDate").notNull(),
  // ...
});
```

## 3. Stati ordine e significato logistico

L’enum effettivo è:

```ts
export const orderStatusEnum = pgEnum("order_status", [
  "pending", "transferring", "shipped", "delivered", "cancelled",
]);
```

La macchina a stati conferma il flusso `pending → transferring → shipped → delivered`.

| Stato | Significato nel codice | Idoneità per “merce consegnata al rivenditore” |
|---|---|---|
| `pending` | Ordine creato/non evaso | No |
| `transferring` | Scarico centrale e carico location retailer già eseguiti | Stock contabilmente presso il retailer, ma non conferma consegna fisica |
| `shipped` | Merce spedita/in viaggio | No |
| `delivered` | Stato terminale, `deliveredAt` valorizzato | **Sì** |
| `cancelled` | Annullato | No |

Non esiste uno stato `paid_on_delivery`; esistono invece `paymentTerms = on_delivery` e `paymentStatus = paid` come dimensioni separate. Per la query M13 il criterio conservativo corretto è `orders.status = 'delivered'`, eventualmente estendibile a `transferring` solo se si vuole considerare la giacenza contabilmente già trasferita ma non ancora consegnata.

## 4. Rivenditori

Estratto (`drizzle/schema.ts`, righe 156–196):

```ts
export const retailers = pgTable("retailers", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  name: varchar("name", { length: 255 }).notNull(),
  email: varchar("email", { length: 320 }),
  contactPerson: varchar("contactPerson", { length: 255 }),
  pricingPackageId: uuid("pricingPackageId"),
  affiliateId: uuid("affiliateId"),
  pricingModel: pricingModelEnum("pricingModel").default("tier_discount").notNull(),
  tierFrozen: boolean("tier_frozen").default(false).notNull(),
  // ...
});
```

Non esiste un flag anagrafico `isActive`/`active` né un campo di opt-out email. La migration M13 dovrà introdurre almeno un campo esplicito per l’esclusione email; per lo stato attivo si può aggiungere un flag dedicato oppure definire con Alessandro una regola basata sui dati esistenti. Non è corretto inferirlo da `syncEnabled`.

## 5. Email esistenti

Il layer riusabile è `server/email.ts`, basato su Resend e dominio `sm.soketo.it`. L’interfaccia è oggi:

```ts
export interface SendEmailOptions {
  to: string | string[];
  subject: string;
  html: string;
  from?: string;
}

export async function sendEmail(options: SendEmailOptions): Promise<boolean>
```

Il servizio di riferimento è `server/services/orderEmailService.ts`: costruisce HTML inline e lo incapsula in un template con intestazione SoKeto, contenuto e footer. L’invio è:

```ts
await sendEmail({
  to: retailer.email,
  subject,
  html,
});
```

Il layer attuale non supporta `text/plain` e restituisce solo `boolean`: per M13 dovrà essere esteso in modo retrocompatibile per ottenere `resend_message_id`, salvare l’esito e inviare una versione plain-text alternativa.

## 6. Cron e capacità disponibile

`vercel.json` contiene oggi un solo job:

```json
{
  "path": "/api/cron/tier-evaluation",
  "schedule": "0 5 1 * *"
}
```

Non esiste ancora `/api/cron/expiry-alerts`. Con il vincolo indicato di massimo due job pianificati, l’aggiunta dell’alert scadenze sarebbe il **secondo e ultimo job** disponibile.

Esiste già `server/cron-alerts.ts`, con autenticazione Bearer `CRON_SECRET`, controllo scorte/scadenze e invii diretti. Non ha però i requisiti M13: manca idempotenza mensile, tracciamento invii, dry-run, token di risposta e rate limit.

## 7. Log email e webhook Resend

Non esiste una tabella di log invii email, nessun campo `resend_message_id` e nessun endpoint webhook Resend/Svix nel codice. Il lockfile contiene una dipendenza transitiva `svix`, ma non è una configurazione webhook. La Fase 6 dovrà introdurre endpoint, verifica firma e aggiornamenti di delivery/open/click/bounce.

## Opzioni di esecuzione pianificata

| Opzione | Come funziona | Vantaggi | Limiti |
|---|---|---|---|
| A. Secondo job mensile integrato | Il giorno 10 chiama `/api/cron/expiry-alerts`; il job tier resta il primo giorno del mese. | Conforme al flusso proposto, centralizzato, senza servizio aggiuntivo. | Occupa il secondo e ultimo job pianificato disponibile. |
| B. Pianificazione esterna protetta | Un servizio esterno chiama lo stesso endpoint con `CRON_SECRET`; la configurazione Vercel resta con il solo job tier. | Conserva capacità per un eventuale terzo job futuro. | Richiede e mantiene una configurazione esterna. |

Per il sistema M13, la logica è deterministica e gestibile da pannello: entrambe le opzioni eseguono lo stesso codice. La scelta riguarda solo chi avvia la chiamata mensile.

## Decisioni richieste prima della Fase 1

1. Confermare che `orderItems.batchId` sia la tracciabilità sufficiente e che **non** sia necessaria `order_item_batches`.
2. Confermare il criterio ordini: solo `delivered` (prudente) oppure anche `transferring` (giacenza già trasferita contabilmente).
3. Scegliere l’opzione di pianificazione A o B.
4. Confermare che nella futura migration venga aggiunto un flag di opt-out email e indicare se deve essere aggiunto anche un flag `isActive` per i rivenditori.

Nessuna email reale verrà inviata prima della validazione esplicita di un dry-run.
