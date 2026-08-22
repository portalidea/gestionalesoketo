# Audit segno `stockMovements.quantity` — M13

## Esito

Il campo `stockMovements.quantity` **non è semanticamente ignorato**. La reportistica di magazzino lo somma direttamente e classifica tutti gli `ADJUSTMENT` come ingressi, senza consultare `previousQuantity` o `newQuantity`.

| Punto di lettura | Uso di `quantity` | Effetto per un ADJUSTMENT |
|---|---|---|
| `server/reports-router.ts:121-160` — dashboard/report periodo e serie storica | `SUM(sm.quantity)`; gli ADJUSTMENT confluiscono in `unitsIn`, `valueIn`, `inQty` | Il segno entra direttamente nelle metriche di ingresso |
| `server/reports-router.ts:258-290` — elenco report movimenti | Esposto come campo | Nessuna somma/interpetazione aggiuntiva |
| `server/reports-router.ts:874-903` — export CSV movimenti | Esposto come `quantita` | Nessuna somma/interpetazione aggiuntiva |
| `server/db.ts:1423-1648` — elenchi per location, globale e retailer | Esposto insieme a `previousQuantity` e `newQuantity` | Nessuna somma/interpetazione aggiuntiva |
| `client/src/pages/Movements.tsx`, `RetailerDetail.tsx`, `reports/WarehouseReport.tsx`, `MarketplaceShopifyOrderDetail.tsx` | Mostrato direttamente | Nessuna somma/interpetazione aggiuntiva |

## Conclusione operativa

La convenzione esistente per gli `ADJUSTMENT` è quantità **positiva assoluta**: il percorso `warehouse.adjustBatchQuantity` salva `Math.abs(delta)` e la riga storica osservata in produzione ha `quantity=+5` nonostante `previousQuantity=83` e `newQuantity=78`.

M13 deve quindi scrivere `Math.abs(delta)`, lasciando la direzione nella coppia `previousQuantity`/`newQuantity` e nelle note. Questo allinea M13 all'ecosistema esistente ed evita di ridurre artificialmente `unitsIn`/`valueIn` nei report.

> Nota separata: la classificazione di **tutti** gli ADJUSTMENT come ingressi nella reportistica non distingue incrementi e decrementi. È un difetto storico di reportistica, non viene corretto in M13.
