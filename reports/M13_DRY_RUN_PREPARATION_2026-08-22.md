# Preparazione dry-run M13

Il SQL Editor Supabase è autenticato sul progetto `aejwoytoskihmtlgtfaz`, branch `main`, ambiente `PRODUCTION`.

Stato al momento della preparazione: nessuna query eseguita e nessun dato modificato.

La prima query sarà di sola lettura sui rivenditori e sul loro ultimo ordine non annullato, per individuare gli account senza ordini da oltre dodici mesi.

## Esito primo tentativo

Il SQL Editor ha mostrato `0 rows` insieme all'errore applicativo `query: Too small: expected string to have >=1 characters`. Il risultato non è pertanto considerato valido e non viene usato per il censimento. Nessun dato è stato modificato.

## Preview branch

Il bypass autorizzato ha aperto il deploy preview del branch `feature/m13-expiry-alerts-safe`. Alla prima e seconda verifica la route `/reports/scadenze` ha restituito solo il titolo `SoKeto Gestionale`, senza contenuto o controlli interattivi renderizzati. Nessun dry-run è stato avviato.
