/**
 * Side-effect module: carica le variabili d'ambiente da .env.local (se
 * esiste) e poi da .env. Va importato per primo in index.ts, prima di
 * qualunque altro modulo che legga `process.env.*`.
 *
 * Motivo: Vite carica autonomamente `.env.local` per il frontend, ma il
 * server Express/tsx no. `import "dotenv/config"` standard carica solo
 * `.env`, non `.env.local`.
 */
import { config } from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const localPath = resolve(process.cwd(), ".env.local");
if (existsSync(localPath)) {
  config({ path: localPath });
}
config();
