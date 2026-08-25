# Proposta non applicata — esclusione rettifiche M13 dalle metriche flussi

## Motivazione

Le tre query di `server/reports-router.ts` sommano tutti i movimenti della company e non filtrano per location. Poiché classificano gli `ADJUSTMENT` negli ingressi, una dichiarazione M13 in diminuzione aumenterebbe artificialmente `unitsIn`, `valueIn` e `inQty`.

## Diff proposto

```diff
diff --git a/server/reports-router.ts b/server/reports-router.ts
@@
 WHERE sm."timestamp" >= ${dateFrom.toISOString()}::timestamptz
   AND sm."timestamp" <= ${dateTo.toISOString()}::timestamptz
   AND sm."companyId" = ${companyId}
+  AND COALESCE(sm."sourceDocumentType", '') <> 'm13_retailer_declaration'
@@
 WHERE sm."timestamp" >= ${prev.dateFrom.toISOString()}::timestamptz
   AND sm."timestamp" <= ${prev.dateTo.toISOString()}::timestamptz
   AND sm."companyId" = ${companyId}
+  AND COALESCE(sm."sourceDocumentType", '') <> 'm13_retailer_declaration'
@@
 WHERE sm."timestamp" >= ${dateFrom.toISOString()}::timestamptz
   AND sm."timestamp" <= ${dateTo.toISOString()}::timestamptz
   AND sm."companyId" = ${companyId}
+  AND COALESCE(sm."sourceDocumentType", '') <> 'm13_retailer_declaration'
 GROUP BY DATE(sm."timestamp")
```

L'esclusione è volutamente limitata alle tre aggregazioni che eseguono `SUM(sm."quantity")`. Non modifica l'elenco movimenti, l'export CSV, lo storico rivenditore o le viste che mostrano il singolo record.

> Stato: **solo proposta**. Il file applicativo `server/reports-router.ts` non è stato modificato.
