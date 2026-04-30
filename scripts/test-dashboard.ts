import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

import * as db from "../server/db";

async function main() {
  console.log("DATABASE_URL set:", !!process.env.DATABASE_URL);

  // Run twice: first triggers cold-connect, second is warm.
  for (let pass = 1; pass <= 2; pass++) {
    const t0 = Date.now();
    const stats = await db.getDashboardStats();
    console.log(`pass ${pass}: ${Date.now() - t0}ms`, stats);
  }
  process.exit(0);
}
main().catch((e) => {
  console.error("ERROR", e);
  process.exit(1);
});
