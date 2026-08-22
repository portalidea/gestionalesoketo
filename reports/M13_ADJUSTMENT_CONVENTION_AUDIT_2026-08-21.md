# Audit convenzione ADJUSTMENT — produzione

## Evidenza osservata in sola lettura

Dal Table Editor Supabase della tabella `stockMovements` è stata osservata la riga storica seguente, non M13:

| Campo | Valore osservato |
|---|---|
| `id` | `0300f694-677c-4362-b7ec-de2f7f83dfe4` |
| `inventoryId` | `NULL` |
| `retailerId` | `NULL` |
| `productId` | `0e4228f3-3dd6-4ec6-9d98-3e2382337226` |
| `type` | `ADJUSTMENT` |
| `quantity` | `+5` |
| `previousQuantity` | `83` |
| `newQuantity` | `78` |

La combinazione `quantity=+5` e `83 → 78` dimostra che il segno della colonna `quantity` non è affidabile per dedurre la direzione storica. La direzione va determinata da `previousQuantity` e `newQuantity` e i riferimenti di location devono essere trattati con coerenza esplicita nel nuovo flusso M13.

## Stato

La convenzione è verificabile anche nel percorso applicativo esistente `warehouse.adjustBatchQuantity` in `server/routers.ts`: l'inserimento `ADJUSTMENT` popola `productId`, `batchId`, `quantity`, `previousQuantity`, `newQuantity`, causa, note e autore, ma **non** assegna né `fromLocationId` né `toLocationId`.

La query `getStockMovementsByRetailer` include inoltre i movimenti del rivenditore con tre condizioni alternative: `fromLocationId`, `toLocationId` oppure `retailerId`. Per M13 la convenzione sicura è pertanto:

| Campo M13 | Valore |
|---|---|
| `retailerId` | Rivenditore che ha effettuato la dichiarazione |
| `fromLocationId` | `NULL` |
| `toLocationId` | `NULL` |

Questo evita di presentare una rettifica in diminuzione come carico. La riconducibilità alla location resta nel riferimento `retailerId`, nella coppia `batchId`/company e nel `notification_id` inserito nelle note.
