// Read-only repro: chiama getAllProducts() per intercettare crash 500.
import { config } from "dotenv";
config({ path: "/Users/admin/Projects/gestionalesoketo/.env.local" });

async function main() {
  const { getAllProducts, getAllRetailers, getAllProducers } = await import(
    "../server/db"
  );
  console.log("=== getAllProducts ===");
  try {
    const rows = await getAllProducts();
    console.log("OK rows:", rows.length);
    if (rows.length > 0) {
      console.log("First row:", JSON.stringify(rows[0], null, 2));
    }
  } catch (e) {
    console.error("FAIL getAllProducts:", e);
  }

  console.log("\n=== getAllRetailers ===");
  try {
    const rows = await getAllRetailers();
    console.log("OK rows:", rows.length);
    if (rows.length > 0) {
      console.log("First row:", JSON.stringify(rows[0], null, 2));
    }
  } catch (e) {
    console.error("FAIL getAllRetailers:", e);
  }

  console.log("\n=== getAllProducers ===");
  try {
    const rows = await getAllProducers();
    console.log("OK rows:", rows.length);
    if (rows.length > 0) {
      console.log("First row:", JSON.stringify(rows[0], null, 2));
    }
  } catch (e) {
    console.error("FAIL getAllProducers:", e);
  }

  process.exit(0);
}

main();
