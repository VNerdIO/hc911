(() => {
  "use strict";

  const EASTERN_TZ = "America/New_York";

  const hourFmt = new Intl.DateTimeFormat("en-US", { timeZone: EASTERN_TZ, hour: "numeric", hour12: false });
  const dateFmt = new Intl.DateTimeFormat("en-CA", { timeZone: EASTERN_TZ, year: "numeric", month: "2-digit", day: "2-digit" });
  const displayDateFmt = new Intl.DateTimeFormat("en-US", { timeZone: EASTERN_TZ, month: "short", day: "numeric" });
  const displayDateTimeFmt = new Intl.DateTimeFormat("en-US", { timeZone: EASTERN_TZ, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

  function easternHour(ms) {
    // en-US 24h formatter returns "24" for midnight; normalize to 0.
    const h = parseInt(hourFmt.format(new Date(ms)), 10);
    return h === 24 ? 0 : h;
  }
  function easternDateKey(ms) {
    return dateFmt.format(new Date(ms)); // YYYY-MM-DD
  }

  const weekdayFmt = new Intl.DateTimeFormat("en-US", { timeZone: EASTERN_TZ, weekday: "short" });
  const DAY_ORDER = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  function easternWeekdayIndex(ms) {
    return DAY_ORDER.indexOf(weekdayFmt.format(new Date(ms)));
  }

  let ROWS = []; // {t,lat,lon,ty,jx,ag,ci,zn,pr}
  let META = null;
  let currentRange = null; // [startMs, endMsExclusive]
  let currentFilters = { ci: "", ag: "", ty: "" };
  let charts = {};
  let map = null;
  let mapLayer = null;

  async function loadData() {
    const [metaRes, dataRes] = await Promise.all([
      fetch("data/meta.json", { cache: "no-store" }),
      fetch("data/incidents.json", { cache: "no-store" }),
    ]);
    META = await metaRes.json();
    const raw = await dataRes.json();
    const { fields, rows } = raw;
    ROWS = rows.map((r) => {
      const o = {};
      fields.forEach((f, i) => { o[f] = r[i]; });
      return o;
    });
  }

  function renderMeta() {
    const el = document.getElementById("meta-updated");
    if (!META || !META.record_count) {
      el.textContent = "No data collected yet.";
      return;
    }
    const updated = displayDateTimeFmt.format(new Date(META.generated_at_utc));
    let text = `Last updated ${updated} ET — ${META.record_count.toLocaleString()} incidents recorded`;
    if (META.date_range_utc) {
      const start = displayDateFmt.format(new Date(META.date_range_utc[0]));
      const end = displayDateFmt.format(new Date(META.date_range_utc[1]));
      text += ` (${start} – ${end})`;
    }
    el.textContent = text;
  }

  // ---------------- Date range handling ----------------

  function setActivePreset(name) {
    document.querySelectorAll(".preset-btn").forEach((btn) => {
      btn.setAttribute("aria-pressed", String(btn.dataset.preset === name));
    });
  }

  function rangeForPreset(name) {
    const now = Date.now();
    if (name === "all") {
      const start = ROWS.length ? ROWS[0].t : now;
      return [start, now + 1];
    }
    const days = { "24h": 1, "7d": 7, "30d": 30 }[name];
    return [now - days * 86400000, now + 1];
  }

  function rangeForCustom(startStr, endStr) {
    // Interpret the date inputs as Eastern calendar-day boundaries.
    const startMs = easternMidnightUtcMs(startStr);
    const endMs = easternMidnightUtcMs(endStr) + 86400000; // exclusive end of the "to" day
    return [startMs, endMs];
  }

  const easternTimeOfDayFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: EASTERN_TZ, hour12: false, hour: "numeric", minute: "2-digit", second: "2-digit",
  });

  function easternMidnightUtcMs(dateStr) {
    // dateStr = "YYYY-MM-DD" interpreted as an Eastern calendar date.
    // Noon UTC always falls on the same Eastern calendar date (ET offset is
    // only 4-5h), so we anchor there and subtract the Eastern time-of-day to
    // land exactly on that day's Eastern midnight - DST-safe, no iteration.
    const [y, m, d] = dateStr.split("-").map(Number);
    const noonUtc = Date.UTC(y, m - 1, d, 12, 0, 0);
    const parts = easternTimeOfDayFmt.formatToParts(new Date(noonUtc));
    const get = (t) => parseInt(parts.find((p) => p.type === t).value, 10);
    let hour = get("hour");
    if (hour === 24) hour = 0;
    const msSinceMidnight = hour * 3600000 + get("minute") * 60000 + get("second") * 1000;
    return noonUtc - msSinceMidnight;
  }

  function applyRange(range) {
    currentRange = range;
    render();
  }

  function filteredRows() {
    const [start, end] = currentRange;
    return ROWS.filter((r) => {
      if (r.t < start || r.t >= end) return false;
      if (currentFilters.ci && r.ci !== currentFilters.ci) return false;
      if (currentFilters.ag && r.ag !== currentFilters.ag) return false;
      if (currentFilters.ty && r.ty !== currentFilters.ty) return false;
      return true;
    });
  }

  function render() {
    const filtered = filteredRows();
    renderStatTiles(filtered, currentRange);
    renderHourChart(filtered);
    renderDayChart(filtered, currentRange);
    renderHeatmap(filtered);
    renderBreakdown("jx", filtered, "Jurisdiction");
    renderBreakdown("ci", filtered, "City");
    renderBreakdown("ty", filtered, "Incident type");
    renderBreakdown("ag", filtered, "Agency type");
    renderMap(filtered);
  }

  // ---------------- Category filters ----------------

  function uniqueSorted(rows, field) {
    return [...new Set(rows.map((r) => r[field]).filter((v) => v))].sort((a, b) => a.localeCompare(b));
  }

  function populateFilterOptions() {
    const fieldToSelect = { ci: "filter-ci", ag: "filter-ag", ty: "filter-ty" };
    for (const [field, selectId] of Object.entries(fieldToSelect)) {
      const select = document.getElementById(selectId);
      for (const value of uniqueSorted(ROWS, field)) {
        const opt = document.createElement("option");
        opt.value = value;
        opt.textContent = value;
        select.appendChild(opt);
      }
    }
  }

  // ---------------- Aggregation ----------------

  function countBy(rows, keyFn) {
    const map = new Map();
    for (const r of rows) {
      const k = keyFn(r) ?? "Unknown";
      map.set(k, (map.get(k) || 0) + 1);
    }
    return map;
  }

  function topN(map, n) {
    return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
  }

  function dayHourMatrix(rows) {
    const counts = Array.from({ length: 7 }, () => new Array(24).fill(0));
    for (const r of rows) counts[easternWeekdayIndex(r.t)][easternHour(r.t)]++;
    let max = 0;
    for (const row of counts) for (const c of row) if (c > max) max = c;
    return { counts, max };
  }

  // ---------------- Stat tiles ----------------

  function renderStatTiles(rows, range) {
    const el = document.getElementById("stat-tiles");
    el.innerHTML = "";

    const total = rows.length;
    const hourCounts = countBy(rows, (r) => easternHour(r.t));
    const busiestHour = topN(hourCounts, 1)[0];
    const zoneCounts = countBy(rows, (r) => r.zn);
    const busiestZone = topN(zoneCounts, 1)[0];
    const typeCounts = countBy(rows, (r) => r.ty);
    const topType = topN(typeCounts, 1)[0];

    const { counts: dayHourCounts } = dayHourMatrix(rows);
    let busiestDayHour = null;
    for (let d = 0; d < 7; d++) {
      for (let h = 0; h < 24; h++) {
        const c = dayHourCounts[d][h];
        if (!busiestDayHour || c > busiestDayHour.count) busiestDayHour = { d, h, count: c };
      }
    }
    if (busiestDayHour && busiestDayHour.count === 0) busiestDayHour = null;

    const days = Math.max(1, (range[1] - range[0]) / 86400000);
    const avgPerDay = total / days;

    const tiles = [
      { label: "Total incidents", value: total.toLocaleString(), sub: "in selected range" },
      { label: "Avg. incidents / day", value: avgPerDay.toFixed(1), sub: "" },
      { label: "Busiest hour", value: busiestHour ? formatHourLabel(busiestHour[0]) : "–", sub: busiestHour ? `${busiestHour[1]} incidents` : "" },
      { label: "Busiest day/hour", value: busiestDayHour ? `${DAY_ORDER[busiestDayHour.d]} ${formatHourLabel(busiestDayHour.h)}` : "–", sub: busiestDayHour ? `${busiestDayHour.count} incidents` : "" },
      { label: "Busiest zone", value: busiestZone ? busiestZone[0] : "–", sub: busiestZone ? `${busiestZone[1]} incidents` : "" },
      { label: "Most common type", value: topType ? topType[0] : "–", sub: topType ? `${topType[1]} incidents` : "" },
    ];

    for (const t of tiles) {
      const div = document.createElement("div");
      div.className = "stat-tile";
      const label = document.createElement("div");
      label.className = "stat-label";
      label.textContent = t.label;
      const value = document.createElement("div");
      value.className = "stat-value";
      value.textContent = t.value;
      const sub = document.createElement("div");
      sub.className = "stat-sub";
      sub.textContent = t.sub;
      div.append(label, value, sub);
      el.appendChild(div);
    }
  }

  function formatHourLabel(h) {
    const period = h < 12 ? "AM" : "PM";
    let hour12 = h % 12;
    if (hour12 === 0) hour12 = 12;
    return `${hour12}${period}`;
  }

  // ---------------- Charts ----------------

  function baseGridColor() {
    return getComputedStyle(document.body).getPropertyValue("--gridline").trim();
  }
  function textMutedColor() {
    return getComputedStyle(document.body).getPropertyValue("--text-muted").trim();
  }
  function seriesColor(i) {
    return getComputedStyle(document.body).getPropertyValue(`--series-${i}`).trim();
  }
  function surfaceColor() {
    return getComputedStyle(document.body).getPropertyValue("--surface-1").trim();
  }
  function seqColor(step) {
    return getComputedStyle(document.body).getPropertyValue(`--seq-${step}`).trim();
  }

  function hexToRgb(hex) {
    const h = hex.replace("#", "");
    return { r: parseInt(h.substring(0, 2), 16), g: parseInt(h.substring(2, 4), 16), b: parseInt(h.substring(4, 6), 16) };
  }

  function heatColor(t) {
    const stops = [seqColor(100), seqColor(300), seqColor(450), seqColor(600)].map(hexToRgb);
    const segments = stops.length - 1;
    const scaled = Math.min(1, Math.max(0, t)) * segments;
    const idx = Math.min(segments - 1, Math.floor(scaled));
    const localT = scaled - idx;
    const a = stops[idx], b = stops[idx + 1];
    const r = Math.round(a.r + (b.r - a.r) * localT);
    const g = Math.round(a.g + (b.g - a.g) * localT);
    const bl = Math.round(a.b + (b.b - a.b) * localT);
    return `rgb(${r}, ${g}, ${bl})`;
  }

  function destroyChart(key) {
    if (charts[key]) {
      charts[key].destroy();
      delete charts[key];
    }
  }

  function commonScaleOptions() {
    return {
      grid: { color: baseGridColor(), drawTicks: false },
      ticks: { color: textMutedColor(), font: { size: 11 } },
      border: { color: baseGridColor() },
    };
  }

  function renderHourChart(rows) {
    const counts = new Array(24).fill(0);
    for (const r of rows) counts[easternHour(r.t)]++;
    const labels = counts.map((_, h) => formatHourLabel(h));

    renderTable("table-hour", ["Hour", "Incidents"], counts.map((c, h) => [formatHourLabel(h), c]));

    destroyChart("hour");
    const ctx = document.getElementById("chart-hour").getContext("2d");
    charts.hour = new Chart(ctx, {
      type: "bar",
      data: {
        labels,
        datasets: [{
          data: counts,
          backgroundColor: seriesColor(1),
          borderRadius: 4,
          maxBarThickness: 20,
        }],
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false }, tooltip: { callbacks: {} } },
        scales: {
          x: commonScaleOptions(),
          y: { ...commonScaleOptions(), beginAtZero: true, ticks: { ...commonScaleOptions().ticks, precision: 0 } },
        },
      },
    });
  }

  function renderDayChart(rows, range) {
    const counts = countBy(rows, (r) => easternDateKey(r.t));
    const days = [];
    const dayMs = 86400000;
    for (let t = range[0]; t < range[1]; t += dayMs) {
      days.push(easternDateKey(t));
    }
    const uniqueDays = [...new Set(days)];
    const labels = uniqueDays.map((d) => displayDateFmt.format(new Date(d + "T12:00:00Z")));
    const values = uniqueDays.map((d) => counts.get(d) || 0);

    renderTable("table-day", ["Date", "Incidents"], uniqueDays.map((d, i) => [labels[i], values[i]]));

    destroyChart("day");
    const ctx = document.getElementById("chart-day").getContext("2d");
    charts.day = new Chart(ctx, {
      type: "line",
      data: {
        labels,
        datasets: [{
          data: values,
          borderColor: seriesColor(1),
          backgroundColor: seriesColor(1) + "1a",
          fill: true,
          borderWidth: 2,
          pointRadius: uniqueDays.length > 60 ? 0 : 3,
          tension: 0.15,
        }],
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: {
          x: commonScaleOptions(),
          y: { ...commonScaleOptions(), beginAtZero: true, ticks: { ...commonScaleOptions().ticks, precision: 0 } },
        },
      },
    });
  }

  const DAY_LABELS_FULL = { Sun: "Sunday", Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday", Sat: "Saturday" };

  function renderHeatmap(rows) {
    const { counts, max } = dayHourMatrix(rows);

    const tableRows = [];
    for (let d = 0; d < 7; d++) {
      for (let h = 0; h < 24; h++) {
        tableRows.push([`${DAY_LABELS_FULL[DAY_ORDER[d]]} ${formatHourLabel(h)}`, counts[d][h]]);
      }
    }
    renderTable("table-heatmap", ["Day / hour", "Incidents"], tableRows);

    const grid = document.getElementById("heatmap-grid");
    grid.innerHTML = "";

    const corner = document.createElement("div");
    corner.className = "heatmap-corner";
    grid.appendChild(corner);

    for (let h = 0; h < 24; h++) {
      const label = document.createElement("div");
      label.className = "heatmap-hour-label";
      label.textContent = h % 3 === 0 ? formatHourLabel(h) : "";
      grid.appendChild(label);
    }

    const gridline = baseGridColor();
    for (let d = 0; d < 7; d++) {
      const dayLabel = document.createElement("div");
      dayLabel.className = "heatmap-day-label";
      dayLabel.textContent = DAY_ORDER[d];
      grid.appendChild(dayLabel);

      for (let h = 0; h < 24; h++) {
        const count = counts[d][h];
        const cell = document.createElement("div");
        cell.className = "heatmap-cell";
        cell.style.background = count === 0 ? gridline : heatColor(count / max);
        cell.title = `${DAY_LABELS_FULL[DAY_ORDER[d]]} ${formatHourLabel(h)}: ${count} incident${count === 1 ? "" : "s"}`;
        grid.appendChild(cell);
      }
    }
  }

  const BREAKDOWN_KEYS = { jx: "jx", ci: "ci", ty: "ty", ag: "ag" };

  function renderBreakdown(key, rows, label) {
    const field = BREAKDOWN_KEYS[key];
    const counts = countBy(rows, (r) => r[field]);
    const top = topN(counts, 10);

    renderTable(`table-${key}`, [label, "Incidents"], top);

    destroyChart(key);
    const ctx = document.getElementById(`chart-${key}`).getContext("2d");
    charts[key] = new Chart(ctx, {
      type: "bar",
      data: {
        labels: top.map((e) => e[0]),
        datasets: [{
          data: top.map((e) => e[1]),
          backgroundColor: seriesColor(1),
          borderRadius: 4,
          maxBarThickness: 20,
        }],
      },
      options: {
        indexAxis: "y",
        responsive: true,
        plugins: { legend: { display: false } },
        scales: {
          x: { ...commonScaleOptions(), beginAtZero: true, ticks: { ...commonScaleOptions().ticks, precision: 0 } },
          y: commonScaleOptions(),
        },
      },
    });
  }

  function renderTable(containerId, headers, rows) {
    const el = document.getElementById(containerId);
    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    headers.forEach((h) => {
      const th = document.createElement("th");
      th.textContent = h;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    const tbody = document.createElement("tbody");
    rows.forEach(([a, b]) => {
      const tr = document.createElement("tr");
      const td1 = document.createElement("td");
      td1.textContent = a;
      const td2 = document.createElement("td");
      td2.textContent = String(b);
      tr.append(td1, td2);
      tbody.appendChild(tr);
    });
    table.append(thead, tbody);
    el.innerHTML = "";
    el.appendChild(table);
  }

  // ---------------- Map ----------------

  const AGENCY_COLORS = {}; // assigned on first sight, capped
  let nextColorSlot = 0;

  function colorForAgency(ag) {
    const known = { Law: 1, Fire: 2, EMS: 3, HC911: 4 };
    if (ag in known) return seriesColor(known[ag]);
    if (!(ag in AGENCY_COLORS)) {
      if (nextColorSlot < 4) {
        AGENCY_COLORS[ag] = seriesColor(5 + nextColorSlot);
        nextColorSlot++;
      } else {
        AGENCY_COLORS[ag] = getComputedStyle(document.body).getPropertyValue("--other-gray").trim();
      }
    }
    return AGENCY_COLORS[ag];
  }

  function renderMapLegend(rows) {
    const counts = countBy(rows, (r) => r.ag);
    const entries = topN(counts, 8);
    const el = document.getElementById("map-legend");
    el.innerHTML = "";
    entries.forEach(([ag]) => {
      const item = document.createElement("span");
      item.className = "legend-item";
      const swatch = document.createElement("span");
      swatch.className = "legend-swatch";
      swatch.style.background = colorForAgency(ag);
      const label = document.createElement("span");
      label.textContent = ag;
      item.append(swatch, label);
      el.appendChild(item);
    });
  }

  function renderMap(rows) {
    if (!map) {
      map = L.map("map", { scrollWheelZoom: false });
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "&copy; OpenStreetMap contributors",
        maxZoom: 18,
      }).addTo(map);
      map.setView([35.045, -85.25], 10);
    }
    if (mapLayer) {
      map.removeLayer(mapLayer);
    }

    renderMapLegend(rows);

    // Cluster by rounded coordinate.
    const clusters = new Map();
    for (const r of rows) {
      if (typeof r.lat !== "number" || typeof r.lon !== "number") continue;
      const key = `${r.lat.toFixed(3)},${r.lon.toFixed(3)}`;
      if (!clusters.has(key)) {
        clusters.set(key, { lat: r.lat, lon: r.lon, count: 0, types: new Map(), agencies: new Map() });
      }
      const c = clusters.get(key);
      c.count++;
      c.types.set(r.ty, (c.types.get(r.ty) || 0) + 1);
      c.agencies.set(r.ag, (c.agencies.get(r.ag) || 0) + 1);
    }

    const layerGroup = L.layerGroup();
    for (const c of clusters.values()) {
      const dominantAgency = topN(c.agencies, 1)[0]?.[0];
      const radius = 5 + Math.sqrt(c.count) * 3;
      const marker = L.circleMarker([c.lat, c.lon], {
        radius,
        color: surfaceColor(),
        weight: 2,
        fillColor: colorForAgency(dominantAgency),
        fillOpacity: 0.75,
      });
      const topTypes = topN(c.types, 3).map(([t, n]) => `${escapeHtml(t)} (${n})`).join(", ");
      marker.bindPopup(`<strong>${c.count}</strong> incident${c.count === 1 ? "" : "s"}<br>${topTypes}`);
      layerGroup.addLayer(marker);
    }
    mapLayer = layerGroup;
    layerGroup.addTo(map);
  }

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  // ---------------- Wiring ----------------

  function wireControls() {
    document.querySelectorAll(".preset-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        setActivePreset(btn.dataset.preset);
        applyRange(rangeForPreset(btn.dataset.preset));
      });
    });
    document.getElementById("apply-custom").addEventListener("click", () => {
      const start = document.getElementById("range-start").value;
      const end = document.getElementById("range-end").value;
      if (!start || !end) return;
      setActivePreset(null);
      applyRange(rangeForCustom(start, end));
    });
    document.getElementById("filter-ci").addEventListener("change", (e) => {
      currentFilters.ci = e.target.value;
      render();
    });
    document.getElementById("filter-ag").addEventListener("change", (e) => {
      currentFilters.ag = e.target.value;
      render();
    });
    document.getElementById("filter-ty").addEventListener("change", (e) => {
      currentFilters.ty = e.target.value;
      render();
    });
    document.getElementById("clear-filters").addEventListener("click", () => {
      currentFilters = { ci: "", ag: "", ty: "" };
      document.getElementById("filter-ci").value = "";
      document.getElementById("filter-ag").value = "";
      document.getElementById("filter-ty").value = "";
      render();
    });
    document.querySelectorAll(".table-toggle").forEach((btn) => {
      btn.addEventListener("click", () => {
        const target = document.getElementById(`table-${btn.dataset.target}`);
        const hidden = target.hasAttribute("hidden");
        if (hidden) {
          target.removeAttribute("hidden");
          btn.textContent = "Hide table";
        } else {
          target.setAttribute("hidden", "");
          btn.textContent = "View as table";
        }
      });
    });
  }

  async function init() {
    wireControls();
    try {
      await loadData();
    } catch (err) {
      document.getElementById("meta-updated").textContent = "Failed to load data.";
      console.error(err);
      return;
    }
    renderMeta();
    populateFilterOptions();
    setActivePreset("7d");
    applyRange(rangeForPreset("7d"));
  }

  init();
})();
