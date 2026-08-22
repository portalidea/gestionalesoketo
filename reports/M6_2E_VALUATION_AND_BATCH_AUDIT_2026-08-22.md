# Audit M6.2.E — valorizzazione e batchNumber cross-company

## Query effettiva del report M6.2.E

La procedura è `warehouse.getValuation` in `server/routers.ts`. La parte che stabilisce l'ambito di magazzino è:

```sql
FROM "products" p
INNER JOIN "productBatches" pb ON pb."productId" = p."id"
INNER JOIN "inventoryByBatch" ibb ON ibb."batchId" = pb."id"
INNER JOIN "locations" l
  ON l."id" = ibb."locationId"
 AND l."type" = 'central_warehouse'
 AND l."companyId" = :activeCompanyId
WHERE ibb."quantity" > 0
```

La valorizzazione moltiplica `inventoryByBatch.quantity` per `productBatches.costPrice`, con fallback a `products.costPrice` quando il costo lotto è zero.

| Verifica | Risultato dal codice |
|---|---|
| Location retailer incluse? | No. Il join impone `l.type = 'central_warehouse'`. |
| Company attiva rispettata? | Sì. Quando presente, `ctx.activeCompanyId` viene aggiunto come `AND l."companyId" = :activeCompanyId`. |
| Doppio conteggio retailer E-Keto + centrale SoKeto nello stesso report? | No, perché le location retailer sono escluse dalla query. Le due company vengono inoltre filtrate dal cappello company attivo. |

## BatchNumber uguale e ID lotto diverso

Lo schema definisce l'unicità del lotto come:

```ts
unique("productBatches_product_batch_company_unique")
  .on(companyId, productId, batchNumber)
```

Lo stesso `productId + batchNumber` può quindi esistere in company diverse con UUID `productBatches.id` differenti. Questo è previsto dal modello multi-company. Il matching per confronto inter-company deve usare almeno **productId + batchNumber + companyId**; un `batchId` non può essere confrontato direttamente fra E-Keto e SoKeto.

La Query 3C nel file `M11D_INTERCOMPANY_DAMAGE_CENSUS_READONLY.sql` espone per ogni lotto oggi sulla location retailer E-Keto:

| Campo | Significato |
|---|---|
| `eketo_batch_id` | UUID del lotto E-Keto presso il retailer Soketo Srl |
| `soketo_batch_id` | UUID del lotto omonimo nella company SoKeto, se esiste |
| `ids_are_distinct` | Deve essere `true` quando entrambi esistono: sono lotti appartenenti a company diverse |
| `batch_number`, `product_id` implicito nel matching | Chiave logica usata per il confronto, non identità fisica |

L'intero audit resta read-only. Non è stata eseguita alcuna rettifica di inventario, costo, movimento o logica M11.D.
