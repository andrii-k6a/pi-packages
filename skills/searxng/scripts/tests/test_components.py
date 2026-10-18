"""Contracts for using the client, formatter, and storage outside the CLI."""

from contextlib import redirect_stderr, redirect_stdout
from copy import deepcopy
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SCRIPTS))

from searxng_cli.client import Response, SearchError, SearXNGClient, local_url
from searxng_cli.formatter import format_config, format_results
from searxng_cli.storage import check_output, save_response


class ClientTests(unittest.TestCase):
    def test_local_url_normalization(self):
        self.assertEqual(local_url("http://localhost:8888/base/"), "http://127.0.0.1:8888/base")
        self.assertEqual(local_url("http://[::1]:8888"), "http://[::1]:8888")

    def test_client_rejects_remote_addresses_without_cli_validation(self):
        with self.assertRaises(SearchError):
            SearXNGClient("https://example.com")

    def test_response_keeps_complete_body_and_returns_all_fields(self):
        data = {
            "results": [], "answers": [{"answer": "42"}], "infoboxes": [{"infobox": "box"}],
            "suggestions": ["related query"], "unresponsive_engines": [["engine", "timeout"]],
        }
        body = json.dumps(data).encode()
        response = Response(200, body)
        self.assertEqual(response.json(), data)
        self.assertEqual(response.body, body)

    def test_failed_response_can_be_saved_before_json_validation(self):
        for status, body in ((403, b"access denied"), (302, b"redirect"), (200, b"invalid JSON")):
            with self.subTest(status=status), tempfile.TemporaryDirectory() as directory:
                response = Response(status, body)
                path = save_response(response.body, Path(directory) / "response.json")
                with self.assertRaises(SearchError):
                    response.json()
                self.assertEqual(path.read_bytes(), body)


    def test_error_status_includes_the_servers_json_reason(self):
        response = Response(400, b'{"error": "Invalid value zz for parameter language"}')
        with self.assertRaises(SearchError) as caught:
            response.json()
        self.assertEqual(
            str(caught.exception),
            "HTTP 400: invalid query parameters; "
            "server said: Invalid value zz for parameter language",
        )
        with self.assertRaises(SearchError) as caught:
            Response(502, b"<html>bad gateway</html>").json()
        self.assertEqual(str(caught.exception), "HTTP 502: inspect the saved response")


class FormatterTests(unittest.TestCase):
    def test_formatting_is_repeatable_and_leaves_response_unchanged(self):
        data = {
            "results": [{"title": "Source", "url": "https://example.com", "engine": "first",
                         "engines": ["first", "second"], "content": "original content"}],
            "answers": [{"answer": "42"}],
        }
        original = deepcopy(data)
        stdout, stderr = io.StringIO(), io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            first = format_results(data)
            second = format_results(data)
        self.assertEqual(first, second)
        self.assertEqual(data, original)
        self.assertIn('engines: ["first", "second"]', first)
        self.assertEqual((stdout.getvalue(), stderr.getvalue()), ("", ""))

    def test_preview_reports_which_engines_contributed(self):
        data = {"results": [
            {"title": "a", "url": "https://a.example", "engines": ["bing news", "duckduckgo news"]},
            {"title": "b", "url": "https://b.example", "engines": ["bing news"]},
            {"title": "c", "url": "https://c.example", "engine": "yahoo"},
        ]}
        text = format_results(data, limit=1)  # counts cover hidden results too
        self.assertIn("engines contributing: bing news=2, duckduckgo news=1, yahoo=1", text)

    def test_empty_results_with_unresponsive_engines_say_not_to_retry_them(self):
        failed = {"results": [], "unresponsive_engines": [["brave", "Suspended: too many requests"]]}
        text = format_results(failed)
        self.assertIn("hint: no results while engines were unresponsive", text)
        self.assertNotIn("engines contributing", text)
        self.assertNotIn("\nhint:", format_results({"results": []}))
        found = {"results": [{"title": "a", "url": "https://a.example", "engine": "x"}],
                 "unresponsive_engines": [["brave", "CAPTCHA"]]}
        self.assertNotIn("\nhint:", format_results(found))

    def test_config_filter_does_not_remove_saved_engines(self):
        data = {"engines": [
            {"name": "science engine", "categories": ["science"]},
            {"name": "news engine", "categories": ["news"]},
        ]}
        original = deepcopy(data)
        text = format_config(data, category="science")
        self.assertIn("science engine", text)
        self.assertNotIn("news engine", text)
        self.assertEqual(data, original)


class StorageTests(unittest.TestCase):
    def test_save_never_overwrites_a_file_created_after_preflight(self):
        with tempfile.TemporaryDirectory() as directory:
            path = check_output(str(Path(directory) / "response.json"))
            path.write_bytes(b"keep this response")
            with self.assertRaises(FileExistsError):
                save_response(b"later response", path)
            self.assertEqual(path.read_bytes(), b"keep this response")

    def test_copied_helper_runs_from_an_unrelated_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            scripts = root / "skill" / "scripts"
            scripts.mkdir(parents=True)
            shutil.copy2(SCRIPTS / "searxng.py", scripts)
            shutil.copytree(SCRIPTS / "searxng_cli", scripts / "searxng_cli")
            response = root / "saved.json"
            response.write_text('{"results": [], "answers": [{"answer": "portable"}]}')
            result = subprocess.run(
                [sys.executable, "-B", "-E", str(scripts / "searxng.py"),
                 "preview", str(response), "--raw"],
                cwd=root, text=True, capture_output=True, timeout=10,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)["answers"], [{"answer": "portable"}])


if __name__ == "__main__":
    unittest.main()
