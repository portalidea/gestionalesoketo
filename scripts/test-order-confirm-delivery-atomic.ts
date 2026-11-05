import postgres from "postgres";
import { seedHotfixM13, TEST_IDS } from "./seed-hotfix-m13";

const databaseUrl = process.env.LOCAL_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("Impostare LOCAL_TEST_DATABASE_URL: test esclusivamente locale.");
process.env.DATABASE_URL = databaseUrl;

const sql = postgres(databaseUrl, { prepare: false, max: 1 });

const IDS = {
  complete: "d0000000-0000-0000-0000-000000000001",
  transferred: "d0000000-0000-0000-0000-000000000002",
  insufficient: "d0000000-0000-0000-0000-000000000003",
  labels: "d0000000-0000-0000-0000-000000000004",
  unpaid: "d0000000-0000-0000-0000-000000000005",
  concurrent: "d0000000-0000-0000-0000-000000000006",
  ficFailure: "d0000000-0000-0000-0000-000000000007",
  otherCompanyOnly: "d0000000-0000-0000-0000-000000000008",
  soketoOnlyBatch: "d0000000-0000-0000-0000-000000000009",
  reallocatedZero: "d0000000-0000-0000-0000-000000000010",
  noStockMovement: "d0000000-0000-0000-0000-000000000011",
  reallocatedPartial: "d0000000-0000-0000-0000-000000000012",
  missingReason: "d0000000-0000-0000-0000-000000000013",
  mixed: "d0000000-0000-0000-0000-000000000014",
  partialAvailable: "d0000000-0000-0000-0000-000000000015",
  partialMultiBatch: "d0000000-0000-0000-0000-000000000016",
  partialMixed: "d0000000-0000-0000-0000-000000000017",
  partialCompeting: "d0000000-0000-0000-0000-000000000018",
  partialIncompletePackage: "d0000000-0000-0000-0000-000000000019",
  partialZeroBatch: "d0000000-0000-0000-0000-000000000020",
  partialZeroReplacementBatch: "d0000000-0000-0000-0000-000000000021",
} as const;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function resetOrder(id: string) {
  await sql`DELETE FROM order_status_events WHERE "orderId" = ${id}`;
  await sql`DELETE FROM "stockMovements" WHERE "sourceDocument" = ${id}`;
  await sql`DELETE FROM "labelMovements" WHERE "sourceOrderId" = ${id}`;
  await sql`DELETE FROM "orderItems" WHERE "orderId" = ${id}`;
  await sql`DELETE FROM orders WHERE id = ${id}`;
}

async function createOrder(input: {
  id: string;
  status?: "pending" | "transferring";
  paymentStatus?: "paid" | "unpaid";
  retailerId?: string;
  productId?: string;
  batchId?: string | null;
  quantity?: number;
}) {
  const status = input.status ?? "pending";
  const paymentStatus = input.paymentStatus ?? "paid";
  const retailerId = input.retailerId ?? TEST_IDS.normalRetailer;
  const productId = input.productId ?? TEST_IDS.productBoxes;
  const quantity = input.quantity ?? 1;
  const batchId = input.batchId === undefined ? null : input.batchId;
  const productSku = productId === TEST_IDS.productPieces ? "TEST-PZ-1" : "TEST-BOX-6";
  const productName = productId === TEST_IDS.productPieces ? "TEST Prodotto Pezzo Singolo" : "TEST Prodotto Confezione 6";
  await resetOrder(input.id);
  await sql`
    INSERT INTO orders (
      id, "orderNumber", "retailerId", status, "paymentStatus", "subtotalNet", "vatAmount", "totalGross", "discountPercent", "createdBy", "companyId"
    ) VALUES (
      ${input.id}, ${`TEST-DELIVERY-${input.id.slice(-4)}`}, ${retailerId}, ${status}, ${paymentStatus}, 10, 1, 11, 0, ${TEST_IDS.adminUser}, ${TEST_IDS.originCompany}
    )
  `;
  await sql`
    INSERT INTO "orderItems" (
      "orderId", "productId", "batchId", quantity, "unitPriceBase", "discountPercent", "unitPriceFinal", "vatRate", "lineTotalNet", "lineTotalGross", "productSku", "productName"
    ) VALUES (
      ${input.id}, ${productId}, ${batchId}, ${quantity}, 10, 0, 10, 10, ${quantity * 10}, ${quantity * 11}, ${productSku}, ${productName}
    )
  `;
}

async function stock(locationId: string, batchId: string) {
  const [row] = await sql<{ quantity: number }[]>`
    SELECT quantity FROM "inventoryByBatch" WHERE "locationId" = ${locationId} AND "batchId" = ${batchId}
  `;
  return row?.quantity ?? 0;
}

async function main() {
  // Shim test-only per colonne presenti nello schema applicativo ma non nelle
  // migration storiche che precedono questa feature nel replay locale.
  await sql`
    ALTER TABLE orders
      ADD COLUMN IF NOT EXISTS "paymentStatus" varchar(20) DEFAULT 'unpaid',
      ADD COLUMN IF NOT EXISTS "paymentMethod" varchar(50),
      ADD COLUMN IF NOT EXISTS "paidAt" timestamptz,
      ADD COLUMN IF NOT EXISTS "transferringAt" timestamptz,
      ADD COLUMN IF NOT EXISTS "shippedAt" timestamptz,
      ADD COLUMN IF NOT EXISTS "deliveredAt" timestamptz,
      ADD COLUMN IF NOT EXISTS "ficProformaId" integer,
      ADD COLUMN IF NOT EXISTS "ficProformaNumber" text,
      ADD COLUMN IF NOT EXISTS "ficInvoiceId" integer,
      ADD COLUMN IF NOT EXISTS "ficInvoiceNumber" text
  `;
  await seedHotfixM13();
  for (const id of Object.values(IDS)) await resetOrder(id);
  await sql`UPDATE products SET "labelStock" = 40 WHERE id = ${TEST_IDS.productBoxes}`;

  const { executeOrderFulfillment, previewOrderDelivery } = await import("../server/services/orderConfirmDelivery");
  const { registerPayment } = await import("../server/services/orderStateMachine");
  const { fulfillAndRunPostCommit, retryFicDocumentsAfterFulfillment } = await import("../server/orders-router");
  const common = {
    companyId: TEST_IDS.originCompany,
    actorUserId: TEST_IDS.adminUser,
    source: "delivery_confirm" as const,
  };

  // T1: pending paid, righe Da allocare, split FEFO e un solo commit fino alla consegna.
  await createOrder({ id: IDS.complete, batchId: null, quantity: 15 });
  const beforeSoon = await stock(TEST_IDS.originCentral, TEST_IDS.batchSoon);
  const beforeFourMonths = await stock(TEST_IDS.originCentral, TEST_IDS.batchFourMonths);
  const resultComplete = await executeOrderFulfillment({ ...common, orderId: IDS.complete, targetStatus: "delivered" });
  const completeItems = await sql<{ batchId: string; quantity: number }[]>`
    SELECT "batchId", quantity FROM "orderItems" WHERE "orderId" = ${IDS.complete} ORDER BY "batchId"
  `;
  const completeStatus = await sql<{ status: string; transferringAt: Date | null; shippedAt: Date | null; deliveredAt: Date | null }[]>`
    SELECT status, "transferringAt", "shippedAt", "deliveredAt" FROM orders WHERE id = ${IDS.complete}
  `;
  const completeEvents = await sql<{ fromStatus: string; toStatus: string; source: string }[]>`
    SELECT "fromStatus", "toStatus", source FROM order_status_events WHERE "orderId" = ${IDS.complete} ORDER BY "createdAt", id
  `;
  const completeMovements = await sql<{ batchId: string; quantity: number; type: string }[]>`
    SELECT "batchId", quantity, type FROM "stockMovements" WHERE "sourceDocument" = ${IDS.complete} ORDER BY "batchId"
  `;
  const completeLabels = await sql<{ quantity: number; previousStock: number; newStock: number }[]>`
    SELECT quantity, "previousStock", "newStock" FROM "labelMovements" WHERE "sourceOrderId" = ${IDS.complete}
  `;
  assert(completeStatus[0]?.status === "delivered", "T1: ordine paid deve arrivare a delivered.");
  assert(Boolean(completeStatus[0]?.transferringAt && completeStatus[0]?.shippedAt && completeStatus[0]?.deliveredAt), "T1: devono essere valorizzati tutti gli step temporali.");
  assert(completeItems.length === 2 && completeItems.some((r) => r.batchId === TEST_IDS.batchSoon && r.quantity === 11) && completeItems.some((r) => r.batchId === TEST_IDS.batchFourMonths && r.quantity === 4), "T1: la riga Da allocare deve essere spezzata FEFO in 11 + 4 confezioni.");
  assert(await stock(TEST_IDS.originCentral, TEST_IDS.batchSoon) === beforeSoon - 66, "T1: centrale lotto FEFO deve calare di 66 pz.");
  assert(await stock(TEST_IDS.originCentral, TEST_IDS.batchFourMonths) === beforeFourMonths - 24, "T1: centrale secondo lotto deve calare di 24 pz.");
  assert(await stock(TEST_IDS.normalRetailerLocation, TEST_IDS.batchSoon) === 116, "T1: stock retailer deve ricevere il primo lotto.");
  assert(await stock(TEST_IDS.normalRetailerLocation, TEST_IDS.batchFourMonths) === 24, "T1: stock retailer deve ricevere il secondo lotto.");
  assert(completeMovements.length === 2 && completeMovements.every((r) => r.type === "TRANSFER"), "T1: devono esistere due movimenti TRANSFER collegati all'ordine.");
  assert(completeEvents.length === 3 && completeEvents.map((r) => r.toStatus).join(",") === "transferring,shipped,delivered" && completeEvents.every((r) => r.source === "delivery_confirm"), "T1: storico deve contenere i tre passaggi del percorso composto.");
  assert(completeLabels.length === 1 && completeLabels[0]?.quantity === -15 && completeLabels[0]?.previousStock === 40 && completeLabels[0]?.newStock === 25, "T1: consumo etichette deve essere atomico e tracciato.");
  assert(resultComplete.allocations.length === 2, "T1: risultato deve esporre le due allocazioni FEFO.");

  // T2: preview non scrive e rende esplicito il piano lotti prima della conferma.
  await createOrder({ id: IDS.transferred, batchId: null, quantity: 1 });
  const preview = await previewOrderDelivery({ orderId: IDS.transferred, companyId: TEST_IDS.originCompany });
  const previewWrites = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM "stockMovements" WHERE "sourceDocument" = ${IDS.transferred}
  `;
  assert(preview.canConfirm && preview.allocations.length === 1 && previewWrites[0]?.count === 0, "T2: preview deve proporre FEFO senza scritture.");

  // T3: step già trasferito → spedizione/consegna non scaricano stock una seconda volta.
  await createOrder({ id: IDS.transferred, status: "transferring", batchId: TEST_IDS.batchFourMonths, quantity: 2 });
  const transferredBefore = await stock(TEST_IDS.originCentral, TEST_IDS.batchFourMonths);
  const transferMovementsBefore = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM "stockMovements" WHERE "sourceDocument" = ${IDS.transferred}
  `;
  const resultTransferred = await executeOrderFulfillment({ ...common, orderId: IDS.transferred, targetStatus: "delivered" });
  const transferMovementsAfter = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM "stockMovements" WHERE "sourceDocument" = ${IDS.transferred}
  `;
  assert(await stock(TEST_IDS.originCentral, TEST_IDS.batchFourMonths) === transferredBefore, "T3: uno step già transferring non deve riscaricare il centrale.");
  assert(transferMovementsBefore[0]?.count === transferMovementsAfter[0]?.count && resultTransferred.allocations.length === 0, "T3: non devono comparire ulteriori movimenti TRANSFER.");

  // T4: se E-Keto e SoKeto insieme non bastano, preview e server devono
  // segnalare la giacenza complessiva insufficiente senza scritture.
  await createOrder({ id: IDS.insufficient, batchId: null, quantity: 40 });
  const insufficientBefore = await stock(TEST_IDS.originCentral, TEST_IDS.batchSoon);
  const insufficientPreview = await previewOrderDelivery({ orderId: IDS.insufficient, companyId: TEST_IDS.originCompany });
  let insufficientError = "";
  try {
    await executeOrderFulfillment({ ...common, orderId: IDS.insufficient, targetStatus: "delivered" });
  } catch (error) {
    insufficientError = error instanceof Error ? error.message : String(error);
  }
  const insufficientState = await sql<{ status: string }[]>`SELECT status FROM orders WHERE id = ${IDS.insufficient}`;
  const insufficientMovements = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM "stockMovements" WHERE "sourceDocument" = ${IDS.insufficient}`;
  assert(
    insufficientPreview.reason?.startsWith("Giacenza insufficiente:")
      && insufficientError.startsWith("Giacenza insufficiente:"),
    "T4: quando le due company insieme non bastano, preview e server devono indicare giacenza insufficiente.",
  );
  assert(insufficientState[0]?.status === "pending" && insufficientMovements[0]?.count === 0 && await stock(TEST_IDS.originCentral, TEST_IDS.batchSoon) === insufficientBefore, "T4: insufficienza non deve lasciare scritture parziali.");

  // T5: etichette a zero non bloccano spedizione/consegna; il saldo può diventare negativo.
  await createOrder({ id: IDS.labels, batchId: null, quantity: 1 });
  await sql`UPDATE products SET "labelStock" = 0 WHERE id = ${TEST_IDS.productBoxes}`;
  await executeOrderFulfillment({ ...common, orderId: IDS.labels, targetStatus: "delivered" });
  const labelsState = await sql<{ status: string; labelStock: number; movementCount: number }[]>`
    SELECT o.status, p."labelStock", count(lm.id)::int AS "movementCount"
    FROM orders o
    JOIN "orderItems" oi ON oi."orderId" = o.id
    JOIN products p ON p.id = oi."productId"
    LEFT JOIN "labelMovements" lm ON lm."sourceOrderId" = o.id
    WHERE o.id = ${IDS.labels}
    GROUP BY o.status, p."labelStock"
  `;
  assert(labelsState[0]?.status === "delivered" && labelsState[0]?.labelStock === -1 && labelsState[0]?.movementCount === 1, "T5: etichette a zero devono consentire consegna e registrare saldo negativo.");

  // T6: ordine non pagato → consegna consentita, proforma da creare/conservare e badge Da incassare lato UI.
  await sql`UPDATE products SET "labelStock" = 40 WHERE id = ${TEST_IDS.productBoxes}`;
  await createOrder({ id: IDS.unpaid, paymentStatus: "unpaid", batchId: null, quantity: 1 });
  const deliveryEmails: string[] = [];
  const unpaidDelivery = await fulfillAndRunPostCommit({
    ...common,
    orderId: IDS.unpaid,
    targetStatus: "delivered",
  }, {
    ensureFicDocuments: async ({ orderId }) => {
      await sql`UPDATE orders SET "ficProformaId" = 6001, "ficProformaNumber" = 'PRO-6001' WHERE id = ${orderId}`;
      return { attempted: true, proformaCreated: true, invoiceCreated: false, error: null };
    },
    sendDeliveryEmail: async (input) => { deliveryEmails.push(input.newStatus); },
  });
  const unpaidState = await sql<{ status: string; paymentStatus: string; ficProformaId: number | null; ficInvoiceId: number | null }[]>`
    SELECT status, "paymentStatus", "ficProformaId", "ficInvoiceId" FROM orders WHERE id = ${IDS.unpaid}
  `;
  assert(unpaidDelivery.fic.proformaCreated && unpaidState[0]?.status === "delivered" && unpaidState[0]?.paymentStatus === "unpaid" && unpaidState[0]?.ficProformaId === 6001 && !unpaidState[0]?.ficInvoiceId && deliveryEmails.join(",") === "delivered", "T6: ordine non pagato deve essere consegnabile, generare la sola proforma e restare Da incassare.");

  // T7: pagamento successivo su ordine consegnato → fattura FiC e provvigione, senza mutare l'evasione.
  let commissionCalls = 0;
  let invoiceCalls = 0;
  const paymentEmails: string[] = [];
  const paymentResult = await registerPayment({
    orderId: IDS.unpaid,
    actorUserId: TEST_IDS.adminUser,
    paidAt: new Date("2026-10-21T10:00:00.000Z"),
    paymentMethod: "manual",
  }, {
    calculateCommission: async () => { commissionCalls += 1; },
    transformProformaToInvoice: async (companyId, proformaId) => {
      invoiceCalls += 1;
      assert(companyId === TEST_IDS.originCompany && proformaId === 6001, "T7: fattura FiC deve usare company e proforma dell'ordine consegnato.");
      return { ficInvoiceId: 6002, ficInvoiceNumber: "FAT-6002" };
    },
    sendPaymentEmail: async (input) => { paymentEmails.push(input.newStatus); },
  });
  const paidState = await sql<{ status: string; paymentStatus: string; ficInvoiceId: number | null }[]>`SELECT status, "paymentStatus", "ficInvoiceId" FROM orders WHERE id = ${IDS.unpaid}`;
  assert(paymentResult.ficInvoiceId === 6002 && paidState[0]?.status === "delivered" && paidState[0]?.paymentStatus === "paid" && paidState[0]?.ficInvoiceId === 6002 && commissionCalls === 1 && invoiceCalls === 1 && paymentEmails.join(",") === "payment_received", "T7: pagamento post-consegna deve generare fattura e calcolare la provvigione senza riaprire l'evasione.");

  // T8: M11.D inter-company è fail-closed per entrambi i percorsi.
  let intercompanyError = "";
  try {
    await executeOrderFulfillment({ ...common, orderId: TEST_IDS.orderIntercompany, targetStatus: "delivered" });
  } catch (error) {
    intercompanyError = error instanceof Error ? error.message : String(error);
  }
  assert(intercompanyError.includes("inter-company"), "T8: ordine M11.D deve essere esplicitamente escluso.");

  // T9: evento storico manuale della sola transizione (annullamento è coperto dal service dedicato) non è duplicato dal percorso composto.
  const eventCount = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM order_status_events WHERE "orderId" = ${IDS.complete}
  `;
  assert(eventCount[0]?.count === 3, "T9: il percorso composto deve registrare una sola volta ogni passaggio di stato.");

  // T10: due conferme concorrenti sulla STESSA riga producono una sola consegna e un solo scarico.
  await createOrder({ id: IDS.concurrent, batchId: null, quantity: 1 });
  const concurrentBefore = (await stock(TEST_IDS.originCentral, TEST_IDS.batchSoon))
    + (await stock(TEST_IDS.originCentral, TEST_IDS.batchFourMonths));
  const concurrentResults = await Promise.all([
    executeOrderFulfillment({ ...common, orderId: IDS.concurrent, targetStatus: "delivered" }),
    executeOrderFulfillment({ ...common, orderId: IDS.concurrent, targetStatus: "delivered" }),
  ]);
  const concurrentMovements = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM "stockMovements" WHERE "sourceDocument" = ${IDS.concurrent}
  `;
  const concurrentLabels = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM "labelMovements" WHERE "sourceOrderId" = ${IDS.concurrent}
  `;
  assert(concurrentResults.filter((result) => !result.idempotent).length === 1 && concurrentResults.filter((result) => result.idempotent).length === 1, "T10: una sola richiesta concorrente deve eseguire la consegna.");
  const concurrentAfter = (await stock(TEST_IDS.originCentral, TEST_IDS.batchSoon))
    + (await stock(TEST_IDS.originCentral, TEST_IDS.batchFourMonths));
  assert(concurrentAfter === concurrentBefore - 6 && concurrentMovements[0]?.count === 1 && concurrentLabels[0]?.count === 1, "T10: stock, movimento ed etichette devono essere registrati una sola volta.");

  // T11: errore FiC post-commit non annulla la consegna; Riprova recupera i documenti senza generare una seconda email.
  await createOrder({ id: IDS.ficFailure, batchId: null, quantity: 1 });
  let ficAttempts = 0;
  const sentEmails: Array<{ newStatus: string; orderId: string }> = [];
  const simulatedFic = async ({ orderId }: { orderId: string; companyId: string }) => {
    ficAttempts += 1;
    if (ficAttempts === 1) {
      return { attempted: true, proformaCreated: false, invoiceCreated: false, error: "FiC simulato non disponibile" };
    }
    await sql`
      UPDATE orders
      SET "ficProformaId" = 7001, "ficProformaNumber" = 'PRO-TEST-7001', "ficInvoiceId" = 7002, "ficInvoiceNumber" = 'FAT-TEST-7002'
      WHERE id = ${orderId}
    `;
    return { attempted: true, proformaCreated: true, invoiceCreated: true, error: null };
  };
  const ficFailureResult = await fulfillAndRunPostCommit({
    ...common,
    orderId: IDS.ficFailure,
    targetStatus: "delivered",
  }, {
    ensureFicDocuments: simulatedFic,
    sendDeliveryEmail: async (input) => { sentEmails.push({ newStatus: input.newStatus, orderId: input.orderId }); },
  });
  const [afterFicFailure] = await sql<{ status: string; paymentStatus: string; ficProformaId: number | null; ficInvoiceId: number | null }[]>`
    SELECT status, "paymentStatus", "ficProformaId", "ficInvoiceId" FROM orders WHERE id = ${IDS.ficFailure}
  `;
  const ficAlertVisible = afterFicFailure?.status === "delivered"
    && afterFicFailure.paymentStatus === "paid"
    && (!afterFicFailure.ficProformaId || !afterFicFailure.ficInvoiceId);
  assert(ficFailureResult.fic.error === "FiC simulato non disponibile" && ficAlertVisible, "T11: errore FiC deve lasciare l'ordine consegnato e rendere visibile l'avviso Documento FiC non generato.");
  assert(sentEmails.length === 1 && sentEmails[0]?.newStatus === "delivered" && sentEmails[0]?.orderId === IDS.ficFailure, "T11: il percorso composto deve inviare una sola email Consegnato, senza email intermedie.");
  const ficRetryResult = await retryFicDocumentsAfterFulfillment({ orderId: IDS.ficFailure, companyId: TEST_IDS.originCompany }, { ensureFicDocuments: simulatedFic });
  const [afterFicRetry] = await sql<{ ficProformaId: number | null; ficInvoiceId: number | null }[]>`
    SELECT "ficProformaId", "ficInvoiceId" FROM orders WHERE id = ${IDS.ficFailure}
  `;
  assert(ficRetryResult.error === null && afterFicRetry?.ficProformaId === 7001 && afterFicRetry?.ficInvoiceId === 7002 && sentEmails.length === 1, "T11: Riprova deve recuperare i documenti senza mutare evasione o inviare una seconda email.");

  // T12: scorta disponibile solo nell'altra company -> preview e server
  // devono indicare il travaso necessario e non effettuare scritture.
  await sql`DELETE FROM "inventoryByBatch" WHERE "batchId" = ${TEST_IDS.batchExpired}`;
  await sql`
    INSERT INTO "productBatches" (id, "productId", "batchNumber", "expirationDate", "initialQuantity", "costPrice", "companyId")
    VALUES (${IDS.soketoOnlyBatch}, ${TEST_IDS.productPieces}, 'TEST-SOLO-SOKETO', '2027-12-31', 50, '1.0000', ${TEST_IDS.soketoCompany})
  `;
  await sql`
    INSERT INTO "inventoryByBatch" ("locationId", "batchId", quantity, "companyId")
    VALUES (${TEST_IDS.soketoCentral}, ${IDS.soketoOnlyBatch}, 50, ${TEST_IDS.soketoCompany})
  `;
  await createOrder({ id: IDS.otherCompanyOnly, productId: TEST_IDS.productPieces, batchId: null, quantity: 1 });
  const otherCompanyPreview = await previewOrderDelivery({ orderId: IDS.otherCompanyOnly, companyId: TEST_IDS.originCompany });
  let otherCompanyError = "";
  try {
    await executeOrderFulfillment({ ...common, orderId: IDS.otherCompanyOnly, targetStatus: "delivered" });
  } catch (error) {
    otherCompanyError = error instanceof Error ? error.message : String(error);
  }
  const otherCompanyMovements = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM "stockMovements" WHERE "sourceDocument" = ${IDS.otherCompanyOnly}
  `;
  const otherCompanyState = await sql<{ status: string }[]>`SELECT status FROM orders WHERE id = ${IDS.otherCompanyOnly}`;
  const expectedTransferMessage = "Travaso necessario: TEST Prodotto Pezzo Singolo, mancano 1 pz su TEST E-Keto Food.";
  assert(
    otherCompanyPreview.reason === expectedTransferMessage && otherCompanyError === expectedTransferMessage,
    "T12: disponibilità solo nell'altra company deve allineare preview e server sul messaggio di travaso richiesto.",
  );
  assert(otherCompanyMovements[0]?.count === 0 && otherCompanyState[0]?.status === "pending" && await stock(TEST_IDS.soketoCentral, IDS.soketoOnlyBatch) === 50, "T12: nessuna scrittura deve interessare stock, movimenti o stato quando serve un travaso.");

  // T13: lotto originario a zero ma prodotto disponibile -> solo opzione A;
  // il server rialloca FEFO, registra audit e non duplica al retry.
  await sql`UPDATE "inventoryByBatch" SET quantity = 0 WHERE "locationId" = ${TEST_IDS.originCentral} AND "batchId" = ${TEST_IDS.batchSoon}`;
  await sql`UPDATE "inventoryByBatch" SET quantity = 120 WHERE "locationId" = ${TEST_IDS.originCentral} AND "batchId" = ${TEST_IDS.batchFourMonths}`;
  await sql`UPDATE products SET "labelStock" = 40 WHERE id = ${TEST_IDS.productBoxes}`;
  await createOrder({ id: IDS.reallocatedZero, batchId: TEST_IDS.batchSoon, quantity: 2 });
  const [zeroItem] = await sql<{ id: string }[]>`SELECT id FROM "orderItems" WHERE "orderId" = ${IDS.reallocatedZero}`;
  const zeroPreview = await previewOrderDelivery({ orderId: IDS.reallocatedZero, companyId: TEST_IDS.originCompany });
  assert(zeroPreview.requiresExceptions && zeroPreview.exceptionItems.length === 1 && zeroPreview.exceptionItems[0]?.reallocated.available && !zeroPreview.exceptionItems[0]?.noStockMovement.available, "T13: lotto zero con prodotto disponibile deve offrire solo riallocazione e scarico.");
  const zeroResult = await executeOrderFulfillment({
    ...common,
    orderId: IDS.reallocatedZero,
    targetStatus: "delivered",
    exceptions: [{ orderItemId: zeroItem!.id, exceptionType: "reallocated", reason: "Lotto storico esaurito: riallocazione FEFO." }],
  });
  const [zeroAudit] = await sql<{ exceptionType: string; originalBatchQuantityAtAction: number; productCentralQuantityAtAction: number; replacementAllocations: Array<{ batchId: string; quantityPackages: number }> }[]>`
    SELECT "exceptionType", "originalBatchQuantityAtAction", "productCentralQuantityAtAction", "replacementAllocations"
    FROM order_item_fulfillment_exceptions WHERE "orderItemId" = ${zeroItem!.id}
  `;
  const zeroMovements = await sql<{ batchId: string; quantity: number }[]>`SELECT "batchId", quantity FROM "stockMovements" WHERE "sourceDocument" = ${IDS.reallocatedZero}`;
  const zeroLabels = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM "labelMovements" WHERE "sourceOrderId" = ${IDS.reallocatedZero}`;
  const zeroEvents = await sql<{ source: string }[]>`SELECT source FROM order_status_events WHERE "orderId" = ${IDS.reallocatedZero}`;
  const zeroRetry = await executeOrderFulfillment({
    ...common,
    orderId: IDS.reallocatedZero,
    targetStatus: "delivered",
    exceptions: [{ orderItemId: zeroItem!.id, exceptionType: "reallocated", reason: "Retry innocuo" }],
  });
  const [zeroAuditCount] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM order_item_fulfillment_exceptions WHERE "orderId" = ${IDS.reallocatedZero}`;
  assert(zeroResult.newStatus === "delivered" && zeroAudit?.exceptionType === "reallocated" && zeroAudit.originalBatchQuantityAtAction === 0 && zeroAudit.productCentralQuantityAtAction === 120, "T13: audit riallocazione deve congelare correttamente le giacenze rilevate.");
  assert(zeroAudit.replacementAllocations.length === 1 && zeroAudit.replacementAllocations[0]?.batchId === TEST_IDS.batchFourMonths && zeroAudit.replacementAllocations[0]?.quantityPackages === 2 && zeroMovements.length === 1 && zeroMovements[0]?.batchId === TEST_IDS.batchFourMonths && zeroLabels[0]?.count === 1, "T13: riallocazione deve scaricare il lotto FEFO effettivo e consumare etichette una sola volta.");
  assert(zeroEvents.every((event) => event.source === "delivery_exception") && zeroRetry.idempotent && zeroAuditCount.count === 1, "T13: retry deve restare idempotente senza doppio audit.");

  // T14: lotto e prodotto a zero -> solo opzione B; nessun movimento né etichetta.
  await sql`UPDATE "inventoryByBatch" SET quantity = 0 WHERE "locationId" = ${TEST_IDS.originCentral} AND "batchId" IN (${TEST_IDS.batchSoon}, ${TEST_IDS.batchFourMonths})`;
  await sql`UPDATE products SET "labelStock" = 40 WHERE id = ${TEST_IDS.productBoxes}`;
  await createOrder({ id: IDS.noStockMovement, batchId: TEST_IDS.batchSoon, quantity: 1 });
  const [noStockItem] = await sql<{ id: string }[]>`SELECT id FROM "orderItems" WHERE "orderId" = ${IDS.noStockMovement}`;
  const noStockPreview = await previewOrderDelivery({ orderId: IDS.noStockMovement, companyId: TEST_IDS.originCompany });
  assert(noStockPreview.requiresExceptions && noStockPreview.exceptionItems.length === 1 && !noStockPreview.exceptionItems[0]?.reallocated.available && noStockPreview.exceptionItems[0]?.noStockMovement.available, "T14: lotto e prodotto a zero devono offrire solo evasione senza scarico.");
  await executeOrderFulfillment({
    ...common,
    orderId: IDS.noStockMovement,
    targetStatus: "delivered",
    exceptions: [{ orderItemId: noStockItem!.id, exceptionType: "no_stock_movement", reason: "Merce già consegnata, lotto esaurito." }],
  });
  const [noStockAudit] = await sql<{ exceptionType: string; replacementAllocations: unknown[] }[]>`SELECT "exceptionType", "replacementAllocations" FROM order_item_fulfillment_exceptions WHERE "orderItemId" = ${noStockItem!.id}`;
  const [noStockMovementCount] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM "stockMovements" WHERE "sourceDocument" = ${IDS.noStockMovement}`;
  const [noStockLabelCount] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM "labelMovements" WHERE "sourceOrderId" = ${IDS.noStockMovement}`;
  const [noStockState] = await sql<{ status: string; labelStock: number }[]>`SELECT o.status, p."labelStock" FROM orders o JOIN products p ON p.id = ${TEST_IDS.productBoxes} WHERE o.id = ${IDS.noStockMovement}`;
  assert(noStockAudit?.exceptionType === "no_stock_movement" && noStockAudit.replacementAllocations.length === 0 && noStockMovementCount.count === 0 && noStockLabelCount.count === 0 && noStockState?.status === "delivered" && noStockState.labelStock === 40, "T14: evasione senza scarico non deve mutare stock, movimenti o etichette.");

  // T15: lotto parzialmente disponibile -> A include anche il suo residuo nel FEFO.
  await sql`UPDATE "inventoryByBatch" SET quantity = CASE WHEN "batchId" = ${TEST_IDS.batchSoon} THEN 6 ELSE 6 END WHERE "locationId" = ${TEST_IDS.originCentral} AND "batchId" IN (${TEST_IDS.batchSoon}, ${TEST_IDS.batchFourMonths})`;
  await sql`UPDATE products SET "labelStock" = 40 WHERE id = ${TEST_IDS.productBoxes}`;
  await createOrder({ id: IDS.reallocatedPartial, batchId: TEST_IDS.batchSoon, quantity: 2 });
  const [partialItem] = await sql<{ id: string }[]>`SELECT id FROM "orderItems" WHERE "orderId" = ${IDS.reallocatedPartial}`;
  const partialPreview = await previewOrderDelivery({ orderId: IDS.reallocatedPartial, companyId: TEST_IDS.originCompany });
  assert(partialPreview.exceptionItems.length === 1 && partialPreview.exceptionItems[0]?.reallocated.available && !partialPreview.exceptionItems[0]?.noStockMovement.available, "T15: lotto parziale e prodotto sufficiente devono offrire solo riallocazione.");
  await executeOrderFulfillment({
    ...common,
    orderId: IDS.reallocatedPartial,
    targetStatus: "delivered",
    exceptions: [{ orderItemId: partialItem!.id, exceptionType: "reallocated", reason: "Riallocazione FEFO con residuo lotto storico." }],
  });
  const [partialAudit] = await sql<{ replacementAllocations: Array<{ batchId: string; quantityPackages: number }> }[]>`SELECT "replacementAllocations" FROM order_item_fulfillment_exceptions WHERE "orderItemId" = ${partialItem!.id}`;
  const partialMovements = await sql<{ batchId: string; quantity: number }[]>`SELECT "batchId", quantity FROM "stockMovements" WHERE "sourceDocument" = ${IDS.reallocatedPartial} ORDER BY "batchId"`;
  assert(partialAudit.replacementAllocations.length === 2 && partialAudit.replacementAllocations.some((allocation) => allocation.batchId === TEST_IDS.batchSoon && allocation.quantityPackages === 1) && partialAudit.replacementAllocations.some((allocation) => allocation.batchId === TEST_IDS.batchFourMonths && allocation.quantityPackages === 1), "T15: la riallocazione deve includere il residuo del lotto originario e il lotto FEFO successivo.");
  assert(partialMovements.length === 2 && partialMovements.every((movement) => movement.quantity === 6), "T15: ogni lotto FEFO deve generare il proprio movimento reale di 6 pezzi.");

  // T16: ordine misto — una riga normale e una riallocata nello stesso commit.
  await sql`UPDATE "inventoryByBatch" SET quantity = CASE WHEN "batchId" = ${TEST_IDS.batchSoon} THEN 0 ELSE 12 END WHERE "locationId" = ${TEST_IDS.originCentral} AND "batchId" IN (${TEST_IDS.batchSoon}, ${TEST_IDS.batchFourMonths})`;
  await sql`UPDATE products SET "labelStock" = 40 WHERE id = ${TEST_IDS.productBoxes}`;
  await createOrder({ id: IDS.mixed, batchId: TEST_IDS.batchFourMonths, quantity: 1 });
  await sql`
    INSERT INTO "orderItems" ("orderId", "productId", "batchId", quantity, "unitPriceBase", "discountPercent", "unitPriceFinal", "vatRate", "lineTotalNet", "lineTotalGross", "productSku", "productName")
    VALUES (${IDS.mixed}, ${TEST_IDS.productBoxes}, ${TEST_IDS.batchSoon}, 1, 10, 0, 10, 10, 10, 11, 'TEST-BOX-6', 'TEST Prodotto Confezione 6')
  `;
  const mixedItems = await sql<{ id: string; batchId: string }[]>`SELECT id, "batchId" FROM "orderItems" WHERE "orderId" = ${IDS.mixed}`;
  const mixedStaleItem = mixedItems.find((item) => item.batchId === TEST_IDS.batchSoon)!;
  await executeOrderFulfillment({
    ...common,
    orderId: IDS.mixed,
    targetStatus: "delivered",
    exceptions: [{ orderItemId: mixedStaleItem.id, exceptionType: "reallocated", reason: "Riallocazione della sola riga con lotto storico esaurito." }],
  });
  const [mixedAuditCount] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM order_item_fulfillment_exceptions WHERE "orderId" = ${IDS.mixed}`;
  const mixedMovements = await sql<{ quantity: number }[]>`SELECT quantity FROM "stockMovements" WHERE "sourceDocument" = ${IDS.mixed}`;
  const [mixedLabel] = await sql<{ quantity: number }[]>`SELECT quantity FROM "labelMovements" WHERE "sourceOrderId" = ${IDS.mixed}`;
  assert(mixedAuditCount.count === 1 && mixedMovements.length === 2 && mixedMovements.every((movement) => movement.quantity === 6) && mixedLabel?.quantity === -2, "T16: la riga normale deve essere scaricata insieme a quella riallocata e le etichette restano aggregate.");

  // T17: il motivo vuoto è bloccato prima di qualsiasi scrittura.
  await sql`UPDATE "inventoryByBatch" SET quantity = 0 WHERE "locationId" = ${TEST_IDS.originCentral} AND "batchId" IN (${TEST_IDS.batchSoon}, ${TEST_IDS.batchFourMonths})`;
  await createOrder({ id: IDS.missingReason, batchId: TEST_IDS.batchSoon, quantity: 1 });
  const [missingReasonItem] = await sql<{ id: string }[]>`SELECT id FROM "orderItems" WHERE "orderId" = ${IDS.missingReason}`;
  let missingReasonError = "";
  try {
    await executeOrderFulfillment({
      ...common,
      orderId: IDS.missingReason,
      targetStatus: "delivered",
      exceptions: [{ orderItemId: missingReasonItem!.id, exceptionType: "no_stock_movement", reason: "   " }],
    });
  } catch (error) {
    missingReasonError = error instanceof Error ? error.message : String(error);
  }
  const [missingReasonState] = await sql<{ status: string }[]>`SELECT status FROM orders WHERE id = ${IDS.missingReason}`;
  const [missingReasonAuditCount] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM order_item_fulfillment_exceptions WHERE "orderId" = ${IDS.missingReason}`;
  const [missingReasonMovementCount] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM "stockMovements" WHERE "sourceDocument" = ${IDS.missingReason}`;
  assert(missingReasonError.includes("motivo") && missingReasonState?.status === "pending" && missingReasonAuditCount.count === 0 && missingReasonMovementCount.count === 0, "T17: motivo assente deve bloccare audit, movimenti e cambio stato.");

  // T18: report admin filtrabile per company, periodo e tipo, con audit e
  // allocazioni sostitutive leggibili. L'azienda arriva dal middleware.
  await sql`
    INSERT INTO "userCompanyAccess" ("userId", "companyId", "isDefault")
    VALUES (${TEST_IDS.adminUser}, ${TEST_IDS.originCompany}, true)
    ON CONFLICT ("userId", "companyId") DO UPDATE SET "isDefault" = true
  `;
  const { reportsRouter } = await import("../server/reports-router");
  const reportCaller = reportsRouter.createCaller({
    req: { headers: { "x-active-company-id": TEST_IDS.originCompany } },
    res: {},
    user: { id: TEST_IDS.adminUser, role: "admin" },
  } as any);
  const exceptionReport = await reportCaller.fulfillmentExceptions.list({
    dateFrom: "2026-01-01",
    dateTo: "2026-12-31",
    limit: 100,
    offset: 0,
  });
  const withoutStockReport = await reportCaller.fulfillmentExceptions.list({
    dateFrom: "2026-01-01",
    dateTo: "2026-12-31",
    exceptionType: "no_stock_movement",
    limit: 100,
    offset: 0,
  });
  assert(exceptionReport.total === 4 && exceptionReport.items.filter((item: any) => item.exceptionType === "reallocated").length === 3 && exceptionReport.items.some((item: any) => Array.isArray(item.replacementAllocations) && item.replacementAllocations.length === 2), "T18: il report deve elencare le eccezioni della company attiva e le riallocazioni FEFO.");
  assert(withoutStockReport.total === 1 && withoutStockReport.items[0]?.exceptionType === "no_stock_movement", "T18: il filtro tipo deve isolare le righe evase senza scarico.");

  // T19: caso richiesto, lotto 1 pz / prodotto 1 pz / ordine 5 pz.
  // La disponibilità nell'altra company è soltanto un avviso; C resta ammessa.
  await sql`INSERT INTO "inventoryByBatch" ("locationId", "batchId", quantity, "companyId") VALUES (${TEST_IDS.originCentral}, ${TEST_IDS.batchExpired}, 1, ${TEST_IDS.originCompany}) ON CONFLICT ("locationId", "batchId") DO UPDATE SET quantity = 1`;
  await sql`UPDATE products SET "labelStock" = 40 WHERE id = ${TEST_IDS.productPieces}`;
  await createOrder({ id: IDS.partialAvailable, productId: TEST_IDS.productPieces, batchId: TEST_IDS.batchExpired, quantity: 5 });
  const [partialAvailableBefore] = await sql<{ id: string; quantity: number; unitPriceFinal: string; lineTotalNet: string; lineTotalGross: string; batchId: string }[]>`SELECT id, quantity, "unitPriceFinal", "lineTotalNet", "lineTotalGross", "batchId" FROM "orderItems" WHERE "orderId" = ${IDS.partialAvailable}`;
  const partialAvailablePreview = await previewOrderDelivery({ orderId: IDS.partialAvailable, companyId: TEST_IDS.originCompany });
  const partialChoice = partialAvailablePreview.exceptionItems[0]!;
  assert(partialChoice.originalBatchQuantity === 1 && partialChoice.productCentralQuantity === 1 && !partialChoice.reallocated.available && !partialChoice.noStockMovement.available && partialChoice.partialNoStockMovement.available, "T19: lotto parziale e prodotto insufficiente devono offrire C, non A/B.");
  assert(partialChoice.partialNoStockMovement.stockMovementQuantityPieces === 1 && partialChoice.partialNoStockMovement.noStockMovementQuantityPieces === 4, "T19: la preview deve distinguere 1 pz scaricato e 4 senza scarico.");
  assert(partialChoice.counterpartyAvailability.companyName === "TEST SoKeto Srl" && partialChoice.counterpartyAvailability.quantityPieces === 50 && partialChoice.counterpartyAvailability.canTransferForReallocation, "T19: disponibilità nell'altra company deve mostrare avviso travaso senza escludere C.");
  const cSelection = { orderItemId: partialAvailableBefore!.id, exceptionType: "partial_no_stock_movement" as const, reason: "Merce già consegnata: scarico solo il disponibile." };
  for (const invalidSelection of [
    { ...cSelection, reason: "   " },
    { ...cSelection, exceptionType: "no_stock_movement" as const },
  ]) {
    let rejected = false;
    try { await executeOrderFulfillment({ ...common, orderId: IDS.partialAvailable, targetStatus: "delivered", exceptions: [invalidSelection] }); } catch { rejected = true; }
    assert(rejected && await stock(TEST_IDS.originCentral, TEST_IDS.batchExpired) === 1, "T19: motivo mancante o opzione non disponibile devono essere rifiutati senza scarichi.");
  }
  const partialAvailableResults = await Promise.all([
    executeOrderFulfillment({ ...common, orderId: IDS.partialAvailable, targetStatus: "delivered", exceptions: [cSelection] }),
    executeOrderFulfillment({ ...common, orderId: IDS.partialAvailable, targetStatus: "delivered", exceptions: [cSelection] }),
  ]);
  const [partialAvailableAudit] = await sql<{ stockMovementQuantityPieces: number; noStockMovementQuantityPieces: number; exceptionType: string }[]>`SELECT "stockMovementQuantityPieces", "noStockMovementQuantityPieces", "exceptionType" FROM order_item_fulfillment_exceptions WHERE "orderItemId" = ${cSelection.orderItemId}`;
  const partialAvailableMovements = await sql<{ quantity: number; batchId: string }[]>`SELECT quantity, "batchId" FROM "stockMovements" WHERE "sourceDocument" = ${IDS.partialAvailable}`;
  const [partialAvailableAfter] = await sql<{ id: string; quantity: number; unitPriceFinal: string; lineTotalNet: string; lineTotalGross: string; batchId: string }[]>`SELECT id, quantity, "unitPriceFinal", "lineTotalNet", "lineTotalGross", "batchId" FROM "orderItems" WHERE "orderId" = ${IDS.partialAvailable}`;
  const [partialAvailableLabels] = await sql<{ quantity: number }[]>`SELECT quantity FROM "labelMovements" WHERE "sourceOrderId" = ${IDS.partialAvailable}`;
  const [partialAuditCount] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM order_item_fulfillment_exceptions WHERE "orderId" = ${IDS.partialAvailable}`;
  const partialAvailableEvents = await sql<{ source: string }[]>`SELECT source FROM order_status_events WHERE "orderId" = ${IDS.partialAvailable}`;
  assert(partialAvailableResults.filter((result) => result.idempotent).length === 1 && partialAuditCount.count === 1 && partialAvailableEvents.length === 3 && partialAvailableEvents.every((event) => event.source === "delivery_exception"), "T19: due chiamate concorrenti producono un solo audit e una sola consegna.");
  assert(partialAvailableAudit.stockMovementQuantityPieces === 1 && partialAvailableAudit.noStockMovementQuantityPieces === 4 && partialAvailableAudit.exceptionType === "partial_no_stock_movement", "T19: audit C deve congelare 1 scaricato + 4 senza scarico.");
  assert(partialAvailableMovements.length === 1 && partialAvailableMovements[0]?.quantity === 1 && await stock(TEST_IDS.originCentral, TEST_IDS.batchExpired) === 0 && await stock(TEST_IDS.normalRetailerLocation, TEST_IDS.batchExpired) === 1 && await stock(TEST_IDS.soketoCentral, IDS.soketoOnlyBatch) === 50, "T19: solo 1 pezzo reale deve essere scaricato/caricato, nessun movimento per i 4 mancanti o travaso automatico.");
  assert(JSON.stringify(partialAvailableBefore) === JSON.stringify(partialAvailableAfter) && partialAvailableLabels?.quantity === -1, "T19: quantità/prezzi commerciali invariati; etichette solo per la quota effettivamente scaricata.");

  // T20: confezioni da 6; FEFO C scarica i residui 1 + 5 anche se i singoli
  // lotti non coprono una confezione. Nessuna riga ordine frazionaria.
  await sql`UPDATE "inventoryByBatch" SET quantity = CASE WHEN "batchId" = ${TEST_IDS.batchSoon} THEN 1 ELSE 5 END WHERE "locationId" = ${TEST_IDS.originCentral} AND "batchId" IN (${TEST_IDS.batchSoon}, ${TEST_IDS.batchFourMonths})`;
  await createOrder({ id: IDS.partialMultiBatch, batchId: TEST_IDS.batchSoon, quantity: 2 });
  const [multiBatchItem] = await sql<{ id: string }[]>`SELECT id FROM "orderItems" WHERE "orderId" = ${IDS.partialMultiBatch}`;
  const multiBatchResult = await executeOrderFulfillment({ ...common, orderId: IDS.partialMultiBatch, targetStatus: "delivered", exceptions: [{ orderItemId: multiBatchItem!.id, exceptionType: "partial_no_stock_movement", reason: "Scarico i residui FEFO e chiudo il resto senza scarico." }] });
  const [multiBatchAudit] = await sql<{ stockMovementQuantityPieces: number; noStockMovementQuantityPieces: number }[]>`SELECT "stockMovementQuantityPieces", "noStockMovementQuantityPieces" FROM order_item_fulfillment_exceptions WHERE "orderItemId" = ${multiBatchItem!.id}`;
  const [multiBatchCommercial] = await sql<{ quantity: number; count: number }[]>`SELECT SUM(quantity)::int AS quantity, COUNT(*)::int AS count FROM "orderItems" WHERE "orderId" = ${IDS.partialMultiBatch}`;
  const [multiBatchLabels] = await sql<{ quantity: number }[]>`SELECT quantity FROM "labelMovements" WHERE "sourceOrderId" = ${IDS.partialMultiBatch}`;
  assert(multiBatchResult.allocations.length === 2 && multiBatchResult.allocations.some((allocation) => allocation.batchId === TEST_IDS.batchSoon && allocation.quantityPieces === 1) && multiBatchResult.allocations.some((allocation) => allocation.batchId === TEST_IDS.batchFourMonths && allocation.quantityPieces === 5), "T20: C deve scaricare tutti i pezzi FEFO, non solo confezioni complete per lotto.");
  assert(multiBatchAudit.stockMovementQuantityPieces === 6 && multiBatchAudit.noStockMovementQuantityPieces === 6 && multiBatchCommercial.quantity === 2 && multiBatchCommercial.count === 1, "T20: audit 6 + 6 pezzi; riga finanziaria unica da 2 confezioni invariata.");
  assert(multiBatchLabels?.quantity === -1, "T20: 1 + 5 pezzi di lotti diversi formano una confezione: una sola etichetta, non due.");

  // T21: le prenotazioni delle righe normali non vengono rubate da C.
  await sql`UPDATE "inventoryByBatch" SET quantity = CASE WHEN "batchId" = ${TEST_IDS.batchSoon} THEN 1 ELSE 11 END WHERE "locationId" = ${TEST_IDS.originCentral} AND "batchId" IN (${TEST_IDS.batchSoon}, ${TEST_IDS.batchFourMonths})`;
  await createOrder({ id: IDS.partialMixed, batchId: TEST_IDS.batchSoon, quantity: 3 });
  const [partialMixedItem] = await sql<{ id: string }[]>`SELECT id FROM "orderItems" WHERE "orderId" = ${IDS.partialMixed}`;
  await sql`INSERT INTO "orderItems" ("orderId", "productId", "batchId", quantity, "unitPriceBase", "discountPercent", "unitPriceFinal", "vatRate", "lineTotalNet", "lineTotalGross", "productSku", "productName") VALUES (${IDS.partialMixed}, ${TEST_IDS.productBoxes}, ${TEST_IDS.batchFourMonths}, 1, 10, 0, 10, 10, 10, 11, 'TEST-BOX-6', 'TEST Prodotto Confezione 6')`;
  await executeOrderFulfillment({ ...common, orderId: IDS.partialMixed, targetStatus: "delivered", exceptions: [{ orderItemId: partialMixedItem!.id, exceptionType: "partial_no_stock_movement", reason: "Scarico il disponibile dopo le quote delle altre righe." }] });
  const [partialMixedAudit] = await sql<{ stockMovementQuantityPieces: number; noStockMovementQuantityPieces: number }[]>`SELECT "stockMovementQuantityPieces", "noStockMovementQuantityPieces" FROM order_item_fulfillment_exceptions WHERE "orderItemId" = ${partialMixedItem!.id}`;
  const [partialMixedTransferred] = await sql<{ quantity: number }[]>`SELECT SUM(quantity)::int AS quantity FROM "stockMovements" WHERE "sourceDocument" = ${IDS.partialMixed}`;
  assert(partialMixedAudit.stockMovementQuantityPieces === 6 && partialMixedAudit.noStockMovementQuantityPieces === 12 && partialMixedTransferred.quantity === 12 && await stock(TEST_IDS.originCentral, TEST_IDS.batchSoon) === 0 && await stock(TEST_IDS.originCentral, TEST_IDS.batchFourMonths) === 0, "T21: C deve usare un piano condiviso senza scaricare due volte le quote prenotate per le righe normali.");

  // T22: due righe C che competono per un solo pezzo -> errore tutto-o-niente,
  // mai un finto scarico a zero o la conversione silenziosa della seconda in B.
  await sql`UPDATE "inventoryByBatch" SET quantity = 1 WHERE "locationId" = ${TEST_IDS.originCentral} AND "batchId" = ${TEST_IDS.batchExpired}`;
  await createOrder({ id: IDS.partialCompeting, productId: TEST_IDS.productPieces, batchId: TEST_IDS.batchExpired, quantity: 5 });
  await sql`INSERT INTO "orderItems" ("orderId", "productId", "batchId", quantity, "unitPriceBase", "discountPercent", "unitPriceFinal", "vatRate", "lineTotalNet", "lineTotalGross", "productSku", "productName") VALUES (${IDS.partialCompeting}, ${TEST_IDS.productPieces}, ${TEST_IDS.batchExpired}, 5, 10, 0, 10, 10, 50, 55, 'TEST-PZ-1', 'TEST Prodotto Pezzo Singolo')`;
  const competingItems = await sql<{ id: string }[]>`SELECT id FROM "orderItems" WHERE "orderId" = ${IDS.partialCompeting}`;
  let competingError = "";
  try { await executeOrderFulfillment({ ...common, orderId: IDS.partialCompeting, targetStatus: "delivered", exceptions: competingItems.map((item) => ({ orderItemId: item.id, exceptionType: "partial_no_stock_movement", reason: "Chiusura del residuo storico." })) }); } catch (error) { competingError = error instanceof Error ? error.message : String(error); }
  const [competingEffects] = await sql<{ audits: number; movements: number; events: number; status: string }[]>`SELECT (SELECT COUNT(*)::int FROM order_item_fulfillment_exceptions WHERE "orderId" = ${IDS.partialCompeting}) AS audits, (SELECT COUNT(*)::int FROM "stockMovements" WHERE "sourceDocument" = ${IDS.partialCompeting}) AS movements, (SELECT COUNT(*)::int FROM order_status_events WHERE "orderId" = ${IDS.partialCompeting}) AS events, status FROM orders WHERE id = ${IDS.partialCompeting}`;
  assert(competingError.includes("impegnata da altre righe") && competingEffects.audits === 0 && competingEffects.movements === 0 && competingEffects.events === 0 && competingEffects.status === "pending" && await stock(TEST_IDS.originCentral, TEST_IDS.batchExpired) === 1, "T22: righe C concorrenti non devono creare giacenze negative né effetti parziali.");

  // T23: report C espone esplicitamente quota reale e quota senza movimento.
  const partialReport = await reportCaller.fulfillmentExceptions.list({ dateFrom: "2026-01-01", dateTo: "2026-12-31", exceptionType: "partial_no_stock_movement", limit: 100, offset: 0 });
  const partialReportItem = partialReport.items.find((item: any) => item.orderId === IDS.partialAvailable);
  assert(partialReport.total === 3 && partialReportItem?.stockMovementQuantityPieces === 1 && partialReportItem?.noStockMovementQuantityPieces === 4, "T23: il report deve filtrare C e mostrare 1 pz scaricato + 4 senza scarico.");

  // T24: regola approvata: anche una confezione incompleta consuma un'etichetta.
  await sql`UPDATE "inventoryByBatch" SET quantity = CASE WHEN "batchId" = ${TEST_IDS.batchSoon} THEN 1 ELSE 0 END WHERE "locationId" = ${TEST_IDS.originCentral} AND "batchId" IN (${TEST_IDS.batchSoon}, ${TEST_IDS.batchFourMonths})`;
  await createOrder({ id: IDS.partialIncompletePackage, batchId: TEST_IDS.batchSoon, quantity: 1 });
  const [incompleteItem] = await sql<{ id: string }[]>`SELECT id FROM "orderItems" WHERE "orderId" = ${IDS.partialIncompletePackage}`;
  await executeOrderFulfillment({ ...common, orderId: IDS.partialIncompletePackage, targetStatus: "delivered", exceptions: [{ orderItemId: incompleteItem!.id, exceptionType: "partial_no_stock_movement", reason: "Scarico 1 pezzo della confezione, resto già consegnato." }] });
  const [incompleteAudit] = await sql<{ stockMovementQuantityPieces: number; noStockMovementQuantityPieces: number }[]>`SELECT "stockMovementQuantityPieces", "noStockMovementQuantityPieces" FROM order_item_fulfillment_exceptions WHERE "orderItemId" = ${incompleteItem!.id}`;
  const [incompleteLabels] = await sql<{ quantity: number }[]>`SELECT quantity FROM "labelMovements" WHERE "sourceOrderId" = ${IDS.partialIncompletePackage}`;
  assert(incompleteAudit.stockMovementQuantityPieces === 1 && incompleteAudit.noStockMovementQuantityPieces === 5 && incompleteLabels?.quantity === -1, "T24: 1 pz su 6 deve scaricare 1, chiudere 5 senza movimenti e consumare una sola etichetta.");

  // T25: lotto originario zero, due pezzi di prodotto su un lotto attuale.
  // Solo C: B non deve consentire di ignorare la giacenza positiva disponibile.
  await sql`UPDATE "inventoryByBatch" SET quantity = 0 WHERE "locationId" = ${TEST_IDS.originCentral} AND "batchId" = ${TEST_IDS.batchExpired}`;
  await sql`INSERT INTO "productBatches" (id, "productId", "batchNumber", "expirationDate", "initialQuantity", "costPrice", "companyId") VALUES (${IDS.partialZeroReplacementBatch}, ${TEST_IDS.productPieces}, 'TEST-C-ZERO-FEFO', '2027-12-31', 2, '1.0000', ${TEST_IDS.originCompany})`;
  await sql`INSERT INTO "inventoryByBatch" ("locationId", "batchId", quantity, "companyId") VALUES (${TEST_IDS.originCentral}, ${IDS.partialZeroReplacementBatch}, 2, ${TEST_IDS.originCompany})`;
  await createOrder({ id: IDS.partialZeroBatch, productId: TEST_IDS.productPieces, batchId: TEST_IDS.batchExpired, quantity: 5 });
  const [zeroCItem] = await sql<{ id: string }[]>`SELECT id FROM "orderItems" WHERE "orderId" = ${IDS.partialZeroBatch}`;
  const zeroCPreview = await previewOrderDelivery({ orderId: IDS.partialZeroBatch, companyId: TEST_IDS.originCompany });
  const zeroCChoice = zeroCPreview.exceptionItems[0]!;
  assert(zeroCChoice.originalBatchQuantity === 0 && zeroCChoice.productCentralQuantity === 2 && zeroCChoice.partialNoStockMovement.available && !zeroCChoice.noStockMovement.available && !zeroCChoice.reallocated.available, "T25: lotto zero e prodotto parziale devono offrire solo C, non A/B.");
  let zeroBRejected = false;
  try { await executeOrderFulfillment({ ...common, orderId: IDS.partialZeroBatch, targetStatus: "delivered", exceptions: [{ orderItemId: zeroCItem!.id, exceptionType: "no_stock_movement", reason: "Tentativo B con prodotto ancora disponibile." }] }); } catch { zeroBRejected = true; }
  assert(zeroBRejected && await stock(TEST_IDS.originCentral, IDS.partialZeroReplacementBatch) === 2, "T25: B deve essere rifiutata lato server senza movimenti se il prodotto ha giacenza positiva.");
  const oldBatchRetailerStock = await stock(TEST_IDS.normalRetailerLocation, TEST_IDS.batchExpired);
  await executeOrderFulfillment({ ...common, orderId: IDS.partialZeroBatch, targetStatus: "delivered", exceptions: [{ orderItemId: zeroCItem!.id, exceptionType: "partial_no_stock_movement", reason: "Scarico i due pezzi del lotto attuale, resto già consegnato." }] });
  const [zeroCAudit] = await sql<{ originalBatchQuantityAtAction: number; stockMovementQuantityPieces: number; noStockMovementQuantityPieces: number }[]>`SELECT "originalBatchQuantityAtAction", "stockMovementQuantityPieces", "noStockMovementQuantityPieces" FROM order_item_fulfillment_exceptions WHERE "orderItemId" = ${zeroCItem!.id}`;
  const zeroCMovements = await sql<{ batchId: string; quantity: number }[]>`SELECT "batchId", quantity FROM "stockMovements" WHERE "sourceDocument" = ${IDS.partialZeroBatch}`;
  assert(zeroCAudit.originalBatchQuantityAtAction === 0 && zeroCAudit.stockMovementQuantityPieces === 2 && zeroCAudit.noStockMovementQuantityPieces === 3 && zeroCMovements.length === 1 && zeroCMovements[0]?.batchId === IDS.partialZeroReplacementBatch && zeroCMovements[0]?.quantity === 2, "T25: C con lotto zero deve scaricare FEFO 2 pz e auditare 3 senza scarico.");
  assert(await stock(TEST_IDS.originCentral, IDS.partialZeroReplacementBatch) === 0 && await stock(TEST_IDS.normalRetailerLocation, IDS.partialZeroReplacementBatch) === 2 && await stock(TEST_IDS.normalRetailerLocation, TEST_IDS.batchExpired) === oldBatchRetailerStock, "T25: solo il lotto reale viene movimentato, senza giacenza fittizia del lotto originario.");

  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    tests: {
      paidDeliveryWithFefoSplit: "PASS",
      previewReadOnly: "PASS",
      alreadyTransferredNoDoubleStock: "PASS",
      insufficientStockRollback: "PASS",
      labelsNegativeNonBlocking: "PASS",
      unpaidDeliveryAndPaymentInvoice: "PASS",
      paymentAfterDeliveryInvoiceAndCommission: "PASS",
      intercompanyFailClosed: "PASS",
      statusHistoryNoDuplicates: "PASS",
      concurrentSameOrderOneDelivery: "PASS",
      ficFailureRetryAndSingleDeliveryEmail: "PASS",
      otherCompanyOnlyStockRequiresTransfer: "PASS",
      reallocatedZeroBatchAuditAndRetry: "PASS",
      noStockMovementNoInventoryAndNoLabels: "PASS",
      partialBatchReallocationIncludesOriginalRemainder: "PASS",
      mixedNormalAndReallocatedRows: "PASS",
      missingReasonBlocksAllWrites: "PASS",
      fulfillmentExceptionReportFilters: "PASS",
      partialOnePieceOfFiveWithTransferWarningAndConcurrency: "PASS",
      partialMultiBatchLoosePiecesCommercialRowsUnchanged: "PASS",
      partialMixedSharedInventoryReservations: "PASS",
      partialCompetingRowsRollback: "PASS",
      partialExceptionReportFilterAndQuantities: "PASS",
      partialIncompletePackageOneLabel: "PASS",
      zeroBatchPositiveInsufficientProductOnlyPartialOption: "PASS",
    },
    raw: {
      complete: { result: resultComplete, items: completeItems, events: completeEvents, movements: completeMovements, labels: completeLabels },
      preview,
      insufficientPreview,
      transferred: resultTransferred,
      insufficientError,
      labelsState,
      unpaidState,
      paymentResult,
      intercompanyError,
      concurrent: concurrentResults.map((result) => ({ idempotent: result.idempotent, status: result.newStatus })),
      fic: { firstAttempt: ficFailureResult.fic, retry: ficRetryResult, sentEmails },
      otherCompanyError,
      otherCompanyPreview,
      partialAvailable: { preview: partialAvailablePreview, audit: partialAvailableAudit, movements: partialAvailableMovements },
    },
  }, null, 2));
}

main()
  .then(async () => { await sql.end({ timeout: 5 }); process.exit(0); })
  .catch(async (error) => { console.error(error); await sql.end({ timeout: 5 }); process.exit(1); });
