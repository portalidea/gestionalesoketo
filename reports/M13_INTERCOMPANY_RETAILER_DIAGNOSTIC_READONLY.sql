-- M13 — Diagnosi retailer inter-company
-- Solo SELECT. Nessuna DDL/DML.
-- Elenca tutti i retailer con UUID, company, location e giacenza corrente.

SELECT
  r.id AS retailer_id,
  r.name AS retailer_name,
  r."companyId" AS company_id,
  c.name AS company_name,
  r.email AS retailer_email,
  r."isActive" AS retailer_is_active,
  r."expiryAlertOptOut" AS expiry_alert_opt_out,
  l.id AS retailer_location_id,
  l.name AS retailer_location_name,
  l."isActive" AS location_is_active,
  COUNT(ibb.id) FILTER (WHERE ibb.quantity > 0)::integer AS lotti_con_giacenza,
  COALESCE(SUM(ibb.quantity) FILTER (WHERE ibb.quantity > 0), 0)::integer AS pezzi_a_giacenza
FROM retailers r
JOIN companies c ON c.id = r."companyId"
LEFT JOIN locations l
  ON l."retailerId" = r.id
 AND l."companyId" = r."companyId"
 AND l.type = 'retailer'
LEFT JOIN "inventoryByBatch" ibb
  ON ibb."locationId" = l.id
 AND ibb."companyId" = r."companyId"
GROUP BY
  r.id, r.name, r."companyId", c.name, r.email, r."isActive", r."expiryAlertOptOut",
  l.id, l.name, l."isActive"
ORDER BY c.name, r.name, l.name NULLS LAST;


-- Isolamento mirato dei record che contengono Soketo nel nome.
-- Confronta manualmente retailer_id con la costante oggi usata:
-- 4cad141e-11c4-4eb8-840a-0ebd457a5993
SELECT
  r.id AS retailer_id,
  r.name AS retailer_name,
  r."companyId" AS company_id,
  c.name AS company_name,
  r.email AS retailer_email,
  l.id AS retailer_location_id,
  l.name AS retailer_location_name,
  COALESCE(SUM(ibb.quantity) FILTER (WHERE ibb.quantity > 0), 0)::integer AS pezzi_a_giacenza
FROM retailers r
JOIN companies c ON c.id = r."companyId"
LEFT JOIN locations l
  ON l."retailerId" = r.id
 AND l."companyId" = r."companyId"
 AND l.type = 'retailer'
LEFT JOIN "inventoryByBatch" ibb
  ON ibb."locationId" = l.id
 AND ibb."companyId" = r."companyId"
WHERE r.name ILIKE '%soketo%'
GROUP BY r.id, r.name, r."companyId", c.name, r.email, l.id, l.name
ORDER BY c.name, r.name, l.name NULLS LAST;
