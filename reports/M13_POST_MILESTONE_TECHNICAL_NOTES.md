# M13 — Nota tecnica post-milestone

## Identificazione inter-company

L'esclusione M13 del retailer inter-company usa temporaneamente la costante
`SOKETO_SRL_RETAILER_ID`, condivisa con l'hotfix M11.D. La scelta mantiene la
stessa semantica del flusso inter-company esistente, ma copre un solo
rivenditore e può degradare silenziosamente se la struttura societaria o la
direzione dei trasferimenti cambia.

In una milestone separata va introdotto un campo esplicito
`retailers.isInterCompany boolean NOT NULL DEFAULT false`, con migration,
backfill, policy amministrativa e test di entrambe le direzioni del rapporto.
Il job M13 dovrà filtrare `isInterCompany = false` al posto dell'UUID.

Questa nota non introduce alcuna modifica di schema o comportamento nel
branch corrente.
