"""Audit solo locale: nessuna rete, Make, variabile privata o scrittura DB.

I casi sintetici del modulo 97 controllano il contratto di trasporto, non
eseguono formule Make né sostituiscono i test del parser o il collaudo live.
"""
from pathlib import Path
import collections
import copy
import gzip
import hashlib
import json
import unittest
import uuid

ROOT = Path(__file__).resolve().parent
BLUEPRINT = ROOT / "AmazonOrdiniGiornalieriEU-SoKeto.blueprint.json"
REPORT_TYPE = "GET_FLAT_FILE_ALL_ORDERS_DATA_BY_LAST_UPDATE_GENERAL"
NORMAL_IDS = [1, 2, 3, 4, 23, 24, 25, 27, 29, 31, 33, 35, 37, 39, 40, 41,
              43, 45, 47, 49, 51, 53, 55, 56, 57, 59, 61, 63, 65, 67, 69, 71,
              72, 73, 75, 77, 79, 81, 83, 85, 87, 89, 90, 91, 93, 95, 97, 99,
              101, 103, 105, 106, 107, 109, 111, 113, 115, 117, 119, 121, 122,
              123, 125, 127, 129, 131, 133, 135, 137, 138, 139, 141, 143, 145,
              147, 149, 151, 153]
HTTP_IDS = [1, 4, 31, 33, 35, 37, 47, 49, 51, 53, 63, 65, 67, 69, 79, 81,
            83, 85, 87, 97, 99, 101, 103, 113, 115, 117, 119, 129, 131, 133,
            135, 145, 147, 149, 151, 153]
# SHA-256 di JSON pubblico canonico del sorgente nativefilters, dopo rimozione
# ricorsiva onerror; nessuna dipendenza da altri worktree per ripetere i test.
FLOW_SHA256 = "235e6d23c5e848a77ffe7ad556b4b02f8ecc7ae263ef684a7f166519ff849c57"
BLUEPRINT_SHA256 = "d8545349c206a022163d2340d9212de152e4e2ca770f2153750c87009696d3cf"
HEADERS_SHA256 = "232cb67498d0dd8900277259ec5aaac2b8855eb2e66c32685e293423d80e7614"


def dictionaries(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from dictionaries(child)
    elif isinstance(value, list):
        for child in value:
            yield from dictionaries(child)


def digest(value):
    canonical = json.dumps(value, sort_keys=True, separators=(",", ":"),
                           ensure_ascii=False).encode()
    return hashlib.sha256(canonical).hexdigest()


def headers(module):
    return {h["name"]: h["value"] for h in module["mapper"]["headers"]}


def legacy_view(data):
    """Undo only the documented Keys changes to compare against the old flow."""
    result = copy.deepcopy(data)
    result["name"] = "SoKeto - Amazon EU - Ordini giornalieri - Collector FBM"
    for item in dictionaries(result):
        if item.get("module") != "http:ActionSendDataAPIKeyAuth":
            continue
        item["module"] = "http:ActionSendData"
        del item["parameters"]["auth"]
        del item["metadata"]["parameters"]
        item["mapper"]["authUser"] = ""
        item["mapper"]["authPass"] = ""
        item["mapper"]["headers"].insert(0, {"name": "X-SoKeto-Amazon-Key", "value": "DA_CONFIGURARE"})
    return result


def transport_issues97(context, body):
    """Controllo referenziale sintetico, NON validatore di produzione.

    context usa nomi header reali più il solo expected_document_id sintetico.
    Non verifica righe, date, autenticazione privata o idempotenza DB.
    """
    problems = set()
    try:
        uuid.UUID(context.get("X-Amazon-Import-Run-Id", ""))
    except (ValueError, TypeError, AttributeError):
        problems.add("RUN_HEADER")
    if not context.get("X-Amazon-Report-Id"):
        problems.add("REPORT_HEADER")
    doc = context.get("X-Amazon-Report-Document-Id")
    if not doc or doc != context.get("expected_document_id"):
        problems.add("DOCUMENT_HEADER")
    if context.get("X-Amazon-Processing-Status") != "DONE":
        problems.add("STATUS_HEADER")
    if context.get("X-Amazon-Report-Type") != REPORT_TYPE:
        problems.add("REPORT_TYPE")
    if context.get("X-Amazon-Body-Format") != "ORIGINAL_REPORT_DOCUMENT":
        problems.add("BODY_FORMAT")
    algorithm = context.get("X-Amazon-Compression-Algorithm")
    if algorithm not in {"GZIP", "NONE"}:
        problems.add("COMPRESSION_UNSUPPORTED")
    if not isinstance(body, bytes) or not body:
        problems.add("RAW_BYTES")
        return problems
    is_gzip = body.startswith(b"\x1f\x8b")
    if is_gzip != (algorithm == "GZIP"):
        problems.add("COMPRESSION_MISMATCH")
        return problems
    try:
        decoded = gzip.decompress(body) if is_gzip else body
    except (OSError, EOFError):
        problems.add("GZIP_INVALID")
        return problems
    try:
        text = decoded.decode("utf-8-sig")
    except UnicodeDecodeError:
        problems.add("ENCODING")
        return problems
    if text.startswith(("{{", "{", "<")) or "amazon-order-id" not in text.splitlines()[0]:
        problems.add("DOCUMENT_CONTENT")
    return problems


def synthetic_context97():
    # Valori fittizi hard-coded; non provengono da account/ordini/segreti reali.
    return {
        "X-Amazon-Import-Run-Id": "00000000-0000-4000-8000-000000000001",
        "X-Amazon-Report-Id": "SYNTHETIC_REPORT",
        "X-Amazon-Report-Document-Id": "SYNTHETIC_DOCUMENT",
        "expected_document_id": "SYNTHETIC_DOCUMENT",
        "X-Amazon-Processing-Status": "DONE",
        "X-Amazon-Report-Type": REPORT_TYPE,
        "X-Amazon-Compression-Algorithm": "NONE",
        "X-Amazon-Body-Format": "ORIGINAL_REPORT_DOCUMENT",
    }


class RecoveryWithoutRetryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = json.loads(BLUEPRINT.read_text())
        cls.legacy = legacy_view(cls.data)
        cls.legacy_modules = {n["id"]: n for n in dictionaries(cls.legacy) if "module" in n}
        cls.nodes = list(dictionaries(cls.data))
        cls.modules = {n["id"]: n for n in cls.nodes if "module" in n}
        cls.tsv = b"amazon-order-id\torder-item-id\titem-status\tfulfillment-channel\n"

    def test_three_scenario_preferences(self):
        scenario = self.data["metadata"]["scenario"]
        for name, expected in [("confidential", True), ("dlq", False), ("sequential", True)]:
            self.assertIs(scenario[name], expected)

    def test_other_preferences_are_preserved(self):
        scenario = dict(self.data["metadata"]["scenario"])
        for name in ["confidential", "dlq", "sequential"]:
            del scenario[name]
        self.assertEqual(scenario, {"roundtrips": 1, "maxErrors": 3,
                         "autoCommit": True, "autoCommitTriggerLast": True,
                         "slots": None, "dataloss": False, "freshVariables": False})
        self.assertFalse(self.data["metadata"]["instant"])

    def test_onerror_is_absent_recursively_including_empty_routes(self):
        self.assertFalse(any("onerror" in n for n in self.nodes))

    def test_no_error_handler_or_retry_configuration_remains(self):
        self.assertFalse(any(n.get("module") in {"builtin:Break", "builtin:Retry",
                         "builtin:Rollback", "builtin:Ignore", "builtin:Resume"}
                         for n in self.nodes))
        self.assertFalse(any("retry" in n for n in self.nodes))

    def test_all_78_normal_ids_are_preserved_without_invented_modules(self):
        self.assertEqual(sorted(self.modules), NORMAL_IDS)
        self.assertEqual(collections.Counter(n["module"] for n in self.modules.values()),
                         {"http:ActionSendDataAPIKeyAuth": 36, "builtin:BasicRouter": 9,
                          "amazon-seller-central:createReport": 1,
                          "util:FunctionSleep": 8, "amazon-seller-central:universal": 16,
                          "http:ActionGetFile": 8})

    def test_normal_flow_equals_nativefilters_source_minus_onerror(self):
        self.assertEqual(digest(self.legacy["flow"]), FLOW_SHA256)

    def test_complete_public_blueprint_matches_expected_normalization(self):
        self.assertEqual(digest(self.legacy), BLUEPRINT_SHA256)

    def test_all_header_arrays_are_byte_semantically_unchanged(self):
        values = {str(i): self.legacy_modules[i]["mapper"]["headers"] for i in HTTP_IDS}
        self.assertEqual(digest(values), HEADERS_SHA256)

    def test_36_credentials_are_unbound_references_without_literal_secrets(self):
        calls = [n for n in self.modules.values() if n["module"] == "http:ActionSendDataAPIKeyAuth"]
        self.assertEqual(sorted(n["id"] for n in calls), HTTP_IDS)
        for module in calls:
            self.assertEqual(module["parameters"]["auth"], 0)
            self.assertNotIn("X-SoKeto-Amazon-Key", headers(module))
            self.assertNotIn("authUser", module["mapper"])
            self.assertNotIn("authPass", module["mapper"])
            self.assertEqual(module["metadata"]["parameters"], [{"name": "auth", "type": "keychain:apikeyauth", "label": "Credentials", "required": True}])

    def test_http_errors_are_not_silently_ignored(self):
        for n in self.modules.values():
            if n["module"].startswith("http:"):
                self.assertIs(n["parameters"]["handleErrors"], True)

    def test_eight_existing_polling_sleeps_are_preserved(self):
        sleeps = [n for n in self.modules.values() if n["module"] == "util:FunctionSleep"]
        self.assertEqual(len(sleeps), 8)
        self.assertTrue(all(n["mapper"]["duration"] == 60 for n in sleeps))

    def test_every_download_reacquires_get_report_document_metadata(self):
        for document, download in [(27, 29), (43, 45), (59, 61), (75, 77),
                                   (93, 95), (109, 111), (125, 127), (141, 143)]:
            with self.subTest(document=document):
                self.assertEqual(self.modules[download]["mapper"]["url"],
                                 "{{" + str(document) + ".body.url}}")
                self.assertEqual(self.modules[document]["mapper"]["qs"], [])
                self.assertIs(self.modules[download]["parameters"]["useNewZLibDeCompress"], False)
                self.assertNotIn("headers", self.modules[download]["mapper"])

    def test_all_eight_uploads_keep_raw_data_and_metadata_origins(self):
        for poll, doc, download, upload in [(24, 27, 29, 31), (40, 43, 45, 47),
                (56, 59, 61, 63), (72, 75, 77, 79), (90, 93, 95, 97),
                (106, 109, 111, 113), (122, 125, 127, 129), (138, 141, 143, 145)]:
            with self.subTest(upload=upload):
                mapper = self.modules[upload]["mapper"]
                h = headers(self.modules[upload])
                self.assertTrue(mapper["url"].endswith("/report-file"))
                self.assertEqual(mapper["bodyType"], "raw")
                self.assertEqual(mapper["contentType"], "text/plain")
                self.assertEqual(mapper["data"], "{{" + str(download) + ".data}}")
                self.assertEqual(h["X-Amazon-Report-Document-Id"], "{{" + str(poll) + ".body.reportDocumentId}}")
                self.assertEqual(h["X-Amazon-Compression-Algorithm"],
                                 '{{ifempty(' + str(doc) + '.body.compressionAlgorithm; "NONE")}}')
                self.assertEqual(h["X-Amazon-Body-Format"], "ORIGINAL_REPORT_DOCUMENT")

    def test_module97_exact_static_contract(self):
        module = self.modules[97]
        mapper = module["mapper"]
        self.assertEqual(mapper["url"], "https://gestionale.soketo.it/api/marketplace/amazon/report-file")
        self.assertEqual(mapper["method"], "post")
        self.assertFalse(mapper["parseResponse"])
        self.assertFalse(mapper["gzip"])
        self.assertEqual(mapper["data"], "{{95.data}}")
        h = headers(module)
        self.assertEqual(len(h), 11)
        self.assertEqual(h["X-Amazon-Import-Run-Id"], "{{1.data.run_id}}")
        self.assertEqual(h["X-Amazon-Report-Id"], "{{1.data.report_id}}")
        self.assertEqual(h["X-Amazon-Processing-Status"], "{{90.body.processingStatus}}")
        self.assertEqual(h["X-Amazon-Report-Document-Id"], "{{90.body.reportDocumentId}}")
        self.assertEqual(h["X-Amazon-Report-Type"], REPORT_TYPE)
        self.assertEqual(h["X-Amazon-Import-Policy"], "FBM_SHIPPED")
        self.assertEqual(h["X-Amazon-Window-Start"], "{{1.data.window_start}}")
        self.assertEqual(h["X-Amazon-Window-End"], "{{1.data.window_end}}")

    def test_signed_download_url_is_not_sent_to_server(self):
        for n in self.modules.values():
            if n["module"] == "http:ActionSendDataAPIKeyAuth":
                text = json.dumps(n["mapper"])
                self.assertNotRegex(text, r"\{\{\d+\.body\.url\}\}")
                self.assertNotIn("X-Amz-Signature", text)

    def test_module97_synthetic_plain_transport(self):
        self.assertEqual(transport_issues97(synthetic_context97(), self.tsv), set())
        self.assertEqual(transport_issues97(synthetic_context97(), b"\xef\xbb\xbf" + self.tsv), set())

    def test_module97_synthetic_gzip_transport(self):
        context = synthetic_context97()
        context["X-Amazon-Compression-Algorithm"] = "GZIP"
        compressed = gzip.compress(self.tsv, mtime=0)
        self.assertEqual(transport_issues97(context, compressed), set())
        self.assertEqual(gzip.decompress(compressed), self.tsv)

    def test_module97_synthetic_header_mismatches_are_detected(self):
        cases = [("X-Amazon-Import-Run-Id", "run_id", "RUN_HEADER"),
                 ("X-Amazon-Report-Id", "", "REPORT_HEADER"),
                 ("X-Amazon-Report-Document-Id", "SYNTHETIC_REPORT", "DOCUMENT_HEADER"),
                 ("X-Amazon-Report-Document-Id", "{{90.body.reportDocumentId}}", "DOCUMENT_HEADER"),
                 ("X-Amazon-Processing-Status", "IN_PROGRESS", "STATUS_HEADER"),
                 ("X-Amazon-Report-Type", "OTHER", "REPORT_TYPE"),
                 ("X-Amazon-Body-Format", "JSON", "BODY_FORMAT"),
                 ("X-Amazon-Compression-Algorithm", "ZIP", "COMPRESSION_UNSUPPORTED")]
        for name, value, expected in cases:
            with self.subTest(header=name, value=value):
                context = synthetic_context97()
                context[name] = value
                self.assertIn(expected, transport_issues97(context, self.tsv))

    def test_module97_synthetic_compression_mismatches_are_detected(self):
        context = synthetic_context97()
        self.assertIn("COMPRESSION_MISMATCH", transport_issues97(context, gzip.compress(self.tsv, mtime=0)))
        context["X-Amazon-Compression-Algorithm"] = "GZIP"
        self.assertIn("COMPRESSION_MISMATCH", transport_issues97(context, self.tsv))
        self.assertIn("GZIP_INVALID", transport_issues97(context, b"\x1f\x8bINVALID"))

    def test_module97_synthetic_non_document_bodies_are_detected(self):
        cases = [("{{95.data}}", "RAW_BYTES"), (b"", "RAW_BYTES"),
                 (b"{{95.data}}", "DOCUMENT_CONTENT"),
                 (b'{"data":"SYNTHETIC"}', "DOCUMENT_CONTENT"),
                 (b"<Error>Request has expired</Error>", "DOCUMENT_CONTENT"),
                 (b"\xff", "ENCODING")]
        for body, expected in cases:
            with self.subTest(expected=expected):
                self.assertIn(expected, transport_issues97(synthetic_context97(), body))


if __name__ == "__main__":
    unittest.main(verbosity=2)
