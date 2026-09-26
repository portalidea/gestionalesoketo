import assert from "node:assert/strict";
import postgres from "postgres";
import { seedHotfixM13, TEST_IDS } from "./seed-hotfix-m13";

const DATABASE_URL = process.env.LOCAL_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("Impostare LOCAL_TEST_DATABASE_URL o DATABASE_URL");
const TEST_DATABASE_URL: string = DATABASE_URL;

const IDs = {
  producer: "d1000000-0000-0000-0000-000000000001",
  ddt: "d1000000-0000-0000-0000-000000000002",
  item: "d1000000-0000-0000-0000-000000000003",
  invalidDdt: "d1000000-0000-0000-0000-000000000004",
  invalidItem: "d1000000-0000-0000-0000-000000000005",
} as const;

function caller() {
  return import("../server/ddt-imports-router").then(({ ddtImportsRouter }) =>
    ddtImportsRouter.createCaller({
      user: { id: TEST_IDS.adminUser, role: "admin", email: "test-admin@local.invalid", name: "Test Admin" },
      req: { headers: { "x-active-company-id": TEST_IDS.originCompany } },
      res: {},
    } as any),
  );
}

async function main() {
  const sql = postgres(TEST_DATABASE_URL, { prepare: false, max: 1 });
  try {
    // Rimuove la fixture DDT prima del seed M13, che ricrea i prodotti referenziati.
    await sql`DELETE FROM "stockMovements" WHERE "notesInternal" LIKE 'DDT TEST-DDT-DERIVED%'`;
    await sql`DELETE FROM ddt_import_items WHERE id IN (${IDs.item}, ${IDs.invalidItem})`;
    await sql`DELETE FROM ddt_imports WHERE id IN (${IDs.ddt}, ${IDs.invalidDdt})`;
    await sql`DELETE FROM "inventoryByBatch" WHERE "batchId" IN (SELECT id FROM "productBatches" WHERE "batchNumber" = '42D26')`;
    await sql`DELETE FROM "productBatches" WHERE "batchNumber" = '42D26'`;
    await seedHotfixM13();

    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO "userCompanyAccess" ("userId", "companyId", "isDefault")
        VALUES (${TEST_IDS.adminUser}, ${TEST_IDS.originCompany}, true)
        ON CONFLICT ("userId", "companyId") DO UPDATE SET "isDefault" = true
      `;
      await tx`DELETE FROM "stockMovements" WHERE "sourceDocument" IN ('TEST-DDT-DERIVED', 'TEST-DDT-INVALID')`;
      await tx`DELETE FROM "inventoryByBatch" WHERE "batchId" IN (SELECT id FROM "productBatches" WHERE "batchNumber" = '42D26')`;
      await tx`DELETE FROM "productBatches" WHERE "batchNumber" = '42D26'`;
      await tx`DELETE FROM ddt_import_items WHERE id IN (${IDs.item}, ${IDs.invalidItem})`;
      await tx`DELETE FROM ddt_imports WHERE id IN (${IDs.ddt}, ${IDs.invalidDdt})`;
      await tx`INSERT INTO producers (id, name) VALUES (${IDs.producer}, 'TEST Produttore DDT') ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`;
      await tx`
        INSERT INTO ddt_imports (id, "producerId", "ddtNumber", "ddtDate", status, "pdfStoragePath", "pdfFileName", "pdfFileSize")
        VALUES
          (${IDs.ddt}, ${IDs.producer}, 'TEST-DDT-DERIVED', '2026-09-23', 'review', 'test/derived.pdf', 'derived.pdf', 1),
          (${IDs.invalidDdt}, ${IDs.producer}, 'TEST-DDT-INVALID', '2026-09-23', 'review', 'test/invalid.pdf', 'invalid.pdf', 1)
      `;
      await tx`
        INSERT INTO ddt_import_items (id, "ddtImportId", "productMatchedId", "productNameExtracted", "productCodeExtracted", "batchNumber", "expirationDate", "quantityPieces", status, notes)
        VALUES
          (${IDs.item}, ${IDs.ddt}, ${TEST_IDS.productBoxes}, 'TEST Nuvole Vaniglia', '044.145', NULL, NULL, 150, 'matched', '[ESTRAZIONE PARZIALE] batchNumber mancante'),
          (${IDs.invalidItem}, ${IDs.invalidDdt}, ${TEST_IDS.productBoxes}, 'TEST Riga valida da invalidare', '044.146', '84G26', '2028-04-30', 10, 'matched', NULL)
      `;
    });

    const ddtCaller = await caller();

    // T1: dopo la correzione manuale, il warning storico non blocca più e diventa neutro.
    const before = await ddtCaller.getById({ id: IDs.ddt });
    assert.equal(before.validationSummary.incompleteCount, 1);
    assert.equal(before.items[0]?.validation.missingBatch, true);
    await ddtCaller.updateItem({ itemId: IDs.item, batchNumber: "42D26", expirationDate: "2028-04-30" });
    const corrected = await ddtCaller.getById({ id: IDs.ddt });
    assert.equal(corrected.validationSummary.incompleteCount, 0);
    assert.equal(corrected.validationSummary.historicallyCorrectedCount, 1);
    assert.equal(corrected.items[0]?.validation.isHistoricallyCorrected, true);

    const confirmed = await ddtCaller.confirm({ id: IDs.ddt, producerId: IDs.producer });
    assert.equal(confirmed.itemsProcessed, 1);
    const [confirmedImport] = await sql`SELECT status, "confirmedBy" FROM ddt_imports WHERE id = ${IDs.ddt}`;
    assert.equal(confirmedImport.status, "confirmed");
    assert.equal(confirmedImport.confirmedBy, TEST_IDS.adminUser);
    const [inventory] = await sql`
      SELECT ib.quantity, pb."batchNumber", pb."expirationDate"
      FROM "inventoryByBatch" ib
      JOIN "productBatches" pb ON pb.id = ib."batchId"
      WHERE pb."batchNumber" = '42D26' AND ib."locationId" = ${TEST_IDS.originCentral}
    `;
    const inventoryEvidence = {
      quantity: Number(inventory.quantity),
      batchNumber: inventory.batchNumber,
      expirationDate: new Date(inventory.expirationDate).toISOString().slice(0, 10),
    };
    assert.deepEqual(
      inventoryEvidence,
      { quantity: 150, batchNumber: "42D26", expirationDate: "2028-04-30" },
    );
    const [movement] = await sql`
      SELECT type, quantity, "companyId" FROM "stockMovements"
      WHERE "notesInternal" LIKE 'DDT TEST-DDT-DERIVED%'
      ORDER BY timestamp DESC LIMIT 1
    `;
    assert.equal(movement.type, "RECEIPT_FROM_PRODUCER");
    assert.equal(Number(movement.quantity), 150);
    assert.equal(movement.companyId, TEST_IDS.originCompany);

    // T2: svuotare lotto o scadenza ricrea il warning e conferma viene bloccata dal server.
    await ddtCaller.updateItem({ itemId: IDs.invalidItem, batchNumber: "" });
    const missingBatch = await ddtCaller.getById({ id: IDs.invalidDdt });
    assert.equal(missingBatch.validationSummary.missingBatchCount, 1);
    await assert.rejects(
      ddtCaller.confirm({ id: IDs.invalidDdt, producerId: IDs.producer }),
      /senza lotto/,
    );
    await ddtCaller.updateItem({ itemId: IDs.invalidItem, batchNumber: "84G26", expirationDate: "" });
    const missingExpiry = await ddtCaller.getById({ id: IDs.invalidDdt });
    assert.equal(missingExpiry.validationSummary.invalidExpirationDateCount, 1);
    await assert.rejects(
      ddtCaller.confirm({ id: IDs.invalidDdt, producerId: IDs.producer }),
      /scadenza valida/,
    );

    // T3: gli endpoint scrittori rifiutano direttamente date non reali e quantità zero.
    await assert.rejects(
      ddtCaller.updateItem({ itemId: IDs.invalidItem, expirationDate: "2028-02-30" }),
      /data valida/,
    );
    await assert.rejects(
      ddtCaller.updateItem({ itemId: IDs.invalidItem, quantityPieces: 0 }),
      /quantità deve essere maggiore di zero/,
    );

    console.log(JSON.stringify({
      result: "PASS",
      evidence: {
        historicalWarningCorrected: true,
        confirmedInventory: inventoryEvidence,
        movement: { type: movement.type, quantity: Number(movement.quantity), companyId: movement.companyId },
        directServerRejections: ["empty batch blocks confirm", "empty expiry blocks confirm", "invalid date rejected", "zero quantity rejected"],
      },
    }, null, 2));
  } finally {
    await sql`DELETE FROM "stockMovements" WHERE "notesInternal" LIKE 'DDT TEST-DDT-DERIVED%'`;
    await sql`DELETE FROM ddt_import_items WHERE id IN (${IDs.item}, ${IDs.invalidItem})`;
    await sql`DELETE FROM ddt_imports WHERE id IN (${IDs.ddt}, ${IDs.invalidDdt})`;
    await sql`DELETE FROM "inventoryByBatch" WHERE "batchId" IN (SELECT id FROM "productBatches" WHERE "batchNumber" = '42D26')`;
    await sql`DELETE FROM "productBatches" WHERE "batchNumber" = '42D26'`;
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
