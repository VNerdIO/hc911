# Spec: build_data.py

Builds the compact SPA dataset from the raw incident archive. Pure function of
`data/raw/*.jsonl` — no network access. Safe to re-run at any time.

---

## Inputs

- All files matching `data/raw/*.jsonl`, processed in **filename sort order**
  (which is chronological order since filenames are `YYYY-MM-DD.jsonl`).
- Within each file, lines are read top-to-bottom.

---

## Deduplication

- **Authoritative dedupe by `sequencenumber` across the entire archive.**
- The first occurrence of a given `sequencenumber` (by file sort order, then
  line order within a file) is kept; all later occurrences are silently dropped.
- Blank lines within a JSONL file are skipped.
- This pass is independent of `data/seen_index.json`, which is only a
  fast-path optimization in `collect.py`.

---

## Output: `docs/data/incidents.json`

Compact columnar format consumed directly by the SPA. No pretty-printing.

```json
{
  "fields": ["t", "lat", "lon", "ty", "jx", "ag", "ci", "zn", "pr", "lt"],
  "rows": [
    [<t>, <lat>, <lon>, <ty>, <jx>, <ag>, <ci>, <zn>, <pr>, <lt>],
    ...
  ]
}
```

### Field mapping

| Column | Key | Source field | Type | Notes |
|---|---|---|---|---|
| 0 | `t` | `creation_utc` | integer | Unix epoch milliseconds |
| 1 | `lat` | `latitude` | float or null | Rounded to 5 decimal places; null if not a number |
| 2 | `lon` | `longitude` | float or null | Rounded to 5 decimal places; null if not a number |
| 3 | `ty` | `type` | string or null | |
| 4 | `jx` | `jurisdiction` | string or null | |
| 5 | `ag` | `agency_type` | string or null | |
| 6 | `ci` | `city` | string or null | |
| 7 | `zn` | `zone` | string or null | |
| 8 | `pr` | `priority` | string or null | |
| 9 | `lt` | `entered_queue_utc` − `creation_utc` | integer or null | Dispatch latency in whole seconds. Null if `entered_queue_utc` is missing or the computed difference is negative (bad data guard). |

### Row ordering

Rows are sorted **ascending by `t`** (creation timestamp, epoch ms).

---

## Output: `docs/data/meta.json`

```json
{
  "generated_at_utc": "<ISO 8601 timestamp of when build ran>",
  "record_count": <integer>,
  "date_range_utc": ["<ISO 8601 of first row>", "<ISO 8601 of last row>"],
  "schema_version": 1
}
```

- `date_range_utc` is derived from the first and last row's `t` value after
  sorting, converted back to ISO 8601 UTC strings.
- `date_range_utc` is `null` (not an empty array) when there are no records.
- `schema_version` is currently `2`. Increment this when the `fields` order or
  set changes in a way that would break existing SPA clients.

---

## Write behavior

Both output files are written **atomically**: content is written to a `.tmp`
sibling, then `os.replace()` swaps it into place. Partial writes are never
visible to readers.

The `docs/data/` directory is created if it does not exist.

---

## Status output

```
BUILD_STATUS=success RECORDS=<n>
```

Printed to stdout on completion. Exit code is `0` on success.

---

## Constraints

- **No network access.** The script reads only from `data/raw/` and writes only
  to `docs/data/`.
- **Idempotent.** Running twice on the same `data/raw/` contents produces
  byte-for-byte identical output files (modulo `generated_at_utc` in
  `meta.json`, which reflects wall-clock time).
- **Re-runnable at any time** without risk of data loss or corruption.
