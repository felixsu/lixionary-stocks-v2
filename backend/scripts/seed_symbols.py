#!/usr/bin/env python3
"""Bulk-subscribe symbols via the API.

    python scripts/seed_symbols.py BBCA BBRI TLKM ASII
    python scripts/seed_symbols.py --file watchlist.txt

Each symbol is validated upstream and backfilled in the background. Already
subscribed symbols are reported and skipped, so re-running is safe.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request

DEFAULT_API = "http://localhost:8850"


def add_symbol(api: str, symbol: str) -> tuple[str, str]:
    req = urllib.request.Request(
        f"{api}/api/symbols",
        data=json.dumps({"symbol": symbol}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req) as resp:
            body = json.load(resp)
            return ("added", body.get("name") or "")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode()[:120]
        if exc.code == 409:
            return ("exists", "")
        return (f"error {exc.code}", detail)
    except Exception as exc:  # noqa: BLE001
        return ("error", str(exc)[:120])


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("symbols", nargs="*", help="e.g. BBCA BBRI ^JKSE")
    parser.add_argument("--file", help="file with one symbol per line (# comments ok)")
    parser.add_argument("--api", default=DEFAULT_API)
    args = parser.parse_args()

    symbols = list(args.symbols)
    if args.file:
        with open(args.file) as fh:
            for line in fh:
                line = line.split("#")[0].strip()
                if line:
                    symbols.append(line)

    if not symbols:
        parser.error("no symbols given")

    added = skipped = failed = 0
    for sym in symbols:
        status, detail = add_symbol(args.api, sym.strip().upper())
        print(f"{sym.strip().upper():<10} {status:<10} {detail}")
        if status == "added":
            added += 1
        elif status == "exists":
            skipped += 1
        else:
            failed += 1

    print(f"\nadded={added} already_subscribed={skipped} failed={failed}")
    print("Backfills run in the background; watch /api/system/runs.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
