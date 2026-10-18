"""Argument parsing and command orchestration for the SearXNG skill."""

import argparse
import json
import math
import os
from pathlib import Path
import sys

from .client import SearchError, SearXNGClient, decode_json, local_url, validate_response
from .formatter import compact, format_config, format_results
from .storage import check_output, save_response


def url_argument(value):
    try:
        return local_url(value)
    except SearchError as exc:
        raise argparse.ArgumentTypeError(str(exc)) from exc


def positive_float(value):
    number = float(value)
    if not math.isfinite(number) or number <= 0:
        raise argparse.ArgumentTypeError("must be a finite number greater than zero")
    return number


def nonnegative_int(value):
    number = int(value)
    if number < 0:
        raise argparse.ArgumentTypeError("must be zero or greater")
    return number


def positive_int(value):
    number = nonnegative_int(value)
    if not number:
        raise argparse.ArgumentTypeError("must be greater than zero")
    return number


SEARCH_PARAMS = (
    "engines", "categories", "language", "pageno", "time_range", "safesearch",
    "timeout_limit", "enabled_engines", "disabled_engines", "enabled_plugins",
    "disabled_plugins",
)


def search_params(args):
    if not args.query.strip():
        raise SearchError("query must not be empty")
    params = {"q": args.query, "format": "json"}
    for name in SEARCH_PARAMS:
        value = getattr(args, name)
        if value is not None:
            params[name] = str(value)
    # Preferences.parse_dict only parses these pairs when disabled_* is present.
    for kind in ("engines", "plugins"):
        if f"enabled_{kind}" in params:
            params.setdefault(f"disabled_{kind}", "")
    for item in args.param:
        key, separator, value = item.partition("=")
        if not separator or not key:
            raise SearchError("--param requires NAME=VALUE")
        # Escape hatch for source-verified preferences and engine continuation data.
        # Keep typed arguments authoritative, including q, format, and paired options.
        if key in ("q", "format", *SEARCH_PARAMS):
            raise SearchError(
                f"--param cannot set {key}; use search arguments (format is always JSON)"
            )
        if key in params:
            raise SearchError(f"duplicate parameter: {key}")
        params[key] = value
    return params


def add_network_options(parser):
    parser.add_argument(
        "--url", type=url_argument, default=os.environ.get("SEARXNG_URL", "http://127.0.0.1:8888"),
        help="loopback base URL; defaults to SEARXNG_URL or http://127.0.0.1:8888",
    )
    parser.add_argument(
        "--http-timeout", type=positive_float, default=60,
        help="socket timeout in seconds (default: 60)",
    )
    parser.add_argument(
        "--output", help="new response file; default: unique file in the system temp directory",
    )
    parser.add_argument(
        "--raw", action="store_true", help="print complete JSON to stdout instead of a preview",
    )


def add_preview_options(parser):
    parser.add_argument(
        "--limit", type=nonnegative_int, default=8,
        help="detailed results; remaining titles/URLs still shown; 0 means all (default: 8)",
    )
    parser.add_argument(
        "--offset", type=nonnegative_int, default=0,
        help="skip this many saved results (default: 0)",
    )
    parser.add_argument(
        "--snippet-chars", type=nonnegative_int, default=500,
        help="snippet display length; 0 means full (default: 500)",
    )


def make_parser():
    parser = argparse.ArgumentParser(description="Search a loopback SearXNG instance.")
    commands = parser.add_subparsers(dest="command", required=True)
    search = commands.add_parser("search", help="make one JSON search and save the full response")
    search.add_argument(
        "query", help="quote the complete query; use -- before queries starting with a dash",
    )
    add_network_options(search)
    add_preview_options(search)
    search.add_argument("--method", choices=("GET", "POST"), default="GET")
    search.add_argument("--engines", help="comma-separated exact engine names from config")
    search.add_argument(
        "--categories", help="comma-separated categories; union with explicit engines",
    )
    search.add_argument("--language", help="search language/region, e.g. en, en-US, uk, all, auto")
    search.add_argument("--pageno", type=positive_int, help="upstream page number, starting at 1")
    search.add_argument("--time-range", choices=("day", "week", "month", "year"))
    search.add_argument(
        "--safesearch", type=int, choices=(0, 1, 2), help="0=off, 1=moderate, 2=strict",
    )
    search.add_argument(
        "--timeout-limit", type=positive_float,
        help="SearXNG engine deadline in seconds; distinct from --http-timeout",
    )
    for kind in ("engines", "plugins"):
        for state in ("enabled", "disabled"):
            search.add_argument(
                f"--{state}-{kind}",
                help=f"comma-separated {kind} preference IDs; see references/search-api.md",
            )
    search.add_argument(
        "--param", action="append", default=[], metavar="NAME=VALUE",
        help="additional source-verified API parameter; repeatable",
    )

    config = commands.add_parser(
        "config", help="save /config and inspect available engines and plugins",
    )
    add_network_options(config)
    config.add_argument("--category", help="filter engines by exact category")
    config.add_argument("--engine", help="filter engine names by substring")
    config.add_argument("--enabled-only", action="store_true")
    config.add_argument("--time-range-support", action="store_true")
    config.add_argument(
        "--details", action="store_true", help="also display engine language and region traits",
    )

    preview = commands.add_parser("preview", help="read saved search JSON without making a request")
    preview.add_argument("file", type=Path)
    add_preview_options(preview)
    preview.add_argument("--raw", action="store_true")
    return parser


def main(argv=None):
    args = make_parser().parse_args(argv)
    try:
        if args.command == "preview":
            data = decode_json(args.file.read_bytes())
        else:
            params = search_params(args) if args.command == "search" else None
            output = check_output(args.output)
            client = SearXNGClient(args.url, args.http_timeout)
            response = client.request(
                "/search" if args.command == "search" else "/config",
                params,
                method=getattr(args, "method", "GET"),
            )
            # Preserve error bodies too, before validating HTTP status or JSON.
            path = save_response(response.body, output)
            print(f"saved: {path}", file=sys.stderr)
            data = response.json()
        validate_response(data, "config" if args.command == "config" else "search")
        if args.raw:
            print(json.dumps(data, ensure_ascii=False, indent=2))
        elif args.command == "config":
            print(
                format_config(
                    data, category=args.category, engine=args.engine,
                    enabled_only=args.enabled_only, time_range_support=args.time_range_support,
                    details=args.details,
                )
            )
        else:
            print(
                format_results(
                    data, limit=args.limit, offset=args.offset, snippet_chars=args.snippet_chars,
                )
            )
    except (SearchError, OSError, ValueError) as exc:
        # Messages can quote untrusted server text; strip terminal control characters.
        print(f"error: {compact(str(exc))}", file=sys.stderr)
        return 1
    return 0
