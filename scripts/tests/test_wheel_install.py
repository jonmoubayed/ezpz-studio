"""Startup checks distinguish slow imports, crashes, and hung launchers."""

import importlib.util
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("wheel_install", Path(__file__).parents[1] / "test-install.py")
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class StartupTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.log = (self.root / "startup.log").open("w+")
        self.process = Mock()
        self.process.poll.return_value = None
        self.addCleanup(self.directory.cleanup)
        self.addCleanup(self.log.close)
        self.spawn = patch.object(installer.subprocess, "Popen", return_value=self.process)
        self.spawn.start()
        self.addCleanup(self.spawn.stop)

    def test_cold_start_can_take_more_than_fifteen_seconds(self):
        def ready(_):
            self.log.write("ezpz Studio is ready at http://127.0.0.1:12345/\n")
        with patch.object(installer.time, "monotonic", side_effect=[0, 0, 20]), patch.object(installer.time, "sleep", side_effect=ready):
            process, url = installer.start_studio("ezpz", self.root, {}, self.log)
        self.assertIs(process, self.process)
        self.assertEqual(url, "http://127.0.0.1:12345")
        process.terminate.assert_not_called()

    def test_crash_reports_exit_status_and_import_error(self):
        self.log.write("ImportError: synthetic dependency failure\n")
        self.process.poll.return_value = 1
        with self.assertRaisesRegex(AssertionError, "(?s)status 1.*synthetic dependency failure"):
            installer.start_studio("ezpz", self.root, {}, self.log)
        self.process.terminate.assert_not_called()

    def test_timeout_reports_progress_and_reaps_child(self):
        self.log.write("import time: synthetic_slow_module\n")
        with patch.object(installer.time, "monotonic", side_effect=[0, 121]), self.assertRaisesRegex(AssertionError, "(?s)within 120s.*synthetic_slow_module"):
            installer.start_studio("ezpz", self.root, {}, self.log)
        self.process.terminate.assert_called_once()
        self.process.wait.assert_called_once_with(timeout=15)

    def test_unresponsive_child_is_killed_after_termination_timeout(self):
        self.process.wait.side_effect = [subprocess.TimeoutExpired("ezpz", 15), None]
        with patch.object(installer.time, "monotonic", side_effect=[0, 121]), self.assertRaises(AssertionError):
            installer.start_studio("ezpz", self.root, {}, self.log)
        self.process.kill.assert_called_once()
        self.assertEqual(self.process.wait.call_count, 2)
