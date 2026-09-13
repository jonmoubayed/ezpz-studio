import copy
import io
import json
import os
import threading
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from pypdf import PdfWriter

from backend.cuad import FIELDS, normalize_answer, prepare_document, processor_config, select_documents, digest, write_bundle
from backend.cuad_import import LocalStudio, import_bundle
from backend.evaluation import score_extraction
from backend.server import make_server


class CuadConversionTests(unittest.TestCase):
    def test_absent_is_null_but_missing_normalized_answer_is_unscored(self):
        absent = {"is_impossible": True, "answers": []}
        present = {"is_impossible": False, "answers": [{"text": "some renewal clause", "answer_start": 0}]}
        self.assertEqual(normalize_answer("renewal_term", "", absent)[:2], (True, None))
        self.assertEqual(normalize_answer("renewal_term", "", present)[:2], (False, None))
        self.assertEqual(normalize_answer("termination_for_convenience", "No", absent)[:2], (True, False))

    def test_dates_do_not_invent_missing_components_or_discard_alternatives(self):
        qa = {"is_impossible": False, "answers": [{"text": "date"}]}
        self.assertEqual(normalize_answer("effective_date", "5/8/14", qa)[:2], (True, "2014-05-08"))
        self.assertEqual(normalize_answer("agreement_date", "1/1/98", qa)[:2], (True, "1998-01-01"))
        for value in ("[]/[]/2020", "2/30/2020", "5/8/14; 5/9/14", "upon approval"):
            self.assertFalse(normalize_answer("effective_date", value, qa)[0])
        self.assertEqual(normalize_answer("expiration_date", "Perpetual", qa)[:2], (True, "perpetual"))
        self.assertEqual(normalize_answer("notice_period_to_terminate_renewal", "180 days / 6 months", qa)[:2], (True, "180 days / 6 months"))

    def test_selection_is_reproducible_balanced_and_disjoint(self):
        docs = [{"title": str(i), "notice_positive": i % 2 == 0} for i in range(100)]
        selected = select_documents(docs)
        self.assertEqual(selected, select_documents(list(reversed(docs))))
        self.assertNotEqual(selected, select_documents(docs, seed="another-seed"))
        self.assertEqual(len({d["title"] for d in selected}), 50)
        self.assertEqual(sum(d["notice_positive"] for d in selected), 25)
        self.assertEqual(sum(d["split"] == "test" for d in selected), 10)
        self.assertEqual(sum(d["split"] == "test" and d["notice_positive"] for d in selected), 5)
        with self.assertRaises(ValueError):
            select_documents(docs[:4])

    def test_native_scorer_handles_gold_missing_and_hallucinated_values(self):
        schema = processor_config()["schema"]
        gold = {"document_name": "Agreement", "effective_date": "2014-05-08", "renewal_term": None, "termination_for_convenience": False}
        fields = {k: {"value": v} for k, v in gold.items()}
        score = score_extraction({"fields": fields}, {"value": gold}, schema)
        self.assertEqual(score["metrics"]["field_accuracy"], 1)
        self.assertEqual(score["metrics"]["scored_fields"], 4)
        # Omitted annotation is not scored even when the model provides a value.
        fields["expiration_date"] = {"value": "2099-01-01"}
        fields["renewal_term"] = {"value": "successive 1 year"}
        fields["termination_for_convenience"] = {"value": True}
        del fields["effective_date"]
        score = score_extraction({"fields": fields}, {"value": gold}, schema)
        self.assertEqual(score["fields"]["renewal_term"]["status"], "hallucinated")
        self.assertEqual(score["fields"]["termination_for_convenience"]["status"], "incorrect")
        self.assertEqual(score["fields"]["effective_date"]["status"], "missing")
        self.assertNotIn("expiration_date", score["fields"])
        self.assertEqual(score["metrics"]["field_accuracy"], .25)


def fixture_document(root, index):
    categories = [category for category, _ in FIELDS.values()] + ["Unscored category " + str(i) for i in range(34)]
    context = "Synthetic renewal evidence " + str(index)
    title = "Contract " + str(index)
    qas = [{"id": title + "__" + category, "question": category, "is_impossible": False,
            "answers": [{"answer_start": 0, "text": context}]} for category in categories]
    row = {category + "-Answer": "" for category in categories}
    row.update({"Filename": title + ".pdf", "Document Name-Answer": title, "Termination For Convenience-Answer": "No"})
    pdf = root / (title + ".pdf")
    writer = PdfWriter()
    writer.add_blank_page(width=100, height=100)
    writer.add_metadata({"/Title": title})
    writer.write(pdf)
    source = {"title": title, "paragraphs": [{"context": context, "qas": qas}]}
    return source, row, pdf


class CuadImportTests(unittest.TestCase):
    def test_span_validation_rejects_corrupted_offsets(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            source, row, pdf = fixture_document(root, 0)
            prepared = prepare_document(source, row, pdf, root)
            self.assertEqual(len(prepared["qas"]), 41)
            self.assertEqual(prepared["csv_row"], row)
            source["paragraphs"][0]["qas"][0]["answers"][0]["answer_start"] = 1
            with self.assertRaisesRegex(ValueError, "span does not match"):
                prepare_document(source, row, pdf, root)

    def test_local_origins_only(self):
        for url in ("https://example.com", "http://127.0.0.1.evil.test", "http://user:pass@localhost:4173", "http://localhost:4173/other"):
            with self.assertRaises(ValueError):
                LocalStudio(url)

    def test_real_api_import_is_idempotent_and_protects_existing_truth(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            docs = []
            for i in range(4):
                source, row, pdf = fixture_document(root, i)
                doc = prepare_document(source, row, pdf, root)
                doc["split"] = "test" if i == 0 else "dev"
                docs.append(doc)
            bundle = {"version": 1, "fingerprint": digest([d["title"] for d in docs]), "source_root": str(root), "documents": docs, "processor": processor_config(), "coverage": {}}
            with patch.dict(os.environ, {"EZPZ_DATABASE_URL": "sqlite:///" + str(root / "test.db"), "EZPZ_BLOB_ROOT": str(root / "blobs"), "EZPZ_SEED_DEMO": "false"}):
                server = make_server(root, port=0)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                api = LocalStudio("http://127.0.0.1:" + str(server.server_address[1]))
                output = write_bundle(bundle, root / "bundle")
                first = import_bundle(api, bundle, output, progress=lambda _: None)
                self.assertEqual(first["uploaded"], 4)
                second = import_bundle(api, bundle, output, progress=lambda _: None)
                self.assertEqual(second["uploaded"], 0)
                self.assertEqual(first["experiments"], second["experiments"])
                db = server.RequestHandlerClass.runtime.database
                self.assertEqual(len(db.list_documents()), 4)
                self.assertEqual(len(db.list_runs()), 0)
                self.assertEqual(len(db.list_dataset_documents(first["datasets"]["dev"])), 3)
                self.assertEqual(len(db.list_dataset_documents(first["datasets"]["test"])), 1)
                for doc in first["documents"]:
                    self.assertEqual(len(db.list_ground_truth_revisions(doc["document_id"])), 1)
                    # Uploaded model inputs contain neither labels nor supplied
                    # OCR text that could accidentally include expected answers.
                    self.assertEqual(db.get_document(doc["document_id"])["metadata"], {})
                preserved = [json.loads(line) for line in (output / "ground-truth.jsonl").read_text().splitlines()]
                self.assertTrue(all(len(d["qas"]) == 41 for d in preserved))
                doc_id = first["documents"][0]["document_id"]
                db.save_ground_truth(doc_id, {"document_name": "User correction"})
                with self.assertRaisesRegex(ValueError, "No labels were overwritten"):
                    import_bundle(api, bundle, output, progress=lambda _: None)
                self.assertEqual(db.get_ground_truth(doc_id)["value"], {"document_name": "User correction"})
                self.assertEqual(len(db.list_ground_truth_revisions(doc_id)), 2)
            finally:
                server.shutdown()
                server.server_close()
                thread.join()


if __name__ == "__main__":
    unittest.main()
