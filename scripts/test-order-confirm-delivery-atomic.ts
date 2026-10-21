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
      ${input.id}, ${`TEST-DELIVERY-${input.id.slice(-1)}`}, ${retailerId}, ${status}, ${paymentStatus}, 10, 1, 11, 0, ${TEST_IDS.adminUser}, ${TEST_IDS.originCompany}
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
  const resultComplete = await executeOrderFulfillment({ ...common, orderId: IDS.complete, targetStatus: "delivered", requirePayment: true });
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
  const resultTransferred = await executeOrderFulfillment({ ...common, orderId: IDS.transferred, targetStatus: "delivered", requirePayment: true });
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
    await executeOrderFulfillment({ ...common, orderId: IDS.insufficient, targetStatus: "delivered", requirePayment: true });
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

  // T5: insufficienza etichette → stesso rollback atomico di stock e stati.
  await createOrder({ id: IDS.labels, batchId: null, quantity: 1 });
  await sql`UPDATE products SET "labelStock" = 0 WHERE id = ${TEST_IDS.productBoxes}`;
  const labelsStockBefore = await stock(TEST_IDS.originCentral, TEST_IDS.batchSoon);
  let labelsError = "";
  try {
    await executeOrderFulfillment({ ...common, orderId: IDS.labels, targetStatus: "delivered", requirePayment: true });
  } catch (error) {
    labelsError = error instanceof Error ? error.message : String(error);
  }
  const labelsState = await sql<{ status: string }[]>`SELECT status FROM orders WHERE id = ${IDS.labels}`;
  assert(labelsError.includes("Etichette insufficienti") && labelsState[0]?.status === "pending" && await stock(TEST_IDS.originCentral, TEST_IDS.batchSoon) === labelsStockBefore, "T5: errore etichette deve fare rollback completo.");

  // T6: ordine non pagato → rifiutato dal server, anche senza UI.
  await sql`UPDATE products SET "labelStock" = 40 WHERE id = ${TEST_IDS.productBoxes}`;
  await createOrder({ id: IDS.unpaid, paymentStatus: "unpaid", batchId: null, quantity: 1 });
  let unpaidError = "";
  try {
    await executeOrderFulfillment({ ...common, orderId: IDS.unpaid, targetStatus: "delivered", requirePayment: true });
  } catch (error) {
    unpaidError = error instanceof Error ? error.message : String(error);
  }
  assert(unpaidError.includes("pagamento"), "T6: ordine non pagato deve essere bloccato lato server.");

  // T7: M11.D inter-company è fail-closed per entrambi i percorsi.
  let intercompanyError = "";
  try {
    await executeOrderFulfillment({ ...common, orderId: TEST_IDS.orderIntercompany, targetStatus: "delivered", requirePayment: true });
  } catch (error) {
    intercompanyError = error instanceof Error ? error.message : String(error);
  }
  assert(intercompanyError.includes("inter-company"), "T7: ordine M11.D deve essere esplicitamente escluso.");

  // T8: evento storico manuale della sola transizione (annullamento è coperto dal service dedicato) non è duplicato dal percorso composto.
  const eventCount = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM order_status_events WHERE "orderId" = ${IDS.complete}
  `;
  assert(eventCount[0]?.count === 3, "T8: il percorso composto deve registrare una sola volta ogni passaggio di stato.");

  // T9: due conferme concorrenti sulla STESSA riga producono una sola consegna e un solo scarico.
  await createOrder({ id: IDS.concurrent, batchId: null, quantity: 1 });
  const concurrentBefore = (await stock(TEST_IDS.originCentral, TEST_IDS.batchSoon))
    + (await stock(TEST_IDS.originCentral, TEST_IDS.batchFourMonths));
  const concurrentResults = await Promise.all([
    executeOrderFulfillment({ ...common, orderId: IDS.concurrent, targetStatus: "delivered", requirePayment: true }),
    executeOrderFulfillment({ ...common, orderId: IDS.concurrent, targetStatus: "delivered", requirePayment: true }),
  ]);
  const concurrentMovements = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM "stockMovements" WHERE "sourceDocument" = ${IDS.concurrent}
  `;
  const concurrentLabels = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM "labelMovements" WHERE "sourceOrderId" = ${IDS.concurrent}
  `;
  assert(concurrentResults.filter((result) => !result.idempotent).length === 1 && concurrentResults.filter((result) => result.idempotent).length === 1, "T9: una sola richiesta concorrente deve eseguire la consegna.");
  const concurrentAfter = (await stock(TEST_IDS.originCentral, TEST_IDS.batchSoon))
    + (await stock(TEST_IDS.originCentral, TEST_IDS.batchFourMonths));
  assert(concurrentAfter === concurrentBefore - 6 && concurrentMovements[0]?.count === 1 && concurrentLabels[0]?.count === 1, "T9: stock, movimento ed etichette devono essere registrati una sola volta.");

  // T10: errore FiC post-commit non annulla la consegna; Riprova recupera i documenti senza generare una seconda email.
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
    requirePayment: true,
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
  assert(ficFailureResult.fic.error === "FiC simulato non disponibile" && ficAlertVisible, "T10: errore FiC deve lasciare l'ordine consegnato e rendere visibile l'avviso Documento FiC non generato.");
  assert(sentEmails.length === 1 && sentEmails[0]?.newStatus === "delivered" && sentEmails[0]?.orderId === IDS.ficFailure, "T10: il percorso composto deve inviare una sola email Consegnato, senza email intermedie.");
  const ficRetryResult = await retryFicDocumentsAfterFulfillment({ orderId: IDS.ficFailure, companyId: TEST_IDS.originCompany }, { ensureFicDocuments: simulatedFic });
  const [afterFicRetry] = await sql<{ ficProformaId: number | null; ficInvoiceId: number | null }[]>`
    SELECT "ficProformaId", "ficInvoiceId" FROM orders WHERE id = ${IDS.ficFailure}
  `;
  assert(ficRetryResult.error === null && afterFicRetry?.ficProformaId === 7001 && afterFicRetry?.ficInvoiceId === 7002 && sentEmails.length === 1, "T10: Riprova deve recuperare i documenti senza mutare evasione o inviare una seconda email.");

  // T11: scorta disponibile solo nell'altra company -> preview e server
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
    await executeOrderFulfillment({ ...common, orderId: IDS.otherCompanyOnly, targetStatus: "delivered", requirePayment: true });
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
    "T11: disponibilità solo nell'altra company deve allineare preview e server sul messaggio di travaso richiesto.",
  );
  assert(otherCompanyMovements[0]?.count === 0 && otherCompanyState[0]?.status === "pending" && await stock(TEST_IDS.soketoCentral, IDS.soketoOnlyBatch) === 50, "T11: nessuna scrittura deve interessare stock, movimenti o stato quando serve un travaso.");

  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    tests: {
      paidDeliveryWithFefoSplit: "PASS",
      previewReadOnly: "PASS",
      alreadyTransferredNoDoubleStock: "PASS",
      insufficientStockRollback: "PASS",
      labelFailureRollback: "PASS",
      unpaidServerBlocked: "PASS",
      intercompanyFailClosed: "PASS",
      statusHistoryNoDuplicates: "PASS",
      concurrentSameOrderOneDelivery: "PASS",
      ficFailureRetryAndSingleDeliveryEmail: "PASS",
      otherCompanyOnlyStockRequiresTransfer: "PASS",
    },
    raw: {
      complete: { result: resultComplete, items: completeItems, events: completeEvents, movements: completeMovements, labels: completeLabels },
      preview,
      insufficientPreview,
      transferred: resultTransferred,
      insufficientError,
      labelsError,
      unpaidError,
      intercompanyError,
      concurrent: concurrentResults.map((result) => ({ idempotent: result.idempotent, status: result.newStatus })),
      fic: { firstAttempt: ficFailureResult.fic, retry: ficRetryResult, sentEmails },
      otherCompanyError,
      otherCompanyPreview,
    },
  }, null, 2));
}

main()
  .then(async () => { await sql.end({ timeout: 5 }); process.exit(0); })
  .catch(async (error) => { console.error(error); await sql.end({ timeout: 5 }); process.exit(1); });
