# Diagnosi backend preview M13

## Endpoint sul medesimo preview

| Endpoint | HTTP | Esito |
|---|---:|---|
| `auth.me` | 200 | tRPC preesistente è montato e risponde con `null` senza sessione applicativa. |
| `expiryAlerts.getSettings` | 404 | tRPC risponde `No procedure found on path "expiryAlerts.getSettings"`. |

Il problema non è quindi il bypass né il montaggio generale del backend. Nel codice del branch il router è importato in `server/routers.ts` e registrato come `expiryAlerts: expiryAlertsRouter` alle righe 46 e 2169.

## Asset del preview

Il bundle `/assets/index-DZbqRM_7.js` servito dal preview contiene 0 occorrenze di `expiryAlerts`. Indica che il deployment raggiunto non sta servendo il bundle del commit M13 analizzato.

## Configurazione e build

`git diff origin/main...HEAD -- vercel.json` non produce differenze: M13 non ha modificato rewrites o configurazione Vercel.

GitHub espone soltanto il check `Vercel Preview Comments`, concluso con successo e URL generico `https://vercel.com/github`. Senza dashboard Vercel non è disponibile il dettaglio che associa l'URL preview a uno specifico commit/build; il check non prova che il preview fornito corrisponda a `1bcb7d9`.
