"""HTTP transport and response decoding; no CLI, printing, or file writes."""

from dataclasses import dataclass
from http.client import HTTPException
import ipaddress
import json
import math
from typing import Optional
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


MAX_SERVER_MESSAGE = 300


class SearchError(Exception):
    """An invalid request, transport failure, or unusable server response."""


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def local_url(value):
    """Accept literal loopback addresses; normalize localhost to avoid DNS/proxies."""
    try:
        parts = urlsplit(value)
        host = parts.hostname
        if host == "localhost":
            host = "127.0.0.1"
        if (
            parts.scheme not in ("http", "https")
            or not host
            or not ipaddress.ip_address(host).is_loopback
            or parts.username is not None
            or parts.password is not None
            or parts.query
            or parts.fragment
        ):
            raise ValueError
        authority = f"[{host}]" if ":" in host else host
        if parts.port is not None:
            authority += f":{parts.port}"
        return urlunsplit((parts.scheme, authority, parts.path.rstrip("/"), "", ""))
    except ValueError as exc:
        raise SearchError(
            "URL must use http(s) and localhost or a literal loopback IP, without credentials, "
            "query, or fragment (default: http://127.0.0.1:8888)"
        ) from exc


def server_message(data: object) -> Optional[str]:
    """Return a bounded `error` message from a decoded SearXNG body, if it has one.

    The text is untrusted. It is truncated here; the CLI strips control characters when printing.
    """
    value = data.get("error") if isinstance(data, dict) else None
    if not value:
        return None
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    text = " ".join(text.split())
    if len(text) > MAX_SERVER_MESSAGE:
        text = text[:MAX_SERVER_MESSAGE] + "…"
    return text or None


def decode_json(payload: bytes) -> dict:
    try:
        data = json.loads(payload)
    except (ValueError, UnicodeError) as exc:
        raise SearchError(
            "response is not JSON; inspect the saved body and instance configuration"
        ) from exc
    if not isinstance(data, dict):
        raise SearchError("expected a JSON object; inspect the saved response")
    message = server_message(data)
    if message:
        raise SearchError(f"SearXNG error: {message}")
    return data


def validate_response(data: dict, kind: str) -> None:
    """Check the envelope before either raw output or a preview; retain all fields."""
    if kind not in ("search", "config"):
        raise ValueError("response kind must be search or config")
    primary = "results" if kind == "search" else "engines"
    items = data.get(primary)
    if not isinstance(items, list) or any(not isinstance(item, dict) for item in items):
        raise SearchError(f"expected a {kind} response with a {primary} array of objects")
    if kind == "search":
        for field in ("answers", "infoboxes", "corrections", "suggestions", "unresponsive_engines"):
            if data.get(field) is not None and not isinstance(data[field], list):
                raise SearchError(f"expected search response field {field} to be an array")
    else:
        for item in items:
            categories = item.get("categories", [])
            if (
                not isinstance(item.get("name"), str)
                or not isinstance(categories, list)
                or any(not isinstance(category, str) for category in categories)
            ):
                raise SearchError("expected config engines to have a name and category list")


@dataclass(frozen=True)
class Response:
    """Keep exact response bytes available even when status or JSON validation fails."""

    status: int
    body: bytes

    def json(self) -> dict:
        if 300 <= self.status < 400:
            raise SearchError(
                f"HTTP {self.status}: redirect refused; "
                "remove external !!bang syntax or check the base URL"
            )
        if self.status >= 400:
            hints = {
                400: "invalid query parameters",
                403: "JSON may be disabled in search.formats, or access may be denied",
                429: "rate limited; stop and wait before another search",
            }
            message = f"HTTP {self.status}: {hints.get(self.status, 'inspect the saved response')}"
            detail = self._server_detail()
            if detail:
                message += f"; server said: {detail}"
            raise SearchError(message)
        return decode_json(self.body)

    def _server_detail(self) -> Optional[str]:
        """Read SearXNG's JSON `error` field from an error body; ignore any other body."""
        try:
            return server_message(json.loads(self.body))
        except (ValueError, UnicodeError):
            return None


class SearXNGClient:
    """Send one request at a time to a loopback instance, without retries or redirects."""

    def __init__(self, url: str, http_timeout: float = 60):
        self.url = local_url(url)
        if not math.isfinite(http_timeout) or http_timeout <= 0:
            raise ValueError("http_timeout must be a finite number greater than zero")
        self.http_timeout = http_timeout
        # Local requests must not be routed through environment HTTP(S) proxies.
        self.opener = build_opener(ProxyHandler({}), NoRedirect())

    def request(
        self, endpoint: str, params: Optional[dict[str, str]] = None, *, method: str = "GET",
    ) -> Response:
        if endpoint not in ("/search", "/config"):
            raise ValueError("endpoint must be /search or /config")
        if method not in ("GET", "POST"):
            raise ValueError("method must be GET or POST")
        url = self.url + endpoint
        encoded = urlencode(params or {}).encode("utf-8")
        body = encoded if method == "POST" else None
        if encoded and method == "GET":
            url += "?" + encoded.decode("ascii")
        request = Request(url, data=body, headers={"Accept": "application/json"}, method=method)
        try:
            try:
                response = self.opener.open(request, timeout=self.http_timeout)
            except HTTPError as exc:
                response = exc
            with response:
                return Response(response.code, response.read())
        except (URLError, TimeoutError, OSError, HTTPException) as exc:
            raise SearchError(
                f"request failed: {exc}; check the local instance and port"
            ) from exc
