// fetch.js — run with Node.js 20+ (no dependencies needed)
// Fetches court availability for the next 8 days and saves to data.json
// Called by GitHub Actions daily at 2pm PT

const fs = require("fs");

// ─── Config ───────────────────────────────────────────────────────────────────

const MENLO_FACILITIES = [
  { label: "Burgess Park",   facilityId: "aa931648-bf9a-4519-9ade-652246c770ef", durationIds: ["a389d9e6-db77-4ea9-a8cd-38ab06957e85","b695197c-68ec-4979-915b-391ce1772664"] },
  { label: "Kelly Park",     facilityId: "0af566d8-5c13-485f-91ea-728e7f15f1de", durationIds: ["a8580947-118d-4aac-b424-15f2c94ddf29","d811ff3d-ad06-4628-ad3f-c17f2e5e89fd","578ab879-16bb-4829-ba1a-e5574e74681d"] },
  { label: "Nealon Park C1", facilityId: "6cff8a61-61be-4704-af1f-fabe1f55b331", durationIds: ["dc66975f-e048-4ed5-ad5b-75a7d606daad","facedf9e-4eff-4652-accc-ca3209c791aa"] },
  { label: "Nealon Park C2", facilityId: "ea029032-6bee-433d-884e-0965bd27c444", durationIds: ["57c058f5-48c2-44ff-ad22-96d9b2e9bdc5","991d9ec7-8c10-4fcb-ad11-ad6fe0edb695"] },
  { label: "Willow Oaks C1", facilityId: "f1b1bf4a-9e11-4438-8ee7-7cd3056a81bc", durationIds: ["a34e8393-a571-42b9-b6c0-e9c0eda0013b","5244fc74-8aa7-4980-9e40-ea7ece112dd0"] },
  { label: "Willow Oaks C2", facilityId: "f7ab9c6c-6555-488e-9e58-c7c391821631", durationIds: ["4737abc7-6ddf-46b9-a5b9-a9f2e8111606","1ef18208-33b9-4954-8757-b35593285010"] },
];

const MENLO_SERVICE_ID = "819f1be6-6add-4c70-b3fd-b5c71f5e38a3";
const MENLO_BASE = "https://cityofmenlopark.perfectmind.com";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function pad(n) { return String(n).padStart(2, "0"); }
function toDateStr(d) { return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }
function toDateKey(d) { return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}`; }

// Parse "HH:MM" → decimal hours
function parseHHMM(s) {
  const m = String(s||"").trim().match(/^(\d{1,2}):(\d{2})$/);
  return m ? parseInt(m[1]) + parseInt(m[2])/60 : null;
}

// Parse ASP.NET /Date(ms)/ format
function parseDotNetDate(str) {
  const m = String(str||"").match(/\/Date\((-?\d+)/);
  return m ? parseInt(m[1]) : null;
}

// ─── Presidio — rec.us ───────────────────────────────────────────────────────

async function fetchPresidio(date) {
  const url = `https://api.rec.us/v1/locations/c2f20478-83d8-48c9-af3d-065d7ba22d60/schedule?startDate=${toDateStr(date)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`rec.us HTTP ${res.status}`);
  const data = await res.json();

  const dateKey = toDateKey(date);
  const courts = data?.dates?.[dateKey];
  if (!Array.isArray(courts)) return [];

  const slots = [];
  for (const court of courts) {
    // Skip pickleball courts (Courts A, C, E) — only include Tennis
    const isTennis = (court.sports ?? []).some(s => s.name === "Tennis");
    if (!isTennis) continue;

    for (const [range, info] of Object.entries(court.schedule || {})) {
      if (info?.referenceType !== "RESERVABLE") continue;
      const parts = range.split(",");
      const startH = parseHHMM(parts[0]);
      const endH   = parseHHMM(parts[1]);
      if (startH !== null && endH !== null && endH - startH >= 1) {
        slots.push({ startH, endH, label: `Presidio ${court.courtNumber}` });
      }
    }
  }
  return slots;
}

// ─── Golden Gate Park — courtreserve ─────────────────────────────────────────

async function fetchGoldenGate(date) {
  const d = new Date(date); d.setHours(0,0,0,0);
  const jsonData = JSON.stringify({
    startDate: d.toISOString(),
    orgId: "12465",
    TimeZone: "America/Los_Angeles",
    Date: d.toUTCString(),
    KendoDate: { Year: d.getFullYear(), Month: d.getMonth()+1, Day: d.getDate() },
    UiCulture: "en-US",
    CostTypeId: "139864",
    CustomSchedulerId: "16819",
    ReservationMinInterval: "60",
  });

  const body = new URLSearchParams({ sort: "", group: "", filter: "", jsonData });
  const res = await fetch("https://app.courtreserve.com/Online/Reservations/ReadConsolidated/12465", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`courtreserve HTTP ${res.status}`);
  const data = await res.json();

  const dateStr = toDateStr(date);
  const items = data?.Data ?? [];
  const availHalfHours = new Set();

  for (const item of items) {
    if ((item.AvailableCourts ?? 0) === 0 || item.IsClosed) continue;
    // Use the Id field for local date/time (avoids UTC timezone shift issues)
    const id = String(item.Id ?? "");
    const m = id.match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/);
    if (!m) continue;
    if (`${m[3]}-${m[1]}-${m[2]}` !== dateStr) continue;
    availHalfHours.add(parseInt(m[4]) * 2 + (parseInt(m[5]) >= 30 ? 1 : 0));
  }

  const slots = [];
  for (let h = 7; h < 22; h++) {
    if (availHalfHours.has(h*2) && availHalfHours.has(h*2+1))
      slots.push({ startH: h, endH: h+1, label: "Golden Gate Park" });
  }
  return slots;
}

// ─── Menlo Park — perfectmind (with proper session/CSRF handling) ─────────────
// This is the key advantage of running server-side: no CORS, full cookie support.

async function getMenloSession() {
  const res = await fetch(`${MENLO_BASE}/26116/Clients/BookMe4LandingPages/Facility`, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      "Accept": "text/html,application/xhtml+xml",
    },
  });
  // perfectmind returns HTTP 500 but still sets session cookies and the CSRF
  // token in the HTML body — so we proceed regardless of status code.

  // Collect session cookies
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const cookieStr = setCookies.map(c => c.split(";")[0]).join("; ");

  const html = await res.text();
  const tokenMatch = html.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/);
  if (!tokenMatch) throw new Error("CSRF token not found in perfectmind page");

  return { token: tokenMatch[1], cookieStr };
}

async function fetchMenloFacility(date, facility, token, cookieStr) {
  const body = new URLSearchParams({
    facilityId: facility.facilityId,
    date: date.toISOString(),
    daysCount: "7",
    duration: "60",
    serviceId: MENLO_SERVICE_ID,
  });
  for (const id of facility.durationIds) body.append("durationIds[]", id);
  body.append("__RequestVerificationToken", token);

  const res = await fetch(`${MENLO_BASE}/26116/Clients/BookMe4LandingPages/FacilityAvailability`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Cookie": cookieStr,
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      "Referer": `${MENLO_BASE}/26116/Clients/BookMe4LandingPages/Facility`,
      "X-Requested-With": "XMLHttpRequest",
    },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`perfectmind facility HTTP ${res.status}`);

  const data = await res.json();
  const dateStr = toDateStr(date);
  const slots = [];

  // Real response format:
  // { availabilities: [{ Date: "/Date(ms)/", BookingGroups: [{ Name, AvailableSpots: [{ Time: {Hours,Minutes}, Duration: {Hours,Minutes} }] }] }] }
  for (const avail of data?.availabilities ?? []) {
    // Date field is UTC midnight ms for that calendar date
    const ms = parseInt(String(avail.Date ?? "").match(/Date\((\d+)/)?.[1] ?? "0");
    const itemDate = new Date(ms).toISOString().slice(0, 10); // "2026-05-07"
    if (itemDate !== dateStr) continue;

    for (const group of avail.BookingGroups ?? []) {
      for (const spot of group.AvailableSpots ?? []) {
        const startH = (spot.Time?.Hours ?? 0) + (spot.Time?.Minutes ?? 0) / 60;
        // Always treat as a 1-hr booking slot regardless of Duration
        slots.push({ startH, endH: startH + 1, label: `Menlo: ${facility.label}` });
      }
    }
  }
  return slots;
}

async function fetchMenlo(date) {
  const { token, cookieStr } = await getMenloSession();
  const settled = await Promise.allSettled(
    MENLO_FACILITIES.map(f => fetchMenloFacility(date, f, token, cookieStr))
  );
  const slots = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") slots.push(...r.value);
    else console.warn(`  Menlo ${MENLO_FACILITIES[i].label}: ${r.reason?.message}`);
  });
  return slots;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const output = { fetchedAt: new Date().toISOString(), days: {} };

  for (let i = 0; i < 8; i++) {
    const date = new Date(today);
    date.setDate(today.getDate() + i);
    const dateStr = toDateStr(date);
    const dow = date.getDay(); // 0=Sun 1=Mon … 6=Sat

    console.log(`\nFetching ${dateStr} (${["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][dow]})…`);

    const dayResult = {};

    // Presidio — active Tue/Thu/Sat/Sun
    if ([0, 2, 4, 6].includes(dow)) {
      try {
        dayResult.presidio = await fetchPresidio(date);
        console.log(`  Presidio: ${dayResult.presidio.length} slots`);
      } catch (e) {
        dayResult.presidioError = e.message;
        console.warn(`  Presidio error: ${e.message}`);
      }
    }

    // GGP — active Tue/Thu/Sat/Sun
    if ([0, 2, 4, 6].includes(dow)) {
      try {
        dayResult.ggp = await fetchGoldenGate(date);
        console.log(`  GGP: ${dayResult.ggp.length} slots`);
      } catch (e) {
        dayResult.ggpError = e.message;
        console.warn(`  GGP error: ${e.message}`);
      }
    }

    // Menlo — active Wed/Thu
    if ([3, 4].includes(dow)) {
      try {
        dayResult.menlo = await fetchMenlo(date);
        console.log(`  Menlo: ${dayResult.menlo.length} slots`);
      } catch (e) {
        dayResult.menloError = e.message;
        console.warn(`  Menlo error: ${e.message}`);
      }
    }

    output.days[dateStr] = dayResult;
  }

  fs.writeFileSync("data.json", JSON.stringify(output, null, 2));
  console.log("\n✓ Saved data.json");
}

main().catch(e => { console.error(e); process.exit(1); });
