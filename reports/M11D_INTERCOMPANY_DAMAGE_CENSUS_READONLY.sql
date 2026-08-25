-- M11.D — censimento read-only del potenziale danno inter-company
-- Solo SELECT. Nessuna DDL/DML.
-- Parametri confermati: retailer Soketo Srl su E-Keto e company SoKeto Srl.

-- QUERY 1 — elenco completo ordini E-Keto -> retailer Soketo Srl, con stati, date e importi.
WITH params AS (
  SELECT
    '4cad141e-11c4-4eb8-840a-0ebd457a5993'::uuid AS intercompany_retailer_id,
    '00000000-0000-0000-0000-000000000002'::uuid AS soketo_company_id
)
SELECT
  o.id AS order_id,
  o."orderNumber" AS order_number,
  o.status,
  o."createdAt" AS created_at,
  o."transferringAt" AS transferring_at,
  o."shippedAt" AS shipped_at,
  o."deliveredAt" AS delivered_at,
  o."cancelledAt" AS cancelled_at,
  o."cancelledReason" AS cancelled_reason,
  o."subtotalNet" AS subtotal_net,
  o."vatAmount" AS vat_amount,
  o."totalGross" AS total_gross,
  COUNT(oi.id)::integer AS order_lines,
  COALESCE(SUM(oi.quantity), 0)::integer AS order_units,
  COUNT(oi.id) FILTER (WHERE oi."batchId" IS NOT NULL)::integer AS lines_with_batch,
  ARRAY_AGG(DISTINCT pb."batchNumber" ORDER BY pb."batchNumber") FILTER (WHERE pb.id IS NOT NULL) AS batches
FROM orders o
JOIN params p ON true
LEFT JOIN "orderItems" oi ON oi."orderId" = o.id
LEFT JOIN "productBatches" pb ON pb.id = oi."batchId"
WHERE o."retailerId" = p.intercompany_retailer_id
GROUP BY
  o.id, o."orderNumber", o.status, o."createdAt", o."transferringAt", o."shippedAt", o."deliveredAt",
  o."cancelledAt", o."cancelledReason", o."subtotalNet", o."vatAmount", o."totalGross"
ORDER BY o."createdAt", o."orderNumber";


-- QUERY 2 — per ogni ordine, carichi automatici M11.D trovati nel centrale SoKeto.
-- Il collegamento usa notesInternal, l'unico riferimento ordine scritto dal codice M11.D sul movimento IN.
WITH params AS (
  SELECT
    '4cad141e-11c4-4eb8-840a-0ebd457a5993'::uuid AS intercompany_retailer_id,
    '00000000-0000-0000-0000-000000000002'::uuid AS soketo_company_id
), intercompany_orders AS (
  SELECT id, "orderNumber", status, "createdAt", "transferringAt", "cancelledAt"
  FROM orders o
  JOIN params p ON true
  WHERE o."retailerId" = p.intercompany_retailer_id
), soketo_central AS (
  SELECT l.id
  FROM locations l
  JOIN params p ON true
  WHERE l.type = 'central_warehouse' AND l."companyId" = p.soketo_company_id
)
SELECT
  o.id AS order_id,
  o."orderNumber" AS order_number,
  o.status AS order_status,
  o."createdAt" AS order_created_at,
  o."transferringAt" AS transferring_at,
  o."cancelledAt" AS cancelled_at,
  COUNT(sm.id)::integer AS m11d_in_movements,
  COALESCE(SUM(sm.quantity), 0)::integer AS m11d_loaded_pieces,
  MIN(sm.timestamp) AS first_m11d_load_at,
  MAX(sm.timestamp) AS last_m11d_load_at,
  ARRAY_AGG(DISTINCT sm.id ORDER BY sm.id) FILTER (WHERE sm.id IS NOT NULL) AS m11d_movement_ids
FROM intercompany_orders o
CROSS JOIN params p
LEFT JOIN "stockMovements" sm
  ON sm."companyId" = p.soketo_company_id
 AND sm.type = 'IN'
 AND sm."toLocationId" IN (SELECT id FROM soketo_central)
 AND sm."notesInternal" LIKE '%order ' || o.id::text || '%'
GROUP BY o.id, o."orderNumber", o.status, o."createdAt", o."transferringAt", o."cancelledAt"
ORDER BY o."createdAt", o."orderNumber";


-- QUERY 3A — confronto pezzi oggi sulla location retailer E-Keto vs lotti omonimi
-- nel magazzino centrale SoKeto. Il matching è prodotto + batchNumber.
WITH params AS (
  SELECT
    '4cad141e-11c4-4eb8-840a-0ebd457a5993'::uuid AS intercompany_retailer_id,
    '00000000-0000-0000-0000-000000000002'::uuid AS soketo_company_id
), retailer_batches AS (
  SELECT
    pb."productId" AS product_id,
    p.name AS product_name,
    pb."batchNumber" AS batch_number,
    ibb.quantity::integer AS retailer_pieces
  FROM "inventoryByBatch" ibb
  JOIN locations l ON l.id = ibb."locationId"
  JOIN "productBatches" pb ON pb.id = ibb."batchId"
  JOIN products p ON p.id = pb."productId"
  JOIN params x ON true
  WHERE l.type = 'retailer'
    AND l."retailerId" = x.intercompany_retailer_id
    AND ibb.quantity > 0
), soketo_central_batches AS (
  SELECT
    pb."productId" AS product_id,
    pb."batchNumber" AS batch_number,
    ibb.quantity::integer AS central_soketo_pieces
  FROM "inventoryByBatch" ibb
  JOIN locations l ON l.id = ibb."locationId"
  JOIN "productBatches" pb ON pb.id = ibb."batchId"
  JOIN params x ON true
  WHERE l.type = 'central_warehouse'
    AND l."companyId" = x.soketo_company_id
    AND ibb.quantity > 0
)
SELECT
  rb.product_name,
  rb.batch_number,
  rb.retailer_pieces,
  COALESCE(sb.central_soketo_pieces, 0) AS central_soketo_pieces,
  rb.retailer_pieces - COALESCE(sb.central_soketo_pieces, 0) AS retailer_minus_central
FROM retailer_batches rb
LEFT JOIN soketo_central_batches sb
  ON sb.product_id = rb.product_id AND sb.batch_number = rb.batch_number
ORDER BY rb.product_name, rb.batch_number;


-- QUERY 3B — totali del confronto 3A e giacenza complessiva del centrale SoKeto.
WITH params AS (
  SELECT
    '4cad141e-11c4-4eb8-840a-0ebd457a5993'::uuid AS intercompany_retailer_id,
    '00000000-0000-0000-0000-000000000002'::uuid AS soketo_company_id
), retailer_batches AS (
  SELECT pb."productId" AS product_id, pb."batchNumber" AS batch_number, ibb.quantity::integer AS retailer_pieces
  FROM "inventoryByBatch" ibb
  JOIN locations l ON l.id = ibb."locationId"
  JOIN "productBatches" pb ON pb.id = ibb."batchId"
  JOIN params x ON true
  WHERE l.type = 'retailer' AND l."retailerId" = x.intercompany_retailer_id AND ibb.quantity > 0
), soketo_central_batches AS (
  SELECT pb."productId" AS product_id, pb."batchNumber" AS batch_number, ibb.quantity::integer AS central_soketo_pieces
  FROM "inventoryByBatch" ibb
  JOIN locations l ON l.id = ibb."locationId"
  JOIN "productBatches" pb ON pb.id = ibb."batchId"
  JOIN params x ON true
  WHERE l.type = 'central_warehouse' AND l."companyId" = x.soketo_company_id AND ibb.quantity > 0
), matching_totals AS (
  SELECT
    COALESCE(SUM(rb.retailer_pieces), 0)::integer AS retailer_soketo_pieces,
    COALESCE(SUM(sb.central_soketo_pieces), 0)::integer AS central_soketo_matching_batch_pieces
  FROM retailer_batches rb
  LEFT JOIN soketo_central_batches sb ON sb.product_id = rb.product_id AND sb.batch_number = rb.batch_number
), central_total AS (
  SELECT COALESCE(SUM(ibb.quantity), 0)::integer AS central_soketo_all_pieces
  FROM "inventoryByBatch" ibb
  JOIN locations l ON l.id = ibb."locationId"
  JOIN params x ON true
  WHERE l.type = 'central_warehouse' AND l."companyId" = x.soketo_company_id AND ibb.quantity > 0
)
SELECT * FROM matching_totals CROSS JOIN central_total;


-- QUERY 3C — stesso productId + batchNumber, ID lotto diversi fra E-Keto e SoKeto.
-- Mostra esplicitamente gli UUID coinvolti per verificare che il matching logico
-- per batchNumber non venga scambiato per identità fisica del lotto.
WITH params AS (
  SELECT
    '4cad141e-11c4-4eb8-840a-0ebd457a5993'::uuid AS intercompany_retailer_id,
    '00000000-0000-0000-0000-000000000002'::uuid AS soketo_company_id
), retailer_source_batches AS (
  SELECT
    pb.id AS eketo_batch_id,
    pb."productId" AS product_id,
    p.name AS product_name,
    pb."batchNumber" AS batch_number,
    pb."expirationDate" AS eketo_expiry_date,
    ibb.quantity::integer AS eketo_retailer_pieces
  FROM "inventoryByBatch" ibb
  JOIN locations l ON l.id = ibb."locationId"
  JOIN "productBatches" pb ON pb.id = ibb."batchId"
  JOIN products p ON p.id = pb."productId"
  JOIN params x ON true
  WHERE l.type = 'retailer'
    AND l."retailerId" = x.intercompany_retailer_id
    AND ibb.quantity > 0
), soketo_batches AS (
  SELECT pb.id AS soketo_batch_id, pb."productId" AS product_id, pb."batchNumber" AS batch_number,
    pb."expirationDate" AS soketo_expiry_date, pb."costPrice" AS soketo_batch_cost_price
  FROM "productBatches" pb
  JOIN params x ON true
  WHERE pb."companyId" = x.soketo_company_id
)
SELECT
  rsb.product_name,
  rsb.batch_number,
  rsb.eketo_batch_id,
  sb.soketo_batch_id,
  (rsb.eketo_batch_id IS DISTINCT FROM sb.soketo_batch_id) AS ids_are_distinct,
  rsb.eketo_expiry_date,
  sb.soketo_expiry_date,
  rsb.eketo_retailer_pieces,
  sb.soketo_batch_cost_price
FROM retailer_source_batches rsb
LEFT JOIN soketo_batches sb
  ON sb.product_id = rsb.product_id
 AND sb.batch_number = rsb.batch_number
ORDER BY rsb.product_name, rsb.batch_number, sb.soketo_batch_id;


-- QUERY 4 — verifica costo dei lotti SoKeto collegabili a ordini inter-company.
-- Per ogni riga M11.D trovata (query 2), confronta costo lotto SoKeto e prezzo anagrafico × 1,07.
WITH params AS (
  SELECT
    '4cad141e-11c4-4eb8-840a-0ebd457a5993'::uuid AS intercompany_retailer_id,
    '00000000-0000-0000-0000-000000000002'::uuid AS soketo_company_id,
    0.07::numeric AS markup
), m11d_movements AS (
  SELECT sm.*
  FROM "stockMovements" sm
  JOIN params p ON true
  WHERE sm."companyId" = p.soketo_company_id
    AND sm.type = 'IN'
    AND sm."notesInternal" LIKE '[M11.D] Auto-load from E-Keto order %'
)
SELECT
  sm.id AS m11d_movement_id,
  sm.timestamp AS m11d_load_at,
  sm."notesInternal" AS m11d_notes_internal,
  p.name AS product_name,
  pb."batchNumber" AS soketo_batch_number,
  sm.quantity AS loaded_pieces,
  p."costPrice"::numeric(14,4) AS product_cost_price,
  ROUND((p."costPrice"::numeric * (1 + x.markup)), 4) AS expected_cost_price_7pct,
  pb."costPrice"::numeric(14,4) AS soketo_batch_cost_price,
  (pb."costPrice"::numeric(14,4) = ROUND((p."costPrice"::numeric * (1 + x.markup)), 4)) AS markup_7pct_matches
FROM m11d_movements sm
JOIN params x ON true
JOIN products p ON p.id = sm."productId"
JOIN "productBatches" pb ON pb.id = sm."batchId"
ORDER BY sm.timestamp, sm.id;


-- QUERY 5 — consumo etichette collegato agli ordini inter-company.
-- Il codice registra sourceOrderId e type='CONSUMPTION' nel passaggio transferring -> shipped.
WITH params AS (
  SELECT '4cad141e-11c4-4eb8-840a-0ebd457a5993'::uuid AS intercompany_retailer_id
), intercompany_orders AS (
  SELECT id, "orderNumber", status, "createdAt", "transferringAt", "shippedAt", "deliveredAt", "cancelledAt"
  FROM orders o
  JOIN params p ON true
  WHERE o."retailerId" = p.intercompany_retailer_id
)
SELECT
  o.id AS order_id,
  o."orderNumber" AS order_number,
  o.status,
  o."createdAt" AS order_created_at,
  o."transferringAt" AS transferring_at,
  o."shippedAt" AS shipped_at,
  o."deliveredAt" AS delivered_at,
  o."cancelledAt" AS cancelled_at,
  COUNT(lm.id)::integer AS label_consumption_movements,
  COALESCE(SUM(ABS(lm.quantity)), 0)::integer AS labels_consumed,
  MIN(lm."createdAt") AS first_label_consumption_at,
  MAX(lm."createdAt") AS last_label_consumption_at,
  ARRAY_AGG(DISTINCT lm.id ORDER BY lm.id) FILTER (WHERE lm.id IS NOT NULL) AS label_movement_ids
FROM intercompany_orders o
LEFT JOIN "labelMovements" lm
  ON lm."sourceOrderId" = o.id
 AND lm.type = 'CONSUMPTION'
GROUP BY o.id, o."orderNumber", o.status, o."createdAt", o."transferringAt", o."shippedAt", o."deliveredAt", o."cancelledAt"
ORDER BY o."createdAt", o."orderNumber";


-- QUERY 5B — totale grezzo consumi etichette per gli ordini inter-company.
WITH params AS (
  SELECT '4cad141e-11c4-4eb8-840a-0ebd457a5993'::uuid AS intercompany_retailer_id
)
SELECT
  COUNT(DISTINCT o.id) FILTER (WHERE lm.id IS NOT NULL)::integer AS ordini_con_consumo_etichette,
  COUNT(lm.id)::integer AS movimenti_consumo_etichette,
  COALESCE(SUM(ABS(lm.quantity)), 0)::integer AS etichette_consumate
FROM orders o
JOIN params p ON true
LEFT JOIN "labelMovements" lm
  ON lm."sourceOrderId" = o.id
 AND lm.type = 'CONSUMPTION'
WHERE o."retailerId" = p.intercompany_retailer_id;
