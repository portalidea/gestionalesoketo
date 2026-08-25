export const ONE_YEAR_MS = 1000 * 60 * 60 * 24 * 365;

/**
 * Sconto percentuale del tier Premium usato come riferimento per
 * calcolare il "valore regalato" delle promozioni (ordini omaggio).
 * Se il tier di riferimento cambia, modificare SOLO qui.
 */
export const PROMO_REFERENCE_DISCOUNT = 44.05;

/**
 * Markup inter-company applicato al costPrice anagrafico quando la merce
 * passa da E-Keto Food a SoKeto Srl (7%). Usato sia dal pricing
 * cost_markup sia dal carico automatico M11.D.
 */
export const INTERCOMPANY_MARKUP = 0.07;

/** ID della location retailer inter-company "Soketo Srl" su E-Keto Food. */
export const SOKETO_SRL_INTERCOMPANY_LOCATION_ID = "d2955b43-4882-4543-a77b-7321cb333468";

/** ID del retailer inter-company "Soketo Srl" su E-Keto Food. */
export const SOKETO_SRL_INTERCOMPANY_RETAILER_ID = "4cad141e-11c4-4eb8-840a-0ebd457a5993";

/**
 * Compatibilità M11.D: conserva il valore legacy locationId e il comportamento
 * automatico esistente. Non usare nei nuovi flussi; il processo inter-company
 * manuale va deciso in una milestone dedicata.
 */
export const SOKETO_SRL_RETAILER_ID = SOKETO_SRL_INTERCOMPANY_LOCATION_ID;

/**
 * ID company SoKeto Srl nel sistema multi-tenant.
 */
export const SOKETO_COMPANY_ID = "00000000-0000-0000-0000-000000000002";

export const AXIOS_TIMEOUT_MS = 30_000;
export const UNAUTHED_ERR_MSG = "Please login (10001)";
export const NOT_ADMIN_ERR_MSG = "You do not have required permission (10002)";
