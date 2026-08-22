-- M13 — verifica read-only alert scadenze, settembre 2026
-- Solo SELECT. Nessuna DDL/DML.
-- Per un altro mese modificare esclusivamente period_start, period_end e tolerance_days nel CTE params.

-- QUERY 0 — copertura storica dei TRANSFER per i lotti oggi a giacenza sulle location retailer.
-- Il rapporto è calcolato per coppia (company, location rivenditore, lotto) e non filtra
-- sourceDocumentType: i movimenti storici possono averlo NULL. La query non esclude né
-- PEC né opt-out, perché misura il dato storico fisico; l'inter-company è riportata a parte.
WITH retailer_stock AS (
  SELECT
    ibb."companyId" AS company_id,
    c.name AS company,
    l.id AS retailer_location_id,
    l.name AS retailer_location,
    r.id AS retailer_id,
    r.name AS retailer_name,
    r.id = '4cad141e-11c4-4eb8-840a-0ebd457a5993'::uuid AS is_temporary_intercompany,
    ibb."batchId" AS batch_id,
    pb."batchNumber" AS batch_code,
    ibb.quantity::integer AS quantity_pieces
  FROM "inventoryByBatch" ibb
  JOIN locations l ON l.id = ibb."locationId" AND l."companyId" = ibb."companyId"
  JOIN retailers r ON r.id = l."retailerId" AND r."companyId" = ibb."companyId"
  JOIN companies c ON c.id = ibb."companyId"
  JOIN "productBatches" pb ON pb.id = ibb."batchId" AND pb."companyId" = ibb."companyId"
  WHERE ibb.quantity > 0
    AND l.type = 'retailer'
), coverage AS (
  SELECT
    rs.*,
    EXISTS (
      SELECT 1
      FROM "stockMovements" sm
      WHERE sm.type = 'TRANSFER'
        AND sm."batchId" = rs.batch_id
        AND sm."toLocationId" = rs.retailer_location_id
    ) AS has_reconcilable_transfer
  FROM retailer_stock rs
)
SELECT
  company,
  is_temporary_intercompany,
  COUNT(*)::integer AS lotti_a_giacenza,
  COUNT(*) FILTER (WHERE has_reconcilable_transfer)::integer AS lotti_con_transfer_riconducibile,
  COUNT(*) FILTER (WHERE NOT has_reconcilable_transfer)::integer AS lotti_senza_transfer_riconducibile,
  COALESCE(ROUND(100.0 * COUNT(*) FILTER (WHERE has_reconcilable_transfer) / NULLIF(COUNT(*), 0), 2), 0) AS copertura_percentuale,
  COALESCE(SUM(quantity_pieces), 0)::integer AS pezzi_a_giacenza,
  COALESCE(SUM(quantity_pieces) FILTER (WHERE has_reconcilable_transfer), 0)::integer AS pezzi_con_transfer_riconducibile
FROM coverage
GROUP BY company, is_temporary_intercompany
ORDER BY company, is_temporary_intercompany;


-- QUERY 1 — dettaglio lotto: distinguere alert, soppressione da riordino e PEC.
WITH params AS (
  SELECT DATE '2026-09-01' AS period_start, DATE '2026-09-30' AS period_end, 7::integer AS tolerance_days
), active_batches AS (
  -- Tutti i lotti con giacenza positiva, anche fuori finestra: servono a calcolare D_max.
  SELECT
    c.name AS company,
    c.id AS company_id,
    r.id AS retailer_id,
    r.name AS retailer_name,
    r.email AS retailer_email,
    lower(split_part(trim(r.email), '@', 2)) AS email_domain,
    l.id AS retailer_location_id,
    p.id AS product_id,
    p.name AS product_name,
    COALESCE(p."piecesPerUnit", 1)::integer AS pieces_per_unit,
    pb.id AS batch_id,
    pb."batchNumber" AS batch_code,
    pb."expirationDate" AS expiry_date,
    ibb.quantity::integer AS quantity_pieces
  FROM "inventoryByBatch" ibb
  JOIN locations l ON l.id = ibb."locationId" AND l."companyId" = ibb."companyId"
  JOIN retailers r ON r.id = l."retailerId" AND r."companyId" = ibb."companyId"
  JOIN companies c ON c.id = ibb."companyId" AND c."isActive" = true
  JOIN "productBatches" pb ON pb.id = ibb."batchId" AND pb."companyId" = ibb."companyId"
  JOIN products p ON p.id = pb."productId"
  WHERE ibb.quantity > 0
    AND l.type = 'retailer'
    AND l."isActive" = true
    AND r."isActive" = true
    AND r."expiryAlertOptOut" = false
    AND NULLIF(trim(r.email), '') IS NOT NULL
    -- Esclusione inter-company M13 temporanea; sostituire post-M13 con retailers.isInterCompany.
    AND r.id <> '4cad141e-11c4-4eb8-840a-0ebd457a5993'::uuid
), batch_deliveries AS (
  SELECT
    ab.*,
    MAX(sm.timestamp) AS last_transfer_at
  FROM active_batches ab
  LEFT JOIN "stockMovements" sm
    ON sm.type = 'TRANSFER'
   AND sm."batchId" = ab.batch_id
   AND sm."toLocationId" = ab.retailer_location_id
   -- Volutamente nessun filtro sourceDocumentType: i TRANSFER storici possono averlo NULL.
  GROUP BY
    ab.company, ab.company_id, ab.retailer_id, ab.retailer_name, ab.retailer_email, ab.email_domain,
    ab.retailer_location_id, ab.product_id, ab.product_name, ab.pieces_per_unit,
    ab.batch_id, ab.batch_code, ab.expiry_date, ab.quantity_pieces
), latest_product_delivery AS (
  SELECT DISTINCT ON (retailer_location_id, product_id)
    retailer_location_id,
    product_id,
    batch_id AS latest_batch_id,
    batch_code AS latest_batch_code,
    last_transfer_at AS d_max
  FROM batch_deliveries
  WHERE last_transfer_at IS NOT NULL
  ORDER BY retailer_location_id, product_id, last_transfer_at DESC, batch_code DESC
), september_batches AS (
  SELECT bd.*, lpd.latest_batch_id, lpd.latest_batch_code, lpd.d_max, p.tolerance_days
  FROM batch_deliveries bd
  CROSS JOIN params p
  LEFT JOIN latest_product_delivery lpd
    ON lpd.retailer_location_id = bd.retailer_location_id
   AND lpd.product_id = bd.product_id
  WHERE bd.expiry_date BETWEEN p.period_start AND p.period_end
)
SELECT
  company,
  retailer_name,
  retailer_email,
  product_name,
  batch_code,
  expiry_date,
  quantity_pieces,
  pieces_per_unit,
  ROUND(quantity_pieces::numeric / pieces_per_unit, 2) AS confezioni_equivalenti,
  last_transfer_at AS last_delivery_for_batch,
  d_max AS latest_delivery_for_product,
  latest_batch_code AS latest_batch_for_product,
  CASE
    WHEN email_domain LIKE 'pec.%'
      OR email_domain LIKE '%.pec.%'
      OR email_domain LIKE '%legalmail.it'
      OR email_domain LIKE '%postecert.it'
      OR email_domain LIKE '%pec.aruba.it'
      OR email_domain = 'pec.it'
      THEN 'skipped_pec_address'
    WHEN last_transfer_at IS NOT NULL
     AND d_max IS NOT NULL
     AND last_transfer_at < d_max - make_interval(days => tolerance_days)
      THEN 'suppressed_by_reorder'
    ELSE 'alert_candidate'
  END AS decision,
  CASE
    WHEN email_domain LIKE 'pec.%'
      OR email_domain LIKE '%.pec.%'
      OR email_domain LIKE '%legalmail.it'
      OR email_domain LIKE '%postecert.it'
      OR email_domain LIKE '%pec.aruba.it'
      OR email_domain = 'pec.it'
      THEN 'pec_address'
    WHEN last_transfer_at IS NOT NULL
     AND d_max IS NOT NULL
     AND last_transfer_at < d_max - make_interval(days => tolerance_days)
      THEN CONCAT('precede D_max oltre ', tolerance_days, ' giorni')
    WHEN last_transfer_at IS NULL THEN 'nessun TRANSFER storico riconducibile al lotto/location: lotto non soppresso'
    ELSE 'lotto corrente per il prodotto/location'
  END AS decision_reason
FROM september_batches
ORDER BY company, retailer_name, product_name, expiry_date, batch_code;


-- QUERY 2 — riepilogo per rivenditore: chi riceverebbe un alert, chi è solo PEC
-- e quanti lotti sono stati esclusi come riordini precedenti.
WITH params AS (
  SELECT DATE '2026-09-01' AS period_start, DATE '2026-09-30' AS period_end, 7::integer AS tolerance_days
), active_batches AS (
  SELECT
    c.name AS company,
    c.id AS company_id,
    r.id AS retailer_id,
    r.name AS retailer_name,
    r.email AS retailer_email,
    lower(split_part(trim(r.email), '@', 2)) AS email_domain,
    l.id AS retailer_location_id,
    p.id AS product_id,
    COALESCE(p."piecesPerUnit", 1)::integer AS pieces_per_unit,
    pb.id AS batch_id,
    pb."expirationDate" AS expiry_date,
    ibb.quantity::integer AS quantity_pieces
  FROM "inventoryByBatch" ibb
  JOIN locations l ON l.id = ibb."locationId" AND l."companyId" = ibb."companyId"
  JOIN retailers r ON r.id = l."retailerId" AND r."companyId" = ibb."companyId"
  JOIN companies c ON c.id = ibb."companyId" AND c."isActive" = true
  JOIN "productBatches" pb ON pb.id = ibb."batchId" AND pb."companyId" = ibb."companyId"
  JOIN products p ON p.id = pb."productId"
  WHERE ibb.quantity > 0
    AND l.type = 'retailer'
    AND l."isActive" = true
    AND r."isActive" = true
    AND r."expiryAlertOptOut" = false
    AND NULLIF(trim(r.email), '') IS NOT NULL
    AND r.id <> '4cad141e-11c4-4eb8-840a-0ebd457a5993'::uuid
), batch_deliveries AS (
  SELECT ab.*, MAX(sm.timestamp) AS last_transfer_at
  FROM active_batches ab
  LEFT JOIN "stockMovements" sm
    ON sm.type = 'TRANSFER'
   AND sm."batchId" = ab.batch_id
   AND sm."toLocationId" = ab.retailer_location_id
  GROUP BY
    ab.company, ab.company_id, ab.retailer_id, ab.retailer_name, ab.retailer_email, ab.email_domain,
    ab.retailer_location_id, ab.product_id, ab.pieces_per_unit, ab.batch_id, ab.expiry_date, ab.quantity_pieces
), latest_product_delivery AS (
  SELECT DISTINCT ON (retailer_location_id, product_id)
    retailer_location_id, product_id, last_transfer_at AS d_max
  FROM batch_deliveries
  WHERE last_transfer_at IS NOT NULL
  ORDER BY retailer_location_id, product_id, last_transfer_at DESC, batch_id DESC
), decisions AS (
  SELECT
    bd.*, eas.min_pieces_threshold,
    CASE
      WHEN bd.email_domain LIKE 'pec.%'
        OR bd.email_domain LIKE '%.pec.%'
        OR bd.email_domain LIKE '%legalmail.it'
        OR bd.email_domain LIKE '%postecert.it'
        OR bd.email_domain LIKE '%pec.aruba.it'
        OR bd.email_domain = 'pec.it'
        THEN 'skipped_pec_address'
      WHEN bd.last_transfer_at IS NOT NULL
       AND lpd.d_max IS NOT NULL
       AND bd.last_transfer_at < lpd.d_max - make_interval(days => p.tolerance_days)
        THEN 'suppressed_by_reorder'
      ELSE 'alert_candidate'
    END AS decision
  FROM batch_deliveries bd
  CROSS JOIN params p
  JOIN expiry_alert_settings eas ON eas.company_id = bd.company_id
  LEFT JOIN latest_product_delivery lpd
    ON lpd.retailer_location_id = bd.retailer_location_id
   AND lpd.product_id = bd.product_id
  WHERE bd.expiry_date BETWEEN p.period_start AND p.period_end
), retailer_summary AS (
  SELECT
    company,
    retailer_name,
    retailer_email,
    MIN(min_pieces_threshold)::integer AS min_pieces_threshold,
    COUNT(*) FILTER (WHERE decision = 'alert_candidate')::integer AS alert_lots,
    COALESCE(SUM(quantity_pieces) FILTER (WHERE decision = 'alert_candidate'), 0)::integer AS alert_pieces,
    COALESCE(ROUND(SUM(quantity_pieces::numeric / pieces_per_unit) FILTER (WHERE decision = 'alert_candidate'), 2), 0) AS alert_confezioni_equivalenti,
    COUNT(*) FILTER (WHERE decision = 'suppressed_by_reorder')::integer AS suppressed_lots,
    COALESCE(SUM(quantity_pieces) FILTER (WHERE decision = 'suppressed_by_reorder'), 0)::integer AS suppressed_pieces,
    COUNT(*) FILTER (WHERE decision = 'skipped_pec_address')::integer AS pec_lots,
    COALESCE(SUM(quantity_pieces) FILTER (WHERE decision = 'skipped_pec_address'), 0)::integer AS pec_pieces
  FROM decisions
  GROUP BY company, retailer_name, retailer_email
)
SELECT
  company,
  retailer_name,
  retailer_email,
  min_pieces_threshold,
  CASE
    WHEN pec_lots > 0 THEN 'skipped_pec_address'
    WHEN alert_lots = 0 THEN 'only_reorder_suppressed'
    WHEN alert_pieces < min_pieces_threshold THEN 'skipped_below_threshold'
    WHEN alert_lots > 0 THEN 'would_receive_alert'
    ELSE 'only_reorder_suppressed'
  END AS retailer_outcome,
  alert_lots,
  alert_pieces,
  alert_confezioni_equivalenti,
  suppressed_lots,
  suppressed_pieces,
  pec_lots,
  pec_pieces
FROM retailer_summary
ORDER BY company, retailer_outcome, retailer_name;
