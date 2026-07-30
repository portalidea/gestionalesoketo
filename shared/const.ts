export const ONE_YEAR_MS = 1000 * 60 * 60 * 24 * 365;

/**
 * Sconto percentuale del tier Premium usato come riferimento per
 * calcolare il "valore regalato" delle promozioni (ordini omaggio).
 * Se il tier di riferimento cambia, modificare SOLO qui.
 */
export const PROMO_REFERENCE_DISCOUNT = 44.05;
export const AXIOS_TIMEOUT_MS = 30_000;
export const UNAUTHED_ERR_MSG = "Please login (10001)";
export const NOT_ADMIN_ERR_MSG = "You do not have required permission (10002)";
