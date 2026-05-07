// ─── Court config ─────────────────────────────────────────────────────────────

const COURTS = {
  presidio: {
    name: "Presidio",
    color: "presidio",
    bookUrl: "https://app.rec.us/locations/c2f20478-83d8-48c9-af3d-065d7ba22d60",
    preferredDays: [0, 2, 4, 6],
    // Show all available hours from open (7am) to close (10pm) every day
    getWindow() { return { start: 7, end: 22 }; },
    fetch: livePresidio,
  },
  ggp: {
    name: "Golden Gate Park",
    color: "ggp",
    bookUrl: "https://app.courtreserve.com/Online/Reservations/Bookings/12465",
    preferredDays: [0, 2, 4, 6],
    // CustomSchedulerId 16819 is the tennis-only scheduler (hard courts)
    getWindow() { return { start: 7, end: 22 }; },
    fetch: liveGoldenGate,
  },
  menlo: {
    name: "Menlo Park",
    color: "menlo",
    bookUrl: "https://cityofmenlopark.perfectmind.com/26116/Clients/BookMe4LandingPages/Facility",
    preferredDays: [3, 4],
    getWindow() { return { start: 17, end: 19 }; },
    fetch: liveMenloUnavailable,
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function pad(n) { return String(n).padStart(2, "0"); }
function toDateStr(d) { return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }
function toDateKey(d) { return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}`; }

function parseHHMM(s) {
  const m = String(s||"").trim().match(/^(\d{1,2}):(\d{2})$/);
  return m ? parseInt(m[1]) + parseInt(m[2])/60 : null;
}

// Filter / expand slots to 1-hr blocks within a time window.
// Exact 1-hr slots (e.g. Menlo) are kept as-is if within window.
// Longer reservable ranges (e.g. Presidio "07:30–10:30") are expanded into whole-hour blocks.
function filterSlots(slots, win) {
  const blocks = [];
  for (const s of slots) {
    if (Math.abs((s.endH - s.startH) - 1) < 0.01) {
      // Already a 1-hr slot — keep if start falls inside window
      if (s.startH >= win.start && s.startH < win.end) {
        blocks.push({ startH: s.startH, endH: s.endH, label: s.label, color: s.color });
      }
    } else {
      // Longer reservable block — expand to whole-hour sub-slots
      const lo = Math.max(s.startH, win.start);
      const hi = Math.min(s.endH,   win.end);
      for (let h = Math.ceil(lo); h + 1 <= hi; h++) {
        blocks.push({ startH: h, endH: h + 1, label: s.label, color: s.color });
      }
    }
  }
  return blocks;
}

const DAYS   = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function fmtHour(h) {
  const suffix = h >= 12 && h < 24 ? "PM" : "AM";
  const h12 = Math.floor(h % 12) || 12;
  const mins = (h % 1 >= 0.49) ? "30" : "00";
  return `${h12}:${mins} ${suffix}`;
}
function fmtSlot(a, b) { return `${fmtHour(a)} – ${fmtHour(b)}`; }

// ─── Cached data (loaded from data.json on startup) ───────────────────────────

let cachedData = null; // { fetchedAt: ISOString, days: { "YYYY-MM-DD": {presidio,ggp,menlo,...} } }

async function loadCache() {
  try {
    const res = await fetch(`./data.json?t=${Date.now()}`);
    if (!res.ok) return;
    const d = await res.json();
    if (d?.fetchedAt) { cachedData = d; console.log("[cache] loaded, fetched at", d.fetchedAt); }
  } catch (e) { console.warn("[cache] failed to load data.json:", e.message); }
}

function getCachedSlots(dateStr, courtKey) {
  if (!cachedData?.days?.[dateStr]) return null;
  const day = cachedData.days[dateStr];
  const slots = day[courtKey];
  const err   = day[`${courtKey}Error`];
  if (err) return { error: err };
  if (Array.isArray(slots)) return { slots };
  return null; // court not fetched for this day
}

function cacheAge() {
  if (!cachedData?.fetchedAt) return Infinity;
  return (Date.now() - new Date(cachedData.fetchedAt).getTime()) / 1000 / 60 / 60; // hours
}

// ─── CORS proxy helpers (for live browser fallback) ───────────────────────────

async function rawGet(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (r.ok) return r.text();
  } catch (e) { console.warn("Direct GET:", e.message); }

  // allorigins — works on all domains, GET only
  try {
    const r = await fetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(9000) });
    if (r.ok) return r.text();
  } catch (e) { console.warn("allorigins GET:", e.message); }

  // corsproxy — works on localhost, may 403 elsewhere
  const r = await fetch(`https://corsproxy.io/?${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(9000) });
  const t = await r.text();
  if (!r.ok) throw new Error(`GET failed (HTTP ${r.status})`);
  return t;
}

async function rawPost(url, body, headers = {}) {
  const opts = { method: "POST", body, headers };
  try {
    const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(5000) });
    if (r.ok) return r.text();
  } catch (e) { console.warn("Direct POST:", e.message); }

  // corsproxy — only reliable free POST proxy, works on localhost
  const r = await fetch(`https://corsproxy.io/?${encodeURIComponent(url)}`, { ...opts, signal: AbortSignal.timeout(10000) });
  const t = await r.text();
  if (!r.ok) throw new Error(`POST proxy failed (HTTP ${r.status}) — try checking court manually`);
  return t;
}

function asJSON(text, label) {
  try { return JSON.parse(text); }
  catch { throw new Error(`Unexpected response from ${label} — ${text.slice(0, 60)}`); }
}

// ─── Live fetch — Presidio (rec.us) ──────────────────────────────────────────

async function livePresidio(date) {
  const dateStr = toDateStr(date);
  const url = `https://api.rec.us/v1/locations/c2f20478-83d8-48c9-af3d-065d7ba22d60/schedule?startDate=${dateStr}`;
  const data = asJSON(await rawGet(url), "Presidio");
  const courts = data?.dates?.[toDateKey(date)];
  if (!Array.isArray(courts)) return [];
  const slots = [];
  for (const court of courts) {
    // Skip pickleball courts (Courts A, C, E etc.) — only include Tennis
    const isTennis = (court.sports ?? []).some(s => s.name === "Tennis");
    if (!isTennis) continue;
    for (const [range, info] of Object.entries(court.schedule || {})) {
      if (info?.referenceType !== "RESERVABLE") continue;
      const parts = range.split(",");
      const sh = parseHHMM(parts[0]), eh = parseHHMM(parts[1]);
      if (sh !== null && eh !== null && eh - sh >= 1)
        slots.push({ startH: sh, endH: eh, label: `Presidio ${court.courtNumber}`, color: "presidio" });
    }
  }
  return slots;
}

// ─── Live fetch — Golden Gate Park (courtreserve) ────────────────────────────

async function liveGoldenGate(date) {
  const d = new Date(date); d.setHours(0,0,0,0);
  const jsonData = JSON.stringify({
    startDate: d.toISOString(), orgId: "12465",
    TimeZone: "America/Los_Angeles", Date: d.toUTCString(),
    KendoDate: { Year: d.getFullYear(), Month: d.getMonth()+1, Day: d.getDate() },
    UiCulture: "en-US", CostTypeId: "139864",
    CustomSchedulerId: "16819", ReservationMinInterval: "60",
  });
  const body = new URLSearchParams({ sort:"", group:"", filter:"", jsonData });
  const text = await rawPost(
    "https://app.courtreserve.com/Online/Reservations/ReadConsolidated/12465",
    body.toString(),
    { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" }
  );
  const data = asJSON(text, "GGP");
  const dateStr = toDateStr(date);
  const avail = new Set();
  for (const item of (data?.Data ?? [])) {
    if ((item.AvailableCourts ?? 0) === 0 || item.IsClosed) continue;
    const m = String(item.Id ?? "").match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/);
    if (!m || `${m[3]}-${m[1]}-${m[2]}` !== dateStr) continue;
    avail.add(parseInt(m[4]) * 2 + (parseInt(m[5]) >= 30 ? 1 : 0));
  }
  const slots = [];
  for (let h = 7; h < 22; h++) {
    if (avail.has(h*2) && avail.has(h*2+1))
      slots.push({ startH: h, endH: h+1, label: "Golden Gate Park", color: "ggp" });
  }
  return slots;
}

// ─── Live fetch — Menlo Park (perfectmind cannot work from browser) ───────────

async function liveMenloUnavailable() {
  throw new Error(
    "Menlo Park needs a server-side session to check (CSRF + cookie). " +
    "Data updates automatically via GitHub Actions every hour — or tap the link to book manually."
  );
}

// Merge consecutive slots per court into contiguous ranges.
// e.g. [5-6 GGP, 6-7 GGP, 5-6 Presidio] → [5-7 GGP, 5-6 Presidio]
function mergeSlots(slots) {
  const byLabel = {};
  for (const s of slots) {
    if (!byLabel[s.label]) byLabel[s.label] = { color: s.color, blocks: [] };
    byLabel[s.label].blocks.push(s);
  }
  const merged = [];
  for (const [label, { color, blocks }] of Object.entries(byLabel)) {
    blocks.sort((a, b) => a.startH - b.startH);
    let cur = { ...blocks[0] };
    for (let i = 1; i < blocks.length; i++) {
      if (Math.abs(blocks[i].startH - cur.endH) < 0.02) {
        cur.endH = blocks[i].endH; // extend range
      } else {
        merged.push(cur);
        cur = { ...blocks[i] };
      }
    }
    merged.push(cur);
  }
  return merged;
}

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const dayBar     = document.getElementById("day-bar");
const statusEl   = document.getElementById("status");
const resultsEl  = document.getElementById("results");
const dayLabelEl = document.getElementById("day-label");
const legendEl   = document.getElementById("legend");
const cacheInfoEl = document.getElementById("cache-info");

// ─── Build day pills (ALL 8 days, none greyed out) ───────────────────────────

function getNext8Days() {
  const today = new Date(); today.setHours(0,0,0,0);
  return Array.from({length:8}, (_,i) => { const d=new Date(today); d.setDate(today.getDate()+i); return d; });
}

const next8 = getNext8Days();

next8.forEach((date, i) => {
  const dow = date.getDay();
  const btn = document.createElement("button");
  btn.className = "day-pill";
  btn.innerHTML = `<span class="dow">${DAYS[dow]}</span><span class="date">${MONTHS[date.getMonth()]} ${date.getDate()}</span>`;
  btn.addEventListener("click", () => selectDay(date, btn));
  dayBar.appendChild(btn);
});

// ─── Select a day ─────────────────────────────────────────────────────────────

function selectDay(date, btn) {
  document.querySelectorAll(".day-pill").forEach(p => p.classList.remove("active"));
  btn.classList.add("active");

  const dow = date.getDay();
  dayLabelEl.textContent = `${DAYS[dow]}, ${MONTHS[date.getMonth()]} ${date.getDate()}`;

  // Show legend for courts active on this day
  const activeCourts = Object.values(COURTS).filter(c => c.preferredDays.includes(dow));
  legendEl.innerHTML = activeCourts.length
    ? activeCourts.map(c => `<span class="legend-tag color-${c.color}">${c.name}</span>`).join("")
    : `<span class="legend-tag" style="opacity:.6">No courts on schedule today — checking anyway</span>`;

  loadDay(date, dow);
}

// ─── Load availability for a day ──────────────────────────────────────────────

async function loadDay(date, dow) {
  statusEl.style.display = "";
  resultsEl.style.display = "none";
  statusEl.innerHTML = `<div class="spinner"></div><p>Checking availability…</p>`;

  const dateStr = toDateStr(date);
  const allSlots = [];
  const errors   = [];
  const notices  = [];

  await Promise.allSettled(Object.entries(COURTS).map(async ([key, court]) => {
    const win = court.getWindow(dow);
    let slots = null;

    // 1. Try cached data first (if < 25 hours old)
    if (cacheAge() < 25) {
      const cached = getCachedSlots(dateStr, key);
      if (cached?.slots) {
        slots = filterSlots(
          cached.slots.map(s => ({ ...s, color: court.color })),
          win
        );
      } else if (cached?.error) {
        errors.push({ name: court.name, color: court.color, bookUrl: court.bookUrl, error: cached.error, fromCache: true });
        return;
      }
    }

    // 2. Live fetch if no cached data
    if (slots === null) {
      try {
        const raw = await court.fetch(date);
        slots = filterSlots(
          raw.map(s => ({ ...s, color: court.color })),
          win
        );
      } catch (e) {
        errors.push({ name: court.name, color: court.color, bookUrl: court.bookUrl, error: e.message, fromCache: false });
        return;
      }
    }

    if (slots.length > 0) allSlots.push(...slots);
    else if (court.preferredDays.includes(dow)) notices.push(court.name);
  }));

  statusEl.style.display = "none";
  resultsEl.style.display = "";
  resultsEl.innerHTML = "";

  // Cache info banner
  if (cachedData?.fetchedAt && cacheAge() < 25) {
    const fetchTime = new Date(cachedData.fetchedAt);
    const timeStr = fetchTime.toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"});
    const dateLabel = toDateStr(fetchTime) === toDateStr(new Date()) ? "today" : fetchTime.toLocaleDateString();
    const info = document.createElement("div");
    info.className = "cache-banner";
    info.textContent = `Data fetched ${dateLabel} at ${timeStr}`;
    resultsEl.appendChild(info);
  }

  // Errors
  errors.forEach(r => {
    const div = document.createElement("div");
    div.className = "error-box";
    div.innerHTML = `<span class="court-tag color-${r.color}" style="margin-bottom:6px;display:inline-block">${r.name}</span> ${r.error}<br>
      <a href="${r.bookUrl}" target="_blank">Check / book manually →</a>`;
    resultsEl.appendChild(div);
  });

  // Available slots — merge consecutive windows then group same range together
  if (allSlots.length > 0) {
    const hdr = document.createElement("div");
    hdr.className = "court-section-header";
    hdr.textContent = "Available slots";
    resultsEl.appendChild(hdr);

    // Merge consecutive slots per court (5-6 + 6-7 → 5-7)
    const merged = mergeSlots(allSlots);

    // Group courts that share the exact same time range onto one card
    const byRange = {};
    merged.forEach(s => {
      const k = `${s.startH}-${s.endH}`;
      if (!byRange[k]) byRange[k] = { startH: s.startH, endH: s.endH, courts: [] };
      byRange[k].courts.push(s);
    });

    Object.values(byRange).sort((a,b) => a.startH - b.startH).forEach(slot => {
      const card = document.createElement("div");
      card.className = "slot-card";
      card.innerHTML = `
        <div class="slot-time">${fmtSlot(slot.startH, slot.endH)}</div>
        <div class="slot-courts">${slot.courts.map(c =>
          `<span class="court-tag color-${c.color}">${c.label}</span>`
        ).join("")}</div>`;
      resultsEl.appendChild(card);
    });
  } else if (errors.length === 0) {
    // All courts checked, nothing available
    const div = document.createElement("div");
    div.className = "no-results";
    div.textContent = notices.length
      ? `No openings at ${notices.join(" or ")} during your preferred hours.`
      : "No courts on schedule for this day — nothing to show.";
    resultsEl.appendChild(div);
  }

  // Refresh button
  const btn = document.createElement("button");
  btn.className = "refresh-btn";
  btn.textContent = "Refresh";
  btn.onclick = () => loadDay(date, dow);
  resultsEl.appendChild(btn);
}

// ─── Startup: load cache then auto-select first day ──────────────────────────

(async function init() {
  await loadCache();

  // Auto-select first scheduled court day (or just today)
  let firstBtn = null;
  for (let i = 0; i < next8.length; i++) {
    const dow = next8[i].getDay();
    const hasScheduled = Object.values(COURTS).some(c => c.preferredDays.includes(dow));
    if (hasScheduled) { firstBtn = dayBar.children[i]; break; }
  }
  const target = firstBtn || dayBar.children[0];
  target.click();
  target.scrollIntoView({ inline: "center", behavior: "smooth" });
})();
