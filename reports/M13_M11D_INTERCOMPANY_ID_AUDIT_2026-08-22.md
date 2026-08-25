# Audit M13 / M11.D — UUID inter-company retailer vs location

## Dati confermati dall'utente

| Concetto | UUID |
|---|---|
| Location inter-company SoKeto Srl su E-Keto Food Srls | `d2955b43-4882-4543-a77b-7321cb333468` |
| Retailer inter-company SoKeto Srl su E-Keto Food Srls | `4cad141e-11c4-4eb8-840a-0ebd457a5993` |

La costante esistente `SOKETO_SRL_RETAILER_ID` ha oggi il valore dell'**ID location**, pur essendo commentata e usata come se fosse un **retailerId**.

## Audit degli usi del valore errato

| File / punto | Valore confrontato | Tipo effettivo | Esito con UUID-location nella costante |
|---|---|---|---|
| `server/services/expiryAlertService.ts`, filtro candidati | `r.id` | `retailers.id` / retailerId | Non esclude il retailer reale: filtro inefficace. |
| `server/services/interCompanyTransfer.ts`, `isInterCompanyOrder(retailerId)` | parametro `retailerId` | retailerId | Restituisce sempre `false` per l'ordine reale; M11.D non carica il centrale SoKeto e non esegue il relativo storno. |
| `server/orders-router.ts`, avvio transfer | `order.retailerId` passato a `isInterCompanyOrder` | retailerId | Il carico addizionale M11.D non si attiva per il retailer reale. |
| `server/orders-router.ts`, annullamento | `result.retailerId` passato a `isInterCompanyOrder` | retailerId | Lo storno addizionale M11.D non si attiva per il retailer reale. |
| `server/services/orderStateMachine.ts`, consumo etichette | `order.retailerId !== costante` | retailerId | Considera l'ordine reale come non inter-company e consuma etichette quando dovrebbe saltarle. |
| Query read-only M13 | `r.id` | retailerId | Non esclude il retailer reale; il conteggio `is_temporary_intercompany` resta falso. |
| Seed locale M13 | `retailers.id` fixture | retailerId nella fixture | Fixture modellata erroneamente con l'UUID location; copreva un caso diverso dal database reale. |

Non risultano usi runtime che confrontino `SOKETO_SRL_RETAILER_ID` con `locations.id`. Il valore location è quindi stato usato impropriamente come retailerId nei percorsi M13 e M11.D.

## Funzione M11.D e chiamanti

La funzione è:

```ts
export function isInterCompanyOrder(retailerId: string | null): boolean {
  return retailerId === SOKETO_SRL_RETAILER_ID;
}
```

Entrambi i chiamanti le passano un retailerId.

| Chiamante | Argomento effettivo | Conseguenza attuale |
|---|---|---|
| `orders.startTransfer` | `order.retailerId` | `loadInterCompanyStock()` non viene chiamata sul retailer reale. |
| `orders.cancelOrder` | `result.retailerId` | `reverseInterCompanyStock()` non viene chiamata sul retailer reale. |

Il bug M11.D è pertanto confermato a livello di codice: con l'UUID retailer reale fornito dall'utente la condizione è falsa in entrambi i flussi.

## Separazione delle costanti applicata solo a M13

La correzione deve separare esplicitamente i due identificativi:

```ts
export const SOKETO_SRL_INTERCOMPANY_LOCATION_ID = "d2955b43-4882-4543-a77b-7321cb333468";
export const SOKETO_SRL_INTERCOMPANY_RETAILER_ID = "4cad141e-11c4-4eb8-840a-0ebd457a5993";
```

| Uso | Costante |
|---|---|
| Filtro M13, seed M13 e query read-only M13 | `SOKETO_SRL_INTERCOMPANY_RETAILER_ID` |
| Accesso diretto a una specifica location inter-company, se e solo se necessario | `SOKETO_SRL_INTERCOMPANY_LOCATION_ID` |
| M11.D automatico esistente | `SOKETO_SRL_RETAILER_ID` legacy, invariato per non alterare il processo manuale concordato |

Il seed M13 è riallineato ai due UUID distinti. M11.D resta invariato: una modifica del suo automatismo richiede una decisione di processo separata, perché il carico centrale SoKeto viene oggi eseguito manualmente.

## Soglia minima M13

Il dispatcher continua a caricare `min_pieces_threshold` dalle impostazioni della company e usa `totalPieces < settings.minPiecesThreshold` per creare una notifica `skipped` con motivo `below_threshold`. Il difetto confermato è circoscritto alla Query 2 read-only: essa non incorpora ancora la soglia configurata e può quindi etichettare un retailer sotto soglia come `would_receive_alert`.
