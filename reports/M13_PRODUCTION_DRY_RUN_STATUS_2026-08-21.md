# Stato verifica produzione M13 — 21 agosto 2026

## Sessione amministrativa

La sessione browser `alessandro@soketo.it` è stata verificata come amministrativa con company attiva **E-Keto Food Srls**.

## Esito route

La route `https://gestionale.soketo.it/reports/scadenze` è raggiungibile, ma dopo il deploy del commit `8b52fc8` mantiene il loader a schermo senza rendere il pannello. Il dry-run alignment **non è stato avviato** e non esistono conseguenti righe M13 o invii email attribuibili a questo tentativo.

Il confronto con la route preesistente `https://gestionale.soketo.it/reports/promozioni` mostra lo stesso loader continuo nella medesima sessione amministrativa. Il blocco è quindi antecedente alla pagina M13: la sessione Supabase client è presente, ma le query tRPC amministrative non raggiungono uno stato autenticato utilizzabile nella sessione browser corrente.

## Vincolo invariato

L'invio reale è ancora disabilitato sia nel codice del dispatcher sia nel gateway Resend. Nessuna email reale è stata inviata.
