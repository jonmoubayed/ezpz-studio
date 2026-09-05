import json
import os
import threading
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from urllib.request import urlopen

from backend.server import make_server


class ManifestTests(unittest.TestCase):
    def test_export_includes_latest_ground_truth_and_unannotated_documents(self):
        with TemporaryDirectory() as directory:
            with patch.dict(os.environ, {
                "EZPZ_SEED_DEMO": "false",
                "EZPZ_DATABASE_URL": "sqlite:///{}/test.db".format(directory),
                "EZPZ_BLOB_ROOT": str(Path(directory) / "blobs"),
            }):
                server = make_server(Path(directory), port=0)
                runtime = server.RequestHandlerClass.runtime
                annotated = runtime.ingestor.ingest("invoice.txt", b"Total due $80", "text/plain")["document"]
                unannotated = runtime.ingestor.ingest("empty.txt", b"Unannotated source", "text/plain")["document"]
                db = runtime.database
                dataset = db.insert_dataset("Manifest regression")
                for document in (annotated, unannotated):
                    db.add_document_to_dataset(dataset["id"], document["id"])
                db.save_ground_truth(annotated["id"], {"total": 75})
                expected = {"total": 0, "approved": False, "vendor": {"name": "Example"}, "missing": None}
                db.save_ground_truth(annotated["id"], expected)
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                try:
                    with urlopen("http://127.0.0.1:{}/v1/datasets/{}/manifest".format(server.server_address[1], dataset["id"])) as response:
                        manifest = json.load(response)["manifest"]
                    entries = {entry["document_id"]: entry for entry in manifest["documents"]}
                    self.assertEqual(entries[annotated["id"]]["ground_truth"], expected)
                    self.assertIsNone(entries[unannotated["id"]]["ground_truth"])
                    self.assertEqual(len(db.list_ground_truth_revisions(annotated["id"])), 2)
                finally:
                    server.shutdown()
                    server.server_close()
                    thread.join()
