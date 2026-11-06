"""Offline: synthetic keychain IDs only, no network or real Make credentials."""
import contextlib
import copy
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from collega_chiave_make import bind_template, nodes, selected_key_id, ConfigurationError

ROOT = Path(__file__).resolve().parent
TEMPLATE = ROOT / "AmazonOrdiniGiornalieriEU-SoKeto.blueprint.json"
SEED = ROOT / "CollegaChiaveMake-SoKeto.blueprint.json"
MODULE = "http:ActionSendDataAPIKeyAuth"
SYNTHETIC_ID = 987654


class SingleKeyTests(unittest.TestCase):
    def setUp(self):
        self.template = json.loads(TEMPLATE.read_text())
        self.export = {"flow": [{"module": MODULE, "parameters": {"auth": SYNTHETIC_ID}}]}

    def test_extracts_reference_only_not_secret_or_export_data(self):
        self.export["private"] = "PRIVATE_VALUE_MUST_NOT_LEAVE_EXPORT"
        self.export["flow"][0]["mapper"] = {"headers": [{"name": "X-SoKeto-Amazon-Key", "value": "PRIVATE_SECRET"}]}
        bound = bind_template(self.template, selected_key_id(self.export))
        self.assertNotIn("PRIVATE_", json.dumps(bound))
        self.assertNotIn("private", bound)

    def test_all_36_references_use_one_key(self):
        bound = bind_template(self.template, SYNTHETIC_ID)
        calls = [n for n in nodes(bound) if n.get("module") == MODULE]
        self.assertEqual(len(calls), 36)
        self.assertEqual({n["parameters"]["auth"] for n in calls}, {SYNTHETIC_ID})
        self.assertTrue(all(not any(h["name"] == "X-SoKeto-Amazon-Key" for h in n["mapper"]["headers"]) for n in calls))

    def test_binding_changes_only_auth_references(self):
        bound = bind_template(self.template, SYNTHETIC_ID)
        for n in nodes(bound):
            if n.get("module") == MODULE:
                n["parameters"]["auth"] = 0
        self.assertEqual(bound, self.template)

    def test_same_reference_repeated_is_accepted(self):
        self.export["flow"] *= 2
        self.assertEqual(selected_key_id(self.export), SYNTHETIC_ID)

    def test_missing_zero_boolean_negative_or_string_reference_rejected(self):
        for auth in [None, 0, False, True, -5, "987654"]:
            with self.subTest(auth=auth), self.assertRaises(ConfigurationError):
                selected_key_id({"flow": [{"module": MODULE, "parameters": {"auth": auth}}]})

    def test_two_different_keys_rejected(self):
        self.export["flow"].append({"module": MODULE, "parameters": {"auth": SYNTHETIC_ID + 1}})
        with self.assertRaises(ConfigurationError):
            selected_key_id(self.export)

    def test_wrong_template_or_non_gateway_target_rejected(self):
        wrong = copy.deepcopy(self.template)
        wrong["flow"][0]["mapper"]["url"] = "https://foreign.invalid/"
        with self.assertRaises(ConfigurationError):
            bind_template(wrong, SYNTHETIC_ID)
        with self.assertRaises(ConfigurationError):
            bind_template({"flow": []}, SYNTHETIC_ID)

    def test_public_template_cannot_be_overwritten_with_bound_values(self):
        bound = bind_template(self.template, SYNTHETIC_ID)
        with self.assertRaises(ConfigurationError):
            bind_template(bound, SYNTHETIC_ID)
        self.assertTrue(all(n["parameters"]["auth"] == 0 for n in nodes(self.template) if n.get("module") == MODULE))

    def test_seed_has_one_key_module_no_import_side_effect_route(self):
        seed = json.loads(SEED.read_text())
        calls = [n for n in nodes(seed) if "module" in n]
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["module"], MODULE)
        self.assertEqual(calls[0]["parameters"]["auth"], 0)
        self.assertEqual(calls[0]["mapper"]["url"], "https://gestionale.soketo.it/api/health")
        self.assertEqual(calls[0]["mapper"]["method"], "get")
        self.assertTrue(seed["metadata"]["scenario"]["confidential"])
        self.assertFalse(seed["metadata"]["scenario"]["dlq"])
        self.assertTrue(seed["metadata"]["scenario"]["sequential"])

    def test_cli_output_is_private_and_does_not_print_reference_or_secret(self):
        with tempfile.TemporaryDirectory() as directory:
            export = Path(directory) / "private.json"
            output = Path(directory) / "private-output.json"
            self.export["secret"] = "PRIVATE_VALUE"
            export.write_text(json.dumps(self.export))
            command = [sys.executable, str(ROOT / "collega_chiave_make.py"), "--export-chiave", str(export), "--template", str(TEMPLATE), "--output", str(output)]
            result = subprocess.run(command, capture_output=True, text=True, env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn(str(SYNTHETIC_ID), result.stdout + result.stderr)
            self.assertNotIn("PRIVATE_VALUE", result.stdout + result.stderr + output.read_text())
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)
            original = output.read_bytes()
            repeated = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(repeated.returncode, 1)
            self.assertEqual(output.read_bytes(), original)

    def test_cli_invalid_json_does_not_echo_body_or_private_path(self):
        with tempfile.TemporaryDirectory() as directory:
            export = Path(directory) / "PRIVATE_PATH.json"
            export.write_text('{"secret":"PRIVATE_VALUE"', encoding="utf-8")
            result = subprocess.run([sys.executable, str(ROOT / "collega_chiave_make.py"), "--export-chiave", str(export), "--output", str(Path(directory) / "output.json")], capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertNotIn("PRIVATE_", result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
