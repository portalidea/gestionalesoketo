import postgres from "postgres";

const DATABASE_URL = process.env.LOCAL_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("Impostare LOCAL_TEST_DATABASE_URL o DATABASE_URL");

export const TEST_IDS = {
  originCompany: "00000000-0000-0000-0000-000000000001",
  soketoCompany: "00000000-0000-0000-0000-000000000002",
  adminUser: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  normalRetailer: "33333333-3333-3333-3333-333333333333",
  interCompanyRetailer: "4cad141e-11c4-4eb8-840a-0ebd457a5993",
  originCentral: "44444444-4444-4444-4444-444444444444",
  soketoCentral: "55555555-5555-5555-5555-555555555555",
  normalRetailerLocation: "66666666-6666-6666-6666-666666666666",
  interCompanyRetailerLocation: "d2955b43-4882-4543-a77b-7321cb333468",
  productBoxes: "88888888-8888-8888-8888-888888888881",
  productPieces: "88888888-8888-8888-8888-888888888882",
  batchSoon: "99999999-9999-9999-9999-999999999991",
  batchFourMonths: "99999999-9999-9999-9999-999999999992",
  batchExpired: "99999999-9999-9999-9999-999999999993",
  orderIntact: "aaaaaaaa-0000-0000-0000-000000000001",
  orderPartial: "aaaaaaaa-0000-0000-0000-000000000002",
  orderDouble: "aaaaaaaa-0000-0000-0000-000000000003",
  orderConcurrent: "aaaaaaaa-0000-0000-0000-000000000004",
  orderIntercompany: "aaaaaaaa-0000-0000-0000-000000000005",
  orderPreexistingStock: "aaaaaaaa-0000-0000-0000-000000000006",
} as const;

function dateOnly(offsetDays: number) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

export async function seedHotfixM13() {
  const sql = postgres(DATABASE_URL!, { prepare: false, max: 1 });
  const id = TEST_IDS;
  try {
    await sql.begin(async (tx) => {
      // The test namespace is deterministic. Removing it first makes the seed idempotent.
      await tx`DELETE FROM "stockMovements" WHERE "companyId" IN (${id.originCompany}, ${id.soketoCompany})`;
      await tx`DELETE FROM "orderItems" WHERE "orderId" IN (SELECT id FROM orders WHERE "retailerId" IN (${id.normalRetailer}, ${id.interCompanyRetailer}))`;
      await tx`DELETE FROM orders WHERE "retailerId" IN (${id.normalRetailer}, ${id.interCompanyRetailer})`;
      await tx`DELETE FROM "orderItems" WHERE "orderId" IN (${id.orderIntact}, ${id.orderPartial}, ${id.orderDouble}, ${id.orderConcurrent}, ${id.orderIntercompany}, ${id.orderPreexistingStock})`;
      await tx`DELETE FROM orders WHERE id IN (${id.orderIntact}, ${id.orderPartial}, ${id.orderDouble}, ${id.orderConcurrent}, ${id.orderIntercompany}, ${id.orderPreexistingStock})`;
      await tx`DELETE FROM "inventoryByBatch" WHERE "companyId" IN (${id.originCompany}, ${id.soketoCompany})`;
      // La suite inter-company crea un batch SoKeto con ID dinamico ma gli stessi productId:
      // rimuoviamo quindi tutti i batch fixture dei due prodotti dopo inventari e movimenti.
      await tx`DELETE FROM "productBatches" WHERE "productId" IN (${id.productBoxes}, ${id.productPieces})`;
      await tx`DELETE FROM channel_variants WHERE "productId" IN (${id.productBoxes}, ${id.productPieces})`;
      await tx`DELETE FROM locations WHERE "companyId" IN (${id.originCompany}, ${id.soketoCompany})`;
      await tx`DELETE FROM retailers WHERE id IN (${id.normalRetailer}, ${id.interCompanyRetailer})`;
      await tx`DELETE FROM products WHERE id IN (${id.productBoxes}, ${id.productPieces})`;
      await tx`DELETE FROM users WHERE id = ${id.adminUser}`;
      await tx`DELETE FROM auth.users WHERE id = ${id.adminUser}`;

      await tx`
        INSERT INTO companies (id, name, "isActive") VALUES
          (${id.originCompany}, 'TEST E-Keto Food', true),
          (${id.soketoCompany}, 'TEST SoKeto Srl', true)
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, "isActive" = true
      `;
      await tx`INSERT INTO auth.users (id, email) VALUES (${id.adminUser}, 'test-admin@local.invalid')`;
      await tx`UPDATE users SET name = 'Test Admin', role = 'admin' WHERE id = ${id.adminUser}`;

      await tx`
        INSERT INTO retailers (id, name, email, "companyId", tier_engine_enabled) VALUES
          (${id.normalRetailer}, 'TEST Rivenditore Normale', 'normal@test.invalid', ${id.originCompany}, false),
          (${id.interCompanyRetailer}, 'Soketo Srl', 'intercompany@test.invalid', ${id.originCompany}, false)
      `;
      await tx`
        INSERT INTO locations (id, type, name, "retailerId", "companyId") VALUES
          (${id.originCentral}, 'central_warehouse', 'TEST Magazzino Centrale E-Keto', NULL, ${id.originCompany}),
          (${id.soketoCentral}, 'central_warehouse', 'TEST Magazzino Centrale SoKeto', NULL, ${id.soketoCompany}),
          (${id.normalRetailerLocation}, 'retailer', 'TEST Location Rivenditore Normale', ${id.normalRetailer}, ${id.originCompany}),
          (${id.interCompanyRetailerLocation}, 'retailer', 'TEST Location Soketo Srl', ${id.interCompanyRetailer}, ${id.originCompany})
      `;
      await tx`
        INSERT INTO products (id, sku, name, "unitPrice", "piecesPerUnit", "sellableUnitLabel", "costPrice") VALUES
          (${id.productBoxes}, 'TEST-BOX-6', 'TEST Prodotto Confezione 6', '10.00', 6, 'CONF', '2.0000'),
          (${id.productPieces}, 'TEST-PZ-1', 'TEST Prodotto Pezzo Singolo', '5.00', 1, 'PZ', '1.0000')
      `;
      await tx`
        INSERT INTO "productBatches" (id, "productId", "batchNumber", "expirationDate", "initialQuantity", "costPrice", "companyId") VALUES
          (${id.batchSoon}, ${id.productBoxes}, 'TEST-SCAD-NEXT-MONTH', ${dateOnly(30)}, 120, '2.0000', ${id.originCompany}),
          (${id.batchFourMonths}, ${id.productBoxes}, 'TEST-SCAD-FOUR-MONTHS', ${dateOnly(120)}, 120, '2.0000', ${id.originCompany}),
          (${id.batchExpired}, ${id.productPieces}, 'TEST-SCAD-EXPIRED', ${dateOnly(-10)}, 120, '1.0000', ${id.originCompany})
      `;
      await tx`
        INSERT INTO "inventoryByBatch" ("locationId", "batchId", quantity, "companyId") VALUES
          (${id.originCentral}, ${id.batchSoon}, 70, ${id.originCompany}),
          (${id.originCentral}, ${id.batchFourMonths}, 120, ${id.originCompany}),
          (${id.originCentral}, ${id.batchExpired}, 120, ${id.originCompany}),
          (${id.normalRetailerLocation}, ${id.batchSoon}, 50, ${id.originCompany}),
          (${id.interCompanyRetailerLocation}, ${id.batchSoon}, 30, ${id.originCompany})
      `;
      await tx`
        INSERT INTO "stockMovements" ("productId", type, quantity, "previousQuantity", "newQuantity", "batchId", "fromLocationId", "toLocationId", "sourceDocumentType", "sourceDocument", notes, "companyId")
        VALUES (${id.productBoxes}, 'TRANSFER', 50, 120, 70, ${id.batchSoon}, ${id.originCentral}, ${id.normalRetailerLocation}, 'seed_previous_transfer', 'SEED-PREVIOUS-TRANSFER', 'TEST seed: giacenza preesistente retailer', ${id.originCompany})
      `;
      await tx`
        INSERT INTO orders (id, "orderNumber", "retailerId", status, "subtotalNet", "vatAmount", "totalGross", "discountPercent", "createdBy", "companyId") VALUES
          (${id.orderIntact}, 'TEST-REV-001', ${id.normalRetailer}, 'pending', 50, 5, 55, 0, ${id.adminUser}, ${id.originCompany}),
          (${id.orderPartial}, 'TEST-REV-002', ${id.normalRetailer}, 'pending', 150, 15, 165, 0, ${id.adminUser}, ${id.originCompany}),
          (${id.orderDouble}, 'TEST-REV-003', ${id.normalRetailer}, 'pending', 60, 6, 66, 0, ${id.adminUser}, ${id.originCompany}),
          (${id.orderConcurrent}, 'TEST-REV-004', ${id.normalRetailer}, 'pending', 50, 5, 55, 0, ${id.adminUser}, ${id.originCompany}),
          (${id.orderIntercompany}, 'TEST-REV-005', ${id.interCompanyRetailer}, 'pending', 30, 3, 33, 0, ${id.adminUser}, ${id.originCompany}),
          (${id.orderPreexistingStock}, 'TEST-REV-006', ${id.normalRetailer}, 'pending', 50, 5, 55, 0, ${id.adminUser}, ${id.originCompany})
      `;
      await tx`
        INSERT INTO "orderItems" ("orderId", "productId", "batchId", quantity, "unitPriceBase", "discountPercent", "unitPriceFinal", "vatRate", "lineTotalNet", "lineTotalGross", "productSku", "productName") VALUES
          (${id.orderIntact}, ${id.productBoxes}, ${id.batchFourMonths}, 5, 10, 0, 10, 10, 50, 55, 'TEST-BOX-6', 'TEST Prodotto Confezione 6'),
          (${id.orderPartial}, ${id.productPieces}, ${id.batchExpired}, 30, 5, 0, 5, 10, 150, 165, 'TEST-PZ-1', 'TEST Prodotto Pezzo Singolo'),
          (${id.orderDouble}, ${id.productPieces}, ${id.batchExpired}, 12, 5, 0, 5, 10, 60, 66, 'TEST-PZ-1', 'TEST Prodotto Pezzo Singolo'),
          (${id.orderConcurrent}, ${id.productBoxes}, ${id.batchFourMonths}, 5, 10, 0, 10, 10, 50, 55, 'TEST-BOX-6', 'TEST Prodotto Confezione 6'),
          (${id.orderIntercompany}, ${id.productBoxes}, ${id.batchSoon}, 3, 10, 0, 10, 10, 30, 33, 'TEST-BOX-6', 'TEST Prodotto Confezione 6'),
          (${id.orderPreexistingStock}, ${id.productBoxes}, ${id.batchSoon}, 5, 10, 0, 10, 10, 50, 55, 'TEST-BOX-6', 'TEST Prodotto Confezione 6')
      `;
    });
    return { ...TEST_IDS, databaseUrl: DATABASE_URL };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  seedHotfixM13().then((result) => console.log(JSON.stringify(result, null, 2)));
}
