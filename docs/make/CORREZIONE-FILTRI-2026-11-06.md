# Correzione filtri del blueprint Amazon — 6 novembre 2026

Il primo Run once ha raggiunto il gestionale ma si è fermato prima di Create a report: il runtime Make ha rifiutato la funzione `equal()` dentro i due filtri iniziali. La correzione elimina completamente quelle chiamate e il relativo `if()`, usando i confronti nativi del pannello filtri. Non cambia endpoint, connessioni, finestre, polling, body raw o header. Non richiede migration o deployment del gestionale.

## Aggiornare lo scenario esistente senza reinserire il segreto

**Non occorre reimportare il blueprint.** Mantieni la pianificazione OFF e modifica soltanto i due filtri del primo router, dopo HTTP import-window, modulo 1.

In entrambi i filtri imposta l'operando sinistro a:

```text
{{ifempty(1.data.report_id; "NONE")}}
```

Usa il token `report_id` restituito dal modulo HTTP 1: non digitare il nome del campo come semplice testo. Nel blueprint il riferimento è `1.data.report_id`. Imposta l'operando destro al testo **NONE**, senza virgolette.

1. **Ramo verso Amazon Seller Central – Create a report, modulo 3.** Filtro “Nessun report pending: crea una sola richiesta”: scegli **Text operators → Equal to (case insensitive)**, ossia il confronto testuale di uguaglianza senza distinzione maiuscole/minuscole. La condizione è operando sinistro uguale a NONE.
2. **Ramo verso Sleep, modulo 89, che riprende un report salvato.** Filtro “Report pending salvato: riprendi lo stesso report”: scegli **Text operators → Not equal to (case insensitive)**. La condizione è operando sinistro diverso da NONE.

Rimuovi la vecchia formula `if(equal(...))` da entrambi. Non aggiungere condizioni OR o AND. Salva lo scenario senza attivarne la pianificazione. Non aprire o modificare gli header: tutti i segreti già inseriti nei 36 moduli HTTP restano invariati.

`ifempty` restituisce NONE per report_id assente, nullo o vuoto. NONE è il segnaposto “nessun report” del filtro, non un ID da inviare ad Amazon. I report ID Amazon effettivi non devono essere sostituiti con questo testo. I due confronti sono complementari: viene selezionato un solo ramo.

Il [blueprint corretto](AmazonOrdiniGiornalieriEU-SoKeto.blueprint.json) è disponibile per nuove importazioni. Se lo reimporti, il JSON pubblico contiene soltanto `DA_CONFIGURARE`: la configurazione privata non viene incorporata e dovrai verificare le connessioni e reinserire i segreti ove sostituiti. Per lo scenario già configurato, la modifica manuale dei due filtri è la soluzione consigliata.

## Funzioni verificate in tutto il documento

Il censimento ricorsivo ha esaminato tutte le espressioni `{{...}}`, comprese quelle nei rami di errore e di recupero. Il file iniziale conteneva `if` due volte, `equal` due volte, `ifempty` dieci volte e `switch` quaranta volte. Non sono emerse altre chiamate a funzioni.

Il blueprint corretto contiene soltanto:

- **`ifempty(value1; value2)` — 10 chiamate.** Due normalizzano report_id nei filtri iniziali; otto impostano NONE per l'algoritmo di compressione assente. La funzione è documentata ufficialmente, anche per valori unknown e stringhe vuote. [1]
- **`switch(expression; value1; result1; …; else)` — 40 chiamate.** Seleziona i rami DONE, CANCELLED, FATAL, PENDING e UNEXPECTED nei controlli dello stato Amazon. È documentata ufficialmente. [1]

`if(expression; value1; value2)` è una funzione Make documentata, con esempi che usano l'operatore `=`; non è più necessaria né presente nelle formule corrette. [1]

**Precisazione:** la documentazione Make consultata oggi elenca anche `equal(value; value)`, ma il Run once dell'utente l'ha rifiutata in quel contesto. Non assumiamo che il runtime dello scenario la supporti: entrambe le chiamate sono eliminate. Non viene introdotta alcuna funzione di confronto alternativa. `text:equal:ci` e `text:notequal:ci` sono operatori del pannello filtri, non chiamate a `equal()`. La codifica dell'operatore Not equal case-insensitive è riscontrata in un export Make reale. [2] [3] [4]

Sono passati **6 test offline**: censimento/allowlist delle funzioni, filtri complementari, casi null/vuoto/report presente, segnaposto delle 36 chiavi, ID dei moduli univoci e riferimenti ai moduli validi. La verifica strutturale conferma che, rimessi i due filtri originali, il JSON è identico al precedente. Questi controlli non sono un collaudo del runtime Make: il prossimo Run once resta necessario.

Per ripetere i controlli senza connessioni esterne:

```sh
python3 docs/make/test_blueprint_native_filters.py
```

## Stato DB della prima prova — verifica read-only

Rilevato il 6 novembre 2026, circa alle 10:27 Europe/Rome:

- Una sola esecuzione aperta, creata alle **10:21:04.471422**, stato **requested**.
- Finestra **01/09/2026 00:00 → 01/10/2026 00:00 Europe/Rome**.
- Dry run configurazione ed esecuzione **ON**, import abilitato **ON**.
- Nessun report ID, documento o file acquisito; nessun errore salvato dal backend.
- **0 osservazioni importate, 0 allocazioni stock**, checkpoint ancora NULL.

Il codice di import-window legge sotto lock le esecuzioni requested/pending/processing e restituisce quella già aperta prima di crearne una nuova. Poiché qui manca report_id, la prossima prova riprende **la stessa esecuzione e la stessa finestra**, entra nel ramo Create a report e richiede il primo report Amazon. Non va chiusa o cancellata la riga DB. L'errore del filtro è avvenuto prima della creazione Amazon e non risulta registrato come errore server.

Nessuna modifica al DB, chiamata Amazon o esecuzione Make è stata effettuata durante questa correzione. Scenario automatico sempre OFF e dry run ON. Gli ordini evento restano esclusi da questo intervento.

## References

[1]: https://help.make.com/general-functions "Make — General functions: if, ifempty e switch"
[2]: https://help.make.com/filtering "Make — Filtri e operatori nativi del pannello"
[3]: https://github.com/integromat/make-skills/blob/main/skills/make-scenario-building/blueprint-construction.md "Make — Riferimento struttura blueprint e codifica operatori"
[4]: https://community.make.com/t/scraping-data-from-multiple-pages-based-on-main-webpage/47367/5 "Make Community — Export con text:notequal:ci"
