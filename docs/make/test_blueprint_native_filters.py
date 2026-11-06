"""Controlli offline; non esegue formule nel runtime Make e non chiama servizi."""
from pathlib import Path
import collections
import copy
import json
import re
import unittest

ROOT = Path(__file__).resolve().parent
BLUEPRINT = ROOT / "AmazonOrdiniGiornalieriEU-SoKeto.blueprint.json"
ALLOWED_FUNCTIONS = {"ifempty", "switch"}
FILTER_VALUE = '{{ifempty(1.data.report_id; "NONE")}}'


def dictionaries(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from dictionaries(child)
    elif isinstance(value, list):
        for child in value:
            yield from dictionaries(child)


def strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for child in value.values():
            yield from strings(child)
    elif isinstance(value, list):
        for child in value:
            yield from strings(child)


def function_counts(data):
    functions = collections.Counter()
    for text in strings(data):
        for expression in re.findall(r"\{\{(.*?)\}\}", text, flags=re.S):
            functions.update(re.findall(r"\b([A-Za-z_][A-Za-z0-9_]*)\s*\(", expression))
    return functions


class NativeFiltersTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = json.loads(BLUEPRINT.read_text())

    def test_all_formulas_use_only_verified_functions(self):
        counts = function_counts(self.data)
        self.assertEqual(set(counts), ALLOWED_FUNCTIONS)
        self.assertEqual(counts, {"ifempty": 10, "switch": 40})
        self.assertNotRegex(BLUEPRINT.read_text(), r"\bequal\s*\(")

    def test_two_root_filters_are_native_complements(self):
        create, reuse = self.data["flow"][1]["routes"]
        self.assertEqual(create["flow"][0]["id"], 3)
        self.assertEqual(reuse["flow"][0]["id"], 89)
        for route, operator in [(create, "text:equal:ci"), (reuse, "text:notequal:ci")]:
            self.assertEqual(route["flow"][0]["filter"]["conditions"],
                             [[{"a": FILTER_VALUE, "b": "NONE", "o": operator}]])

    def test_reference_semantics_missing_null_empty_and_existing_report(self):
        # Simulazione semantica del fallback e dei confronti, non emulatore Make.
        for report, want_create in [(None, True), ("", True),
                                    ("NONE", True), ("none", True),
                                    ("123456789", False), ("0", False)]:
            with self.subTest(report=report):
                value = "NONE" if report is None or report == "" else report
                create = value.casefold() == "none"
                reuse = value.casefold() != "none"
                self.assertEqual(create, want_create)
                self.assertNotEqual(create, reuse)

    def test_headers_keep_private_configuration_out_of_blueprint(self):
        calls = [node for node in dictionaries(self.data)
                 if node.get("module") == "http:ActionSendData"
                 and node.get("mapper", {}).get("url", "").startswith(
                     "https://gestionale.soketo.it/api/marketplace/amazon/")]
        self.assertEqual(len(calls), 36)
        for node in calls:
            headers = node["mapper"]["headers"]
            key = [h for h in headers if h["name"] == "X-SoKeto-Amazon-Key"]
            self.assertEqual(len(key), 1)
            self.assertEqual(key[0]["value"], "DA_CONFIGURARE")

    def test_module_ids_and_single_create_request(self):
        modules = [n for n in dictionaries(self.data) if "module" in n]
        ids = [n["id"] for n in modules]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertEqual(sum(n["module"] == "amazon-seller-central:createReport"
                             for n in modules), 1)

    def test_mapped_references_point_to_existing_modules(self):
        ids = {n["id"] for n in dictionaries(self.data) if "module" in n}
        for text in strings(self.data):
            for expression in re.findall(r"\{\{(.*?)\}\}", text, flags=re.S):
                for reference in re.findall(r"(?<![\w.])(\d+)\.[A-Za-z_]", expression):
                    self.assertIn(int(reference), ids)


if __name__ == "__main__":
    unittest.main(verbosity=2)
