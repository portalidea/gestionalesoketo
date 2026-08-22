# M13 — Nota tecnica post-milestone

## Identificazione inter-company

L'esclusione M13 del retailer inter-company usa temporaneamente la costante
`SOKETO_SRL_INTERCOMPANY_RETAILER_ID`. Essa è distinta dal locationId legacy
di M11.D, copre un solo rivenditore e può degradare silenziosamente se la
struttura societaria o la direzione dei trasferimenti cambia.

In una milestone separata va introdotto un campo esplicito
`retailers.isInterCompany boolean NOT NULL DEFAULT false`, con migration,
backfill, policy amministrativa e test di entrambe le direzioni del rapporto.
Il job M13 dovrà filtrare `isInterCompany = false` al posto dell'UUID.

Questa nota non introduce alcuna modifica di schema o comportamento nel
branch corrente.

## Processo M11.D: carico manuale SoKeto

Gli ordini E-Keto verso il retailer anagrafico **Soketo Srl** sono registrati
come ordini a un cliente ordinario. Il carico del magazzino centrale SoKeto
viene eseguito separatamente e manualmente, perché le due società sono entità
legali distinte pur condividendo il magazzino fisico.

Di conseguenza, la correzione dell'automatismo `isInterCompanyOrder()` /
`loadInterCompanyStock()` non fa parte di M13: attivarla ora duplicerebbe il
carico manuale. Qualsiasi scelta tra processo manuale e automatismo M11.D,
inclusi eventuali storni, riconciliazioni e impatti contabili, richiede una
milestone separata e una decisione operativa esplicita.
