#!/usr/bin/env python3
"""Collega un ID di keychain da un piccolo export Make al blueprint pubblico.

Non usa rete, API Make o variabili server. Non stampa identificativi.
Il valore del segreto non è un input: rimane esclusivamente in Make Keys.
"""
from __future__ import annotations

import argparse
import copy
import json
import os
from pathlib import Path
import sys

DIRECTORY = Path(__file__).resolve().parent
DEFAULT_TEMPLATE = DIRECTORY / "AmazonOrdiniGiornalieriEU-SoKeto.blueprint.json"
KEY_MODULE = "http:ActionSendDataAPIKeyAuth"


class ConfigurationError(ValueError):
    """Only controlled configuration messages may be printed."""



def nodes(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from nodes(child)
    elif isinstance(value, list):
        for child in value:
            yield from nodes(child)


def selected_key_id(export):
    ids = set()
    for item in nodes(export):
        if item.get("module") != KEY_MODULE:
            continue
        auth = item.get("parameters", {}).get("auth")
        if isinstance(auth, int) and not isinstance(auth, bool) and auth > 0:
            ids.add(auth)
    if len(ids) != 1:
        raise ConfigurationError("L'export deve contenere esattamente una keychain API key selezionata. Nessun valore privato è stato stampato.")
    return next(iter(ids))


def bind_template(template, key_id):
    result = copy.deepcopy(template)
    targets = [item for item in nodes(result) if item.get("module") == KEY_MODULE]
    if len(targets) != 36:
        raise ConfigurationError("Il template pubblico non contiene i 36 moduli API key attesi.")
    for item in targets:
        if item.get("version") != 3 or item.get("parameters", {}).get("auth") != 0:
            raise ConfigurationError("Usa il template pubblico con credenziale ancora non associata, non un export configurato.")
        if not item.get("mapper", {}).get("url", "").startswith("https://gestionale.soketo.it/api/marketplace/amazon/"):
            raise ConfigurationError("Un modulo autenticato non punta al gateway SoKeto previsto.")
        if any(str(header.get("name", "")).lower() == "x-soketo-amazon-key" for header in item["mapper"].get("headers", [])):
            raise ConfigurationError("Il template contiene un header segreto manuale: non è la versione Keys.")
        item["parameters"]["auth"] = key_id
    return result


def main():
    parser = argparse.ArgumentParser(description="Associa una sola Make Key ai 36 moduli HTTP senza scrivere il segreto.")
    parser.add_argument("--export-chiave", type=Path, required=True, help="Export privato dello scenario di collegamento, dopo aver selezionato la keychain.")
    parser.add_argument("--template", type=Path, default=DEFAULT_TEMPLATE, help="Blueprint pubblico Keys ancora non associato.")
    parser.add_argument("--output", type=Path, required=True, help="File locale privato da importare in Make. Non committarlo né condividerlo.")
    args = parser.parse_args()
    try:
        export_path = args.export_chiave.expanduser().resolve()
        template_path = args.template.expanduser().resolve()
        output_path = args.output.expanduser().resolve()
        if output_path in {export_path, template_path}:
            raise ConfigurationError("L'output deve essere un file nuovo: non sovrascrivere export o template.")
        export = json.loads(export_path.read_text(encoding="utf-8-sig"))
        template = json.loads(template_path.read_text(encoding="utf-8-sig"))
        # Nessun campo mapper, connessione Amazon o dato dell'export viene copiato.
        # Si usa soltanto il numero che riferisce la keychain già custodita in Make.
        bound = bind_template(template, selected_key_id(export))
        encoded = json.dumps(bound, ensure_ascii=False, indent=4) + "\n"
        fd = os.open(output_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(encoded)
    except (ValueError, OSError, TypeError, KeyError) as error:
        # Non serializzare eccezioni JSON, percorsi privati o frammenti dell'export.
        if isinstance(error, FileExistsError):
            message = "Il file di output esiste già. Scegli un nome nuovo."
        elif isinstance(error, ConfigurationError):
            message = str(error)
        else:
            message = "File non leggibile o non valido: verifica i tre file locali e riprova. Nessun dato privato è stato stampato."
        print(message, file=sys.stderr)
        return 1
    print("Blueprint locale creato: 36 moduli collegati alla stessa Make Key. Valore segreto non richiesto, non copiato e non stampato.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
