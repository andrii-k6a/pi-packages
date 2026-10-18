"""Offline HTTP contract tests: python3 -B -m unittest discover -s scripts/tests -v."""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from urllib.parse import parse_qs, urlsplit


SCRIPT = Path(__file__).resolve().parents[1] / "searxng.py"


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        parts = urlsplit(self.path)
        self.respond(parts.path, parse_qs(parts.query, keep_blank_values=True))

    def do_POST(self):
        body = self.rfile.read(int(self.headers["Content-Length"])).decode("utf-8")
        self.respond(urlsplit(self.path).path, parse_qs(body, keep_blank_values=True))

    def respond(self, path, params):
        self.server.requests.append((self.command, path, params, self.headers))
        status, payload, headers = self.server.reply
        self.send_response(status)
        for key, value in headers.items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(payload)


class SearchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.output = Path(self.temp.name) / "response.json"
        self.server.requests = []
        self.respond_json({
            "query": "example", "results": [], "answers": [{"answer": "42"}],
            "infoboxes": [], "suggestions": ["next query"], "corrections": ["correction"],
            "unresponsive_engines": [["engine", "CAPTCHA", True]],
        })

    def respond_json(self, value):
        self.server.reply = (200, json.dumps(value, ensure_ascii=False).encode(), {
            "Content-Type": "application/json",
        })

    def cli(self, *args, env=None):
        return subprocess.run(
            [sys.executable, "-B", str(SCRIPT), *args],
            capture_output=True, text=True, timeout=10,
            env={**os.environ, "SEARXNG_URL": self.url, **(env or {})},
        )

    def search(self, *args, env=None):
        return self.cli("search", *args, "--output", str(self.output), env=env)

    def test_get_encoding_filters_and_complete_response(self):
        query = '!wp :uk "київ & C++" <850'
        result = self.search(
            query, "--engines", "google news,duckduckgo", "--categories", "news,science",
            "--time-range", "week", "--safesearch", "0", "--pageno", "2",
            "--language", "uk", "--timeout-limit", "2.5",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        method, path, params, _ = self.server.requests[0]
        self.assertEqual((method, path), ("GET", "/search"))
        self.assertEqual(params, {
            "q": [query], "format": ["json"], "engines": ["google news,duckduckgo"],
            "categories": ["news,science"], "time_range": ["week"], "safesearch": ["0"],
            "pageno": ["2"], "language": ["uk"], "timeout_limit": ["2.5"],
        })
        self.assertEqual(self.output.read_bytes(), self.server.reply[1])
        for text in ("42", "next query", "correction", "CAPTCHA"):
            self.assertIn(text, result.stdout)

    def test_post_pairs_preferences_and_preserves_extra_fields(self):
        result = self.search(
            "unicode café", "--method", "POST", "--enabled-plugins", "hash_plugin",
            "--disabled-plugins", "self_info", "--enabled-engines", "bing__general",
            "--param", "engine_data-example-token=a=b&c", "--param", "locale=en", "--raw",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        method, _, params, headers = self.server.requests[0]
        self.assertEqual(method, "POST")
        self.assertEqual(headers["Content-Type"], "application/x-www-form-urlencoded")
        self.assertEqual(params["disabled_engines"], [""])
        self.assertEqual(params["disabled_plugins"], ["self_info"])
        self.assertEqual(params["engine_data-example-token"], ["a=b&c"])
        self.assertEqual(json.loads(result.stdout), json.loads(self.output.read_bytes()))

    def test_enabling_plugin_sends_empty_disabled_pair(self):
        result = self.search("example", "--enabled-plugins", "hash_plugin")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.server.requests[0][2]["disabled_plugins"], [""])

    def test_invalid_inputs_make_no_requests(self):
        cases = [
            [" "], ["example", "--pageno", "0"], ["example", "--safesearch", "3"],
            ["example", "--time-range", "hour"], ["example", "--timeout-limit", "nan"],
            ["example", "--http-timeout", "-1"], ["example", "--limit", "-1"],
            ["example", "--param", "format=html"], ["example", "--param", "q=other"],
            ["example", "--param", "language=en"], ["example", "--param", "broken"],
            ["example", "--param", "locale=en", "--param", "locale=fr"],
        ]
        for args in cases:
            with self.subTest(args=args):
                result = self.search(*args)
                self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.server.requests, [])
        self.assertFalse(self.output.exists())

    def test_existing_output_is_not_overwritten_or_queried(self):
        self.output.write_text("keep me")
        result = self.search("example")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.output.read_text(), "keep me")
        self.assertEqual(self.server.requests, [])

    def test_remote_url_and_invalid_env_are_rejected(self):
        for url in (
            "https://example.com", "http://192.168.1.1:8888",
            "http://user@127.0.0.1", "file:///tmp/test",
        ):
            with self.subTest(url=url):
                result = self.search("example", env={"SEARXNG_URL": url})
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("loopback", result.stderr)
        self.assertEqual(self.server.requests, [])

    def test_redirect_is_saved_but_never_followed(self):
        self.server.reply = (302, b"redirect body", {"Location": self.url + "/destination"})
        result = self.search("!!example term")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("redirect refused", result.stderr)
        self.assertEqual(len(self.server.requests), 1)
        self.assertEqual(self.output.read_bytes(), b"redirect body")

    def test_http_error_saved_without_retry(self):
        for status in (400, 403, 429, 500):
            with self.subTest(status=status):
                self.server.reply = (status, b'{"error":"failure"}', {})
                result = self.search("example")
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(f"HTTP {status}", result.stderr)
                self.assertIn("server said: failure", result.stderr)
                self.assertEqual(self.output.read_bytes(), self.server.reply[1])
                self.output.unlink()
        self.assertEqual(len(self.server.requests), 4)

    def test_http_400_reports_the_servers_reason(self):
        body = b'{"error": "Invalid value zz!! for parameter language"}'
        self.server.reply = (400, body, {})
        result = self.search("example", "--language", "zz!!")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("HTTP 400: invalid query parameters", result.stderr)
        self.assertIn("server said: Invalid value zz!! for parameter language", result.stderr)
        self.assertEqual(self.output.read_bytes(), body)

    def test_error_bodies_without_a_json_reason_add_no_detail_or_traceback(self):
        for body in (b"<html>Too Many Requests</html>", b"[1, 2]", b'{"error": ""}',
                     b'{"error": null}', b"\xff\xfe not utf-8"):
            with self.subTest(body=body):
                self.server.reply = (500, body, {})
                result = self.search("example")
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("HTTP 500", result.stderr)
                self.assertNotIn("server said", result.stderr)
                self.assertNotIn("Traceback", result.stderr)
                self.assertEqual(self.output.read_bytes(), body)
                self.output.unlink()

    def test_server_error_text_is_bounded_and_stripped_of_control_characters(self):
        for status in (400, 200):
            with self.subTest(status=status):
                message = "bad \x1b[31mred\x1b]0;title\x07 \u009b2J \u202e" + "x" * 1000
                self.server.reply = (status, json.dumps({"error": message}).encode(), {})
                result = self.search("example")
                self.assertNotEqual(result.returncode, 0)
                for char in ("\x1b", "\x07", "\u009b", "\u202e"):
                    self.assertNotIn(char, result.stderr)
                self.assertIn("bad", result.stderr)
                self.assertLess(len(result.stderr), 700)
                self.assertTrue(result.stderr.rstrip().endswith("…"))
                self.output.unlink()

    def test_malformed_json_preserved(self):
        self.server.reply = (200, b"<html>unexpected</html>", {})
        result = self.search("example")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("not JSON", result.stderr)
        self.assertEqual(self.output.read_bytes(), self.server.reply[1])

    def test_unrelated_or_malformed_search_json_is_rejected_in_both_modes(self):
        for payload in ({}, {"engines": []}, {"results": None}, {"results": [None]},
                        {"results": [], "answers": 42}):
            for flags in ([], ["--raw"]):
                with self.subTest(payload=payload, flags=flags):
                    self.output.unlink(missing_ok=True)
                    self.respond_json(payload)
                    result = self.search("example", *flags)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertEqual(result.stdout, "")
                    self.assertNotIn("Traceback", result.stderr)
                    self.assertEqual(json.loads(self.output.read_bytes()), payload)
                    self.output.unlink()

    def test_malformed_config_is_reported_without_traceback(self):
        for payload in ({}, {"engines": [None]}, {"engines": [{"categories": None}]},
                        {"engines": [{"name": None}]}):
            with self.subTest(payload=payload):
                self.output.unlink(missing_ok=True)
                self.respond_json(payload)
                result = self.cli("config", "--category", "general", "--engine", "example",
                                  "--output", str(self.output))
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn("Traceback", result.stderr)
                self.assertEqual(self.output.read_bytes(), self.server.reply[1])
                self.output.unlink()

    def test_preview_rejects_config_as_search_results_without_network(self):
        self.output.write_text('{"engines": []}')
        result = self.cli("preview", str(self.output))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("search response", result.stderr)
        self.assertEqual(self.server.requests, [])

    def test_truncated_response_fails_without_retry_or_traceback(self):
        self.server.reply = (200, b'{"results":', {"Content-Length": "100"})
        result = self.search("example")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("request failed", result.stderr)
        self.assertNotIn("Traceback", result.stderr)
        self.assertEqual(len(self.server.requests), 1)

    def test_preview_reads_saved_results_offline(self):
        self.output.write_text(json.dumps({
            "results": [{"title": f"result {i}", "url": f"https://example.com/{i}",
                         "content": "a long snippet"} for i in range(10)],
            "answers": ["legacy answer"], "infoboxes": [{"infobox": "box"}],
        }))
        result = self.cli(
            "preview", str(self.output), "--offset", "8", "--limit", "0", "--snippet-chars", "0",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("9. result 8", result.stdout)
        self.assertIn("10. result 9", result.stdout)
        self.assertNotIn("1. result 0", result.stdout)
        self.assertIn("a long snippet", result.stdout)
        self.assertIn("legacy answer", result.stdout)
        self.assertIn("box", result.stdout)
        self.assertEqual(self.server.requests, [])

    def test_config_filters_output_but_saves_all_capabilities(self):
        config = {"version": "test", "engines": [
            {"name": "first", "shortcut": "f", "enabled": True, "categories": ["science"],
             "time_range_support": True, "languages": ["en"], "regions": ["US"]},
            {"name": "second", "enabled": True, "categories": ["general"]},
        ]}
        self.respond_json(config)
        result = self.cli(
            "config", "--category", "science", "--time-range-support",
            "--details", "--output", str(self.output),
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("first | !f", result.stdout)
        self.assertNotIn("second", result.stdout)
        self.assertIn('regions: ["US"]', result.stdout)
        self.assertEqual(json.loads(self.output.read_bytes()), config)
        self.assertEqual(self.server.requests[0][1], "/config")

    def test_preview_keeps_later_source_links_visible(self):
        self.output.write_text(json.dumps({"results": [
            {"title": "First", "url": "https://example.com/first", "content": "first snippet"},
            {"title": "Original source", "url": "https://example.com/original",
             "content": "longer original evidence"},
        ]}))
        result = self.cli("preview", str(self.output), "--limit", "1")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("first snippet", result.stdout)
        self.assertIn("Original source | https://example.com/original", result.stdout)
        self.assertNotIn("longer original evidence", result.stdout)
        self.assertEqual(self.server.requests, [])

    def test_environment_proxies_are_not_used(self):
        result = self.search("example", env={
            "http_proxy": "http://127.0.0.1:1", "HTTP_PROXY": "http://127.0.0.1:1",
            "all_proxy": "http://127.0.0.1:1", "NO_PROXY": "", "no_proxy": "",
        })
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.server.requests), 1)

    def test_default_output_uses_unique_files(self):
        paths = []
        try:
            for _ in range(2):
                result = self.cli("search", "example")
                self.assertEqual(result.returncode, 0, result.stderr)
                path = Path(result.stderr.strip().removeprefix("saved: "))
                paths.append(path)
                self.assertEqual(path.read_bytes(), self.server.reply[1])
            self.assertNotEqual(paths[0], paths[1])
        finally:
            for path in paths:
                path.unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
