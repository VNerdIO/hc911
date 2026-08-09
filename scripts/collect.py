#!/usr/bin/env python3
"""Hourly collector for the HC911 (Hamilton County, TN) active-incidents API.

Fetches currently-active incidents, filters out PERBURN entries, and appends
any incident not already recorded to a per-day JSONL archive under
data/raw/. Dedup state lives in data/seen_index.json.

On any fetch/parse failure, nothing under data/ is touched. Prints a single
COLLECT_STATUS= line and sets the process exit code accordingly, so a caller
(e.g. an unattended scheduled job) can decide whether it is safe to commit
and push the result.
"""

import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

API_URL = "https://hc911server.com/api/calls"
API_HEADERS = {
    "Content-Type": "application/json",
    "X-Frontend-Auth": os.environ.get("HC911_FRONTEND_AUTH", "my-secure-token"),
    "Origin": "https://www.hamiltontn911.gov",
}
TIMEOUT_SEC = 20
MAX_RETRIES = 2

try:
    EASTERN = ZoneInfo("America/New_York")
except ZoneInfoNotFoundError as exc:
    raise SystemExit(
        "No IANA time zone database found on this system. "
        "Run 'pip install tzdata' (needed on Windows/minimal containers "
        "that don't ship a system tz database) and try again."
    ) from exc
UTC = timezone.utc

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = REPO_ROOT / "data"
RAW_DIR = DATA_DIR / "raw"
SEEN_INDEX_PATH = DATA_DIR / "seen_index.json"

SEEN_INDEX_PRUNE_DAYS = 4


def fetch_incidents():
    """Fetch the current active-incidents list. Raises on any failure."""
    req = urllib.request.Request(API_URL, headers=API_HEADERS, method="GET")
    last_error = None
    for attempt in range(MAX_RETRIES + 1):
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT_SEC) as resp:
                body = resp.read()
            data = json.loads(body)
            if not isinstance(data, list):
                raise ValueError(f"expected a JSON array, got {type(data).__name__}")
            return data
        except (urllib.error.URLError, TimeoutError, ValueError, json.JSONDecodeError) as exc:
            last_error = exc
            continue
    raise last_error


def parse_creation_utc(creation_str):
    """Parse the API's 'creation' field (e.g. '2026-08-05T17:11:58.000Z') as UTC."""
    dt = datetime.strptime(creation_str, "%Y-%m-%dT%H:%M:%S.%fZ")
    return dt.replace(tzinfo=UTC)


def load_seen_index():
    if not SEEN_INDEX_PATH.exists():
        return {}
    with open(SEEN_INDEX_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def atomic_write_json(path, obj):
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(obj, f, separators=(",", ":"))
    os.replace(tmp_path, path)


def prune_seen_index(seen_index, today_eastern_date):
    cutoff = today_eastern_date - timedelta(days=SEEN_INDEX_PRUNE_DAYS)
    pruned = {}
    for seq, date_str in seen_index.items():
        try:
            seen_date = datetime.strptime(date_str, "%Y-%m-%d").date()
        except ValueError:
            continue
        if seen_date >= cutoff:
            pruned[seq] = date_str
    return pruned


def build_record(item, collected_at_utc):
    creation_utc = parse_creation_utc(item["creation"])
    creation_eastern = creation_utc.astimezone(EASTERN)

    entered_queue_utc = None
    if item.get("entered_queue"):
        try:
            entered_queue_utc = parse_creation_utc(item["entered_queue"]).isoformat()
        except ValueError:
            entered_queue_utc = None

    return {
        "sequencenumber": item.get("sequencenumber"),
        "master_incident_id": item.get("master_incident_id"),
        "type": item.get("type"),
        "agency_type": item.get("agency_type"),
        "priority": item.get("priority"),
        "status_first_seen": item.get("status"),
        "zone": item.get("zone"),
        "battalion": item.get("battalion"),
        "jurisdiction": item.get("jurisdiction"),
        "location": item.get("location"),
        "crossstreets": item.get("crossstreets"),
        "city": item.get("city"),
        "state": item.get("state"),
        "premise": item.get("premise"),
        "latitude": item.get("latitude"),
        "longitude": item.get("longitude"),
        "creation_utc": creation_utc.isoformat(),
        "creation_eastern_date": creation_eastern.strftime("%Y-%m-%d"),
        "entered_queue_utc": entered_queue_utc,
        "collected_at_utc": collected_at_utc.isoformat(),
    }, creation_eastern.date()


def main():
    collected_at_utc = datetime.now(UTC)
    today_eastern_date = collected_at_utc.astimezone(EASTERN).date()

    try:
        items = fetch_incidents()
    except Exception as exc:  # noqa: BLE001 - report any failure, touch nothing
        print(f"COLLECT_STATUS=failure REASON={exc!r}")
        return 1

    seen_index = load_seen_index()

    new_records_by_date = {}
    new_count = 0

    for item in items:
        if item.get("type") == "PERBURN":
            continue
        seq = item.get("sequencenumber")
        if not seq or seq in seen_index:
            continue
        try:
            record, event_date = build_record(item, collected_at_utc)
        except Exception as exc:  # noqa: BLE001 - skip malformed records, don't fail the run
            print(f"WARN: skipping incident sequence={seq!r}: {exc!r}", file=sys.stderr)
            continue

        date_str = event_date.strftime("%Y-%m-%d")
        new_records_by_date.setdefault(date_str, []).append(record)
        seen_index[seq] = date_str
        new_count += 1

    RAW_DIR.mkdir(parents=True, exist_ok=True)
    for date_str, records in new_records_by_date.items():
        archive_path = RAW_DIR / f"{date_str}.jsonl"
        with open(archive_path, "a", encoding="utf-8") as f:
            for record in records:
                f.write(json.dumps(record, separators=(",", ":")))
                f.write("\n")

    seen_index = prune_seen_index(seen_index, today_eastern_date)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    atomic_write_json(SEEN_INDEX_PATH, seen_index)

    print(f"COLLECT_STATUS=success FETCHED={len(items)} NEW={new_count}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
