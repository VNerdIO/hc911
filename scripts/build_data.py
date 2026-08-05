#!/usr/bin/env python3
"""Builds the compact SPA dataset from the raw HC911 incident archive.

Pure function of data/raw/*.jsonl (no network access) - reads every archived
incident, de-duplicates by sequencenumber (this is the authoritative dedupe
pass; data/seen_index.json in collect.py is only a fast-path optimization),
and writes:

  docs/data/incidents.json - compact columnar dataset for the SPA
  docs/data/meta.json      - last-updated time, record count, date range

Safe to re-run at any time to regenerate the SPA dataset from the archive,
independent of collect.py.
"""

import json
import os
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = REPO_ROOT / "data" / "raw"
OUT_DIR = REPO_ROOT / "docs" / "data"

# Columnar field order for docs/data/incidents.json rows.
FIELDS = ["t", "lat", "lon", "ty", "jx", "ag", "ci", "zn", "pr"]

SCHEMA_VERSION = 1


def atomic_write_json(path, obj):
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(obj, f, separators=(",", ":"))
    os.replace(tmp_path, path)


def load_all_records():
    records = {}
    for archive_path in sorted(RAW_DIR.glob("*.jsonl")):
        with open(archive_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                record = json.loads(line)
                seq = record.get("sequencenumber")
                if not seq or seq in records:
                    continue
                records[seq] = record
    return list(records.values())


def to_row(record):
    creation_utc = datetime.fromisoformat(record["creation_utc"])
    epoch_ms = int(creation_utc.timestamp() * 1000)

    lat = record.get("latitude")
    lon = record.get("longitude")
    lat = round(lat, 5) if isinstance(lat, (int, float)) else None
    lon = round(lon, 5) if isinstance(lon, (int, float)) else None

    return [
        epoch_ms,
        lat,
        lon,
        record.get("type"),
        record.get("jurisdiction"),
        record.get("agency_type"),
        record.get("city"),
        record.get("zone"),
        record.get("priority"),
    ]


def main():
    records = load_all_records()
    rows = [to_row(r) for r in records]
    rows.sort(key=lambda row: row[0])

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    atomic_write_json(OUT_DIR / "incidents.json", {"fields": FIELDS, "rows": rows})

    now = datetime.now(timezone.utc)
    if rows:
        date_range_utc = [
            datetime.fromtimestamp(rows[0][0] / 1000, tz=timezone.utc).isoformat(),
            datetime.fromtimestamp(rows[-1][0] / 1000, tz=timezone.utc).isoformat(),
        ]
    else:
        date_range_utc = None

    meta = {
        "generated_at_utc": now.isoformat(),
        "record_count": len(rows),
        "date_range_utc": date_range_utc,
        "schema_version": SCHEMA_VERSION,
    }
    atomic_write_json(OUT_DIR / "meta.json", meta)

    print(f"BUILD_STATUS=success RECORDS={len(rows)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
