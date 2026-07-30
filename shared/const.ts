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

/**
 * ID retailer "Soketo Srl" su E-Keto Food — destinatario dei transfer
 * inter-company che triggherano il carico automatico su company SoKeto.
 */
export const SOKETO_SRL_RETAILER_ID = "d2955b43-4882-4543-a77b-7321cb333468";

/**
 * ID company SoKeto Srl nel sistema multi-tenant.
 */
export const SOKETO_COMPANY_ID = "00000000-0000-0000-0000-000000000002";

export const AXIOS_TIMEOUT_MS = 30_000;
export const UNAUTHED_ERR_MSG = "Please login (10001)";
export const NOT_ADMIN_ERR_MSG = "You do not have required permission (10002)";
