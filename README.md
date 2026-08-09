# HC911 Incident Analytics

An hourly-updated analytics dashboard for Hamilton County, TN 911 dispatch activity,
built from the public HC911 "active incidents" feed.

Live site: https://hc911.nooga.me

## Why hourly, and why a git-committed archive?

The upstream API (`https://hc911server.com/api/calls`) only returns **currently
active/open** incidents — there's no historical endpoint. To build up real history,
this project polls the feed every hour (the minimum interval a Claude cloud
scheduled routine supports) and permanently records every new incident it sees,
keyed by its `sequencenumber` so the same incident isn't recorded twice as its
status changes across polls.

Each hourly run is a fresh, stateless clone of this repo (no server, no database) —
so the git history itself is the durability layer: the collector commits and
pushes its findings back to `main` every run.

## Pipeline

```
scripts/collect.py     fetch API -> dedupe -> append to data/raw/YYYY-MM-DD.jsonl
scripts/build_data.py  data/raw/*.jsonl -> docs/data/incidents.json + meta.json
(hourly routine)        git add/commit/push, only if something changed
GitHub Pages            serves docs/ as the static SPA at hc911.nooga.me
```

- `data/raw/*.jsonl` — permanent, append-only, full-fidelity archive, one file per
  Eastern calendar date of each incident's `creation` timestamp.
- `data/seen_index.json` — fast-path dedupe index (`sequencenumber -> date first
  seen`), pruned after 4 days. Some very long-lived incidents (e.g. multi-day
  "ROAD CLOSURE" entries) can outlive that window and get re-appended as a
  duplicate raw line — harmless, because `build_data.py` does an authoritative
  dedupe by `sequencenumber` across the whole archive regardless.
- `docs/data/incidents.json` — compact columnar dataset consumed directly by the
  SPA (`{"fields": [...], "rows": [[...], ...]}`), so the browser does all
  filtering/aggregation client-side with no backend.

## Running locally

```
python scripts/collect.py      # fetch + append any new incidents
python scripts/build_data.py   # rebuild docs/data/*.json from the archive
cd docs && python -m http.server 8000   # then open http://localhost:8000
```

`collect.py` requires Python 3.9+ with the `zoneinfo` module able to resolve
`America/New_York`. Most Linux environments have this via system `tzdata`; on
Windows (and some minimal containers) you may need `pip install tzdata`.

Both `collect.py` and `tools/Get-HC911ActiveIncidents.ps1` send an
`X-Frontend-Auth` header to the upstream API. It's the same static value the
public hamiltontn911.gov site's own frontend sends, so it's not a real
per-user secret — but it's overridable via the `HC911_FRONTEND_AUTH`
environment variable rather than being hardcoded, in case upstream ever
rotates it.

## Other files

- `tools/Get-HC911ActiveIncidents.ps1` — a standalone PowerShell script for
  manually inspecting live active incidents. **Not** part of the automated
  pipeline above.
