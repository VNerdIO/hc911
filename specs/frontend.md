# Spec: Frontend SPA (docs/)

A static single-page application served by GitHub Pages from the `docs/`
directory. All filtering and aggregation is done client-side — there is no
backend.

---

## Data loading

On page init, the SPA fetches both data files concurrently with `cache: "no-store"`:

- `data/meta.json`
- `data/incidents.json`

The columnar `{"fields": [...], "rows": [[...]]}` format is expanded into an
array of objects keyed by field name. Field order is defined in `build_data.py`'s
`FIELDS` constant: `["t", "lat", "lon", "ty", "jx", "ag", "ci", "zn", "pr", "lt"]`.
`lt` is dispatch latency in whole seconds (time from `creation_utc` to
`entered_queue_utc`), or `null` if unavailable.

On load failure, the meta header displays `"Failed to load data."` and the rest
of the page does not render.

---

## Meta header

Displayed at the top of the page. Format:

```
Last updated <date> ET — <N> incidents recorded (<start> – <end>)
```

- Date is formatted in Eastern time (`America/New_York`), e.g. `Aug 7, 3:00 PM`.
- `<start>` and `<end>` are formatted as short Eastern dates, e.g. `Jul 28 – Aug 8`.
- If `meta.record_count` is 0 or `META` is null: display `"No data collected yet."`.
- `date_range_utc` section is omitted if `meta.date_range_utc` is null.

---

## Date range presets

Four preset buttons control the active time window. Default on load: **7d**.

| Preset | Range |
|---|---|
| `24h` | `[now - 1 day, now)` |
| `7d` | `[now - 7 days, now)` |
| `30d` | `[now - 30 days, now)` |
| `all` | `[first row's t, now)` |

"now" is `Date.now()` at the moment the preset is applied. The active preset
button has `aria-pressed="true"`; all others have `aria-pressed="false"`.

---

## Custom date range

Two date inputs (`range-start`, `range-end`) and an `apply-custom` button.
Dates are interpreted as **Eastern calendar-day boundaries**:

- Start = Eastern midnight at the start of `range-start` day (inclusive)
- End = Eastern midnight at the start of `range-end` day + 86,400,000 ms
  (i.e. end of the `range-end` day, exclusive)

Eastern midnight is computed DST-safely by anchoring to noon UTC on the same
Eastern calendar date and subtracting the Eastern time-of-day offset.

Clicking `apply-custom` with either field empty is a no-op. Applying a custom
range deactivates all preset buttons (`aria-pressed="false"` on all).

---

## Category filters

Three `<select>` dropdowns: **City** (`filter-ci`), **Agency** (`filter-ag`),
**Type** (`filter-ty`).

- Options are populated from the full `ROWS` dataset (not the current filtered
  view) on initial load, sorted alphabetically. Null/empty values are excluded.
- A filter with an empty string value (`""`) is inactive (matches all rows).
- Filters are ANDed: a row must match all active filters to be included.
- The **Clear filters** button resets all three dropdowns to `""` and re-renders.

---

## Filtered row set

Every render derives a filtered set from `ROWS` by applying:

1. Time range: `row.t >= start && row.t < end`
2. City filter: `row.ci === currentFilters.ci` (if non-empty)
3. Agency filter: `row.ag === currentFilters.ag` (if non-empty)
4. Type filter: `row.ty === currentFilters.ty` (if non-empty)

All subsequent components receive this filtered set.

---

## Stat tiles

Seven tiles, computed from the filtered set:

| Tile | Value | Subtitle |
|---|---|---|
| Total incidents | `filtered.length` formatted with locale commas | `"in selected range"` |
| Avg. incidents / day | `total / max(1, rangeDays)` to 1 decimal place | (empty) |
| Busiest hour | Top Eastern hour formatted as 12h (e.g. `3PM`) | `"N incidents"` |
| Busiest day/hour | Top `(weekday, hour)` pair from the day×hour matrix | `"N incidents"` |
| Busiest zone | Top `zn` value | `"N incidents"` |
| Most common type | Top `ty` value | `"N incidents"` |
| Median dispatch time | Median `lt` across rows with a non-null value, formatted (see below) | `"creation → queued"` |

Durations (`lt` and anything derived from it) are formatted by `formatDuration`:
`<60s` → `"Ns"`; `<60m` → `"Nm"` or `"Nm Ss"`; else `"Nh"` or `"Nh Mm"`. `null`/`NaN`
renders as `"–"`.

`rangeDays = (range[1] - range[0]) / 86,400,000`. Minimum value clamped to 1
to avoid division by zero. Hours use 24-hour values internally (0–23); the
`en-US` hour formatter may return `"24"` for midnight, which is normalized to
`0`.

If a tile has no data (empty filtered set), value shows `"–"` and subtitle is empty.

---

## Hour chart

Bar chart of incident counts by Eastern hour (0–23), always 24 bars.

- X-axis labels formatted as 12h (e.g. `12AM`, `1AM`, … `11PM`).
- Y-axis starts at zero, integer ticks.
- No legend.
- An accessible data table (`table-hour`) is rendered alongside, toggled by a
  "View as table" / "Hide table" button.

---

## Dispatch latency chart

Bar chart of **median** dispatch latency (`lt`, seconds) by Eastern hour, always
24 bars. Median (not mean) is used because `lt` is heavily right-skewed by a
small number of outlier incidents (long-lived/reopened calls), which would
otherwise dominate a mean.

- Rows with `lt` not a number are excluded from that hour's bucket.
- An hour with no valid `lt` values renders as `null` (Chart.js draws no bar).
- Y-axis ticks and tooltips are formatted with `formatDuration`, not raw seconds.
- An accessible data table (`table-latency`) is rendered alongside, toggled.

---

## Day chart

Line chart of incident counts per Eastern calendar day, covering every day in
the current range — including days with zero incidents.

- Days are enumerated by iterating from `range[0]` to `range[1]` in 86,400,000 ms
  steps and mapping each to an Eastern calendar date string.
- Duplicate date strings are collapsed (handles DST boundaries).
- X-axis labels: short Eastern dates (e.g. `Aug 7`).
- Y-axis starts at zero, integer ticks.
- Point radius: `3` when ≤ 60 days in range; `0` (hidden) when > 60 days.
- Fill below the line with 10% opacity of the series color.
- An accessible data table (`table-day`) is rendered alongside, toggled.

---

## Daily incidents by priority chart

Stacked bar chart (`chart-day-pr`), one bar per Eastern calendar day (same day
enumeration as the day chart, via the shared `enumerateEasternDays` helper),
segmented into datasets `["PRI 0", "PRI 1", "PRI 2", "PRI 3", "PRI 4", "Unknown"]`
(`PRIORITY_LABELS`). A row's segment is `r.pr || "Unknown"` (blank string `pr`
counts as `"Unknown"`, matching the priority breakdown chart).

- Both x and y scales are `stacked: true`.
- A top legend is shown (the only chart on the page with a visible legend),
  themed via `--text-muted`.
- Segment colors come from `priorityColor()`: `PRI 0`–`PRI 4` map to
  `--series-1` through `--series-5` in order; `Unknown` (or any unrecognized
  label) maps to `--other-gray`.
- The accessible data table (`table-day-pr`) has one column per priority label
  in addition to Date.

---

## Breakdown charts

Four horizontal bar charts showing top-10 values for each dimension:

| Chart ID | Field | Label |
|---|---|---|
| `chart-jx` | `jx` (jurisdiction) | Jurisdiction |
| `chart-ci` | `ci` (city) | City |
| `chart-ty` | `ty` (incident type) | Incident type |
| `chart-ag` | `ag` (agency type) | Agency type |

- Values with null/undefined are counted under `"Unknown"`.
- Sorted descending by count; top 10 shown.
- Each has a toggleable data table.

---

## Priority breakdown chart

Horizontal bar chart (`chart-pr`), like the breakdown charts above but **not**
sorted by count — it always shows all of `PRIORITY_LABELS` in fixed order
(`PRI 0` → `PRI 4`, then `Unknown`), including zero-count bars, so severity
order stays legible across filters. Bars are colored per `priorityColor()`,
matching the daily-by-priority chart's palette. Toggleable data table:
`table-pr`.

---

## Map

A Leaflet map rendered in `#map`.

**Initialization (once):**
- Tile layer: OpenStreetMap (`https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png`)
- Default center: `[35.045, -85.25]` (Hamilton County, TN), zoom `10`
- `scrollWheelZoom` disabled

**On each render:**
- The previous layer group is removed and replaced with a new one.
- Rows without numeric `lat`/`lon` are excluded from the map.
- Incidents are **clustered by coordinate rounded to 3 decimal places**
  (`lat.toFixed(3), lon.toFixed(3)`).

**Circle marker per cluster:**
- Radius: `5 + Math.sqrt(clusterCount) * 3` (px)
- Fill color: determined by dominant agency (see Agency colors below)
- Stroke color: `--surface-1` CSS variable, weight 2
- Fill opacity: `0.75`
- Popup: `"<N> incident(s)\n<top 3 types with counts>"`; HTML-escaped.

**Map legend:**
- Shows up to 8 agency types by descending count, each with a color swatch.

---

## Agency colors

Known agencies map to fixed series colors:

| Agency | CSS variable |
|---|---|
| `Law` | `--series-1` |
| `Fire` | `--series-2` |
| `EMS` | `--series-3` |
| `HC911` | `--series-4` |

Unknown agencies are assigned dynamically on first sight:
- First 4 unknown agencies get `--series-5` through `--series-8`.
- Any further unknown agencies get `--other-gray`.
- Assignments persist for the lifetime of the page (not reset on re-render).

---

## Theme

All colors are read from CSS custom properties at render time (not cached at
startup), so the charts and map respond to light/dark theme changes without a
page reload. Properties used: `--gridline`, `--text-muted`, `--surface-1`,
`--series-1` through `--series-8`, `--other-gray`.

---

## Initialization sequence

```
wireControls()
await loadData()          // concurrent fetch of meta.json + incidents.json
renderMeta()
populateFilterOptions()   // from full ROWS, not filtered
setActivePreset("7d")
applyRange(rangeForPreset("7d"))  // triggers full render
```
