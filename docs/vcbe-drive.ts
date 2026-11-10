// vcbe-drive - Video Challenge BE (v1, 09/11/2026, richiesta utente; v3 10/11/2026: casa, punti di interesse, arbitri in viaggio, messaggi)
// Sezione «Drive» dell'app: accesso con nome + codice personale, prossime gare del Video Referee con la sala,
// percorsi (Valhalla FOSSGIS, ripiego OSRM FOSSGIS), ricerca luoghi (Nominatim), segnalazioni stradali tra arbitri,
// arrivo in sala, e azioni admin per i codici (password admin di vcbe_admin_config).
// Tabelle (RLS senza policy, solo server): vcbe_drive_access, vcbe_drive_sessions, vcbe_drive_settings, vcbe_venues,
// vcbe_geo_cache, vcbe_road_reports, vcbe_drive_events. Migration vcbe_drive_20261109.
// Azioni pubbliche: login {name, code, keep}, me {token}, logout {token}, venues {token}, route {token, from, to, via?, avoid?, lang},
//   search {token, q?, tag? parking|fuel|cafe, lat?, lng?} (Photon, ripiego Nominatim), request_access {name, note?}, reports {token, lat, lng, km?}, report {token, kind, lat, lng}, report_vote {token, id, still},
//   arrived {token, match_code?, match_date?, venue?, lat?, lng?}, event {token, kind, detail?}
// v3 (10/11/2026, richiesta utente): home_set {label, lat, lng} / home_clear (indirizzo di casa, anche in «me»),
//   poi {kind parking|fuel|charging|cafe|restaurant, points:[{lat,lng}]} (Overpass con più server in gara + cache vcbe_poi_cache, ripiego Photon),
//   live_ping {lat, lng, heading?, speed?, venue?, eta?} / live_stop / live_list (arbitri in viaggio o arrivati, posizione arrotondata ~1 km + zona),
//   reverse {lat, lng} → {label} (Photon), chat_convs / chat_list {conv: "all" | referee_id, before?} / chat_send {conv, kind text|photo|audio, body?, file_base64?, content_type?, duration?}
//   Tabelle vcbe_drive_home, vcbe_drive_live, vcbe_drive_messages, vcbe_poi_cache; bucket privato vcbe-drive-chat. Migration vcbe_drive_home_live_chat_20261110.
// Azioni admin (password): adm_list, adm_set {referee_id, code?, active?}, adm_unlock {referee_id}, adm_generate_missing,
//   adm_settings {...}, adm_email_code {referee_id}, adm_signout {referee_id}, adm_geocode_venues {force?}, adm_dismiss_request {referee_id}
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST,OPTIONS" };
const SB_URL = Deno.env.get("SUPABASE_URL")!;
function getServiceKey(): string {
  const direct = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (direct) return direct;
  try { const d = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}"); return d.secret ?? d.service_role ?? (Object.values(d)[0] as string) ?? ""; } catch (_) { return ""; }
}
const RESEND_KEY = Deno.env.get("RESEND_API_KEY") || "";
const FROM = (Deno.env.get("RESEND_FROM") || "").trim() || "Video Challenge BE <onboarding@resend.dev>";
const HOOK_URL = (Deno.env.get("DRIVE_HOOK_URL") || "https://script.google.com/macros/s/AKfycbxryPucgKXeouHxHC69RIYCFR13QESGwU5OD8kpg8iIP3eVMLPmoQtCTR7UPhRNkxgu/exec").trim();
const HOOK_SECRET = (Deno.env.get("DRIVE_HOOK_SECRET") || "").trim();
const ADMIN = "cnogara25@gmail.com";
const APP_URL = "https://video-challenge-be.vercel.app";
const UA = "VideoChallengeBE/1.0 (+https://video-challenge-be.vercel.app)";
const KINDS = ["traffic", "police", "crash", "works", "hazard", "closed"];

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

type Mail = { to: string; cc?: string; subject: string; html: string; text: string };
async function sendMail(m: Mail): Promise<{ ok: boolean; channel: string; detail: string }> {
  let hookErr = "";
  if (HOOK_URL && HOOK_SECRET) {
    try {
      const r = await fetch(HOOK_URL, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ action: "send", secret: HOOK_SECRET, ...m }), redirect: "follow" });
      const txt = await r.text(); let j: any = null; try { j = JSON.parse(txt); } catch (_) { /* */ }
      if (j && j.ok) return { ok: true, channel: "apps_script", detail: String(j.from || "") };
      hookErr = (j && j.error) ? String(j.error) : `http ${r.status}`;
    } catch (e) { hookErr = String((e as Error)?.message ?? e); }
  } else hookErr = "DRIVE_HOOK_SECRET not set";
  if (RESEND_KEY) {
    const body: Record<string, unknown> = { from: FROM, to: [m.to], subject: m.subject, html: m.html, text: m.text };
    if (m.cc && m.cc.toLowerCase() !== m.to.toLowerCase()) body.cc = [m.cc];
    const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (r.ok) return { ok: true, channel: "resend", detail: `apps_script: ${hookErr}` };
    return { ok: false, channel: "resend", detail: `apps_script: ${hookErr} · resend ${r.status}` };
  }
  return { ok: false, channel: "none", detail: hookErr || "no email channel" };
}

async function sha256(s: string): Promise<string> {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2, "0")).join("");
}
function randHex(n: number) { const a = new Uint8Array(n); crypto.getRandomValues(a); return Array.from(a).map(x => x.toString(16).padStart(2, "0")).join(""); }
function randDigits(n: number) { const a = new Uint32Array(n); crypto.getRandomValues(a); let s = ""; for (let i = 0; i < n; i++) s += String(a[i] % 10); if (s[0] === "0") s = "1" + s.slice(1); return s; }
function todayBrussels(): string { return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Brussels", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }
function hav(a: number, b: number, c: number, d: number) { const R = 6371, r = Math.PI / 180; const x = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); }
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : NaN; };
const okPt = (p: any) => p && Number.isFinite(num(p.lat)) && Number.isFinite(num(p.lng)) && Math.abs(num(p.lat)) <= 90 && Math.abs(num(p.lng)) <= 180;

// ---------- geocoding (Nominatim, cache in vcbe_geo_cache) ----------
let lastNom = 0;
async function nominatim(q: string, extra = ""): Promise<any[]> {
  const wait = 1100 - (Date.now() - lastNom); if (wait > 0) await sleep(wait);
  lastNom = Date.now();
  const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2${q ? "&addressdetails=0&q=" + encodeURIComponent(q) : ""}${extra}`, { headers: { "User-Agent": UA, "Accept-Language": "en" } });
  if (!r.ok) return [];
  try { return await r.json(); } catch (_) { return []; }
}
async function photon(q: string, extra = ""): Promise<any[]> {
  try {
    const r = await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&lang=en${extra}`, { headers: { "User-Agent": UA } });
    if (!r.ok) return [];
    const j = await r.json();
    return (j.features || []).map((f: any) => { const p = f.properties || {}; const c = (f.geometry || {}).coordinates || [];
      const street = [p.street, p.housenumber].filter(Boolean).join(" ");
      const label = [p.name, street, [p.postcode, p.city || p.district].filter(Boolean).join(" ")].filter(Boolean).join(", ");
      return { lat: Number(c[1]), lon: Number(c[0]), name: p.name || street || p.city || "", display_name: label, cc: String(p.countrycode || "").toUpperCase() }; });
  } catch (_) { return []; }
}
async function geocode(sb: any, queries: string[]): Promise<{ lat: number; lng: number } | null> {
  for (const q0 of queries) {
    const q = q0.replace(/\s+/g, " ").trim(); if (!q) continue;
    const { data: c } = await sb.from("vcbe_geo_cache").select("lat,lng").eq("q", q).maybeSingle();
    if (c && c.lat != null) return { lat: c.lat, lng: c.lng };
    let hit: any = (await photon(q, "&limit=3&lat=50.6&lon=4.5")).find((x: any) => x.cc === "BE" && Number.isFinite(x.lat));
    if (!hit) { const n = await nominatim(q, "&limit=1&countrycodes=be"); if (n && n[0]) hit = { lat: Number(n[0].lat), lon: Number(n[0].lon), display_name: n[0].display_name }; }
    if (hit) { await sb.from("vcbe_geo_cache").upsert({ q, lat: hit.lat, lng: hit.lon, label: String(hit.display_name || "") }); return { lat: hit.lat, lng: hit.lon }; }
  }
  return null;
}
function splitVenue(v: string) {
  const p = String(v || "").split(",").map(s => s.trim()).filter(Boolean);
  const city = p[0] || ""; const name = p[1] || p[0] || ""; const address = p.slice(2).join(", ");
  return { city, name, address };
}
const cleanAddr = (a: string) => a.replace(/\([^)]*\)/g, " ").replace(/\s+,/g, ",").replace(/\s+/g, " ").trim();


// ---------- points of interest (v3) ----------
// Prima la ricerca dei punti partiva dal browser verso overpass-api.de: quando il server è saturo (502 «All query workers are busy»)
// o lento, la richiesta falliva e l'app mostrava «Nothing found». Ora: più server Overpass in gara + Nominatim in parallelo, cache 6 h.
const OVERPASS = ["https://overpass-api.de/api/interpreter", "https://maps.mail.ru/osm/tools/overpass/api/interpreter", "https://overpass.kumi.systems/api/interpreter", "https://overpass.private.coffee/api/interpreter"];
const POI: Record<string, { q: string; photon: string[]; word: string; amenity: string }> = {
  parking: { q: '["amenity"="parking"]["access"!~"^(private|no|customers)$"]', photon: ["amenity:parking"], word: "parking", amenity: "parking" },
  fuel: { q: '["amenity"="fuel"]', photon: ["amenity:fuel"], word: "fuel", amenity: "fuel" },
  charging: { q: '["amenity"="charging_station"]["access"!~"^(private|no)$"]', photon: ["amenity:charging_station"], word: "charging station", amenity: "charging_station" },
  cafe: { q: '["amenity"~"^(cafe|fast_food)$"]', photon: ["amenity:cafe", "amenity:fast_food"], word: "cafe", amenity: "cafe" },
  restaurant: { q: '["amenity"="restaurant"]', photon: ["amenity:restaurant"], word: "restaurant", amenity: "restaurant" },
};
async function overpassRace(query: string, ms = 14000): Promise<any[] | null> {
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await Promise.any(OVERPASS.map(async (u) => {
      const r = await fetch(u, { method: "POST", signal: ctl.signal, headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA }, body: "data=" + encodeURIComponent(query) });
      if (!r.ok) throw new Error("http " + r.status);
      const j = await r.json(); if (!j || !Array.isArray(j.elements)) throw new Error("bad");
      return j.elements;
    }));
  } catch (_) { return null; } finally { clearTimeout(timer); ctl.abort(); }
}
function poiLabel(t: any) { return [[t["addr:street"], t["addr:housenumber"]].filter(Boolean).join(" "), [t["addr:postcode"], t["addr:city"]].filter(Boolean).join(" ")].filter(Boolean).join(", "); }
async function poiSearch(sb: any, kind: string, pts: { lat: number; lng: number }[]) {
  const def = POI[kind]; if (!def || !pts.length) return { results: [], source: "none" };
  const key = kind + ":" + pts.map(p => p.lat.toFixed(2) + "," + p.lng.toFixed(2)).join("|");
  const { data: c } = await sb.from("vcbe_poi_cache").select("results,created_at").eq("key", key).maybeSingle();
  if (c && Date.now() - new Date(c.created_at).getTime() < 6 * 3600000) return { results: c.results, source: "cache" };
  const radius = kind === "parking" ? 2500 : kind === "charging" ? 8000 : 6000;
  const q = `[out:json][timeout:12];(${pts.map(p => `nwr${def.q}(around:${radius},${p.lat},${p.lng});`).join("")});out center tags 80;`;
  // Overpass (più server in gara) e Nominatim in parallelo: verificato il 10/11/2026 che i server Overpass pubblici
  // rispondono spesso 502/504 o vanno in timeout, mentre Nominatim (amenity=… nel riquadro attorno al punto) risponde.
  const nomP = (async () => {
    const res: any[] = [];
    for (const p of pts.slice(0, 2)) {
      const dl = radius / 111000, dg = dl / Math.cos(p.lat * Math.PI / 180);
      const n = await nominatim("", `&amenity=${encodeURIComponent(def.amenity)}&viewbox=${(p.lng - dg).toFixed(4)},${(p.lat + dl).toFixed(4)},${(p.lng + dg).toFixed(4)},${(p.lat - dl).toFixed(4)}&bounded=1&limit=25&addressdetails=1`);
      for (const x of n || []) { const a = x.address || {}; res.push({ name: String(x.name || "").slice(0, 80), label: [[a.road, a.house_number].filter(Boolean).join(" "), [a.postcode, a.village || a.town || a.city || a.municipality].filter(Boolean).join(" ")].filter(Boolean).join(", ").slice(0, 160), lat: Number(x.lat), lng: Number(x.lon) }); }
    }
    return res;
  })().catch(() => [] as any[]);
  let out: any[] = []; let source = "overpass";
  const els = await overpassRace(q, 9000);
  if (els && els.length) {
    out = els.map((e: any) => { const la = e.lat ?? e.center?.lat, lo = e.lon ?? e.center?.lon, t = e.tags || {};
      const extra: string[] = [];
      if (kind === "charging") { const kw = t["socket:type2_combo:output"] || t["socket:chademo:output"] || t["socket:type2:output"] || t["maxpower"]; if (kw) extra.push(String(kw)); if (t.capacity) extra.push(t.capacity + "×"); }
      if (kind === "parking" && t.fee) extra.push(t.fee === "no" ? "free" : "paid");
      return { name: String(t.name || t.brand || t.operator || "").slice(0, 80), label: [poiLabel(t), extra.join(" · ")].filter(Boolean).join(" · ").slice(0, 160), lat: la, lng: lo, brand: t.brand || "" }; })
      .filter((r: any) => Number.isFinite(r.lat));
  }
  if (!out.length) { source = "nominatim"; out = (await nomP).filter((r: any) => Number.isFinite(r.lat)); }
  const seen = new Set<string>();
  out = out.filter((r: any) => { const k = r.lat.toFixed(4) + "," + r.lng.toFixed(4); if (seen.has(k)) return false; seen.add(k); return true; });
  out.forEach((r: any) => { r.km = Math.round(Math.min(...pts.map(p => hav(p.lat, p.lng, r.lat, r.lng))) * 10) / 10; });
  out.sort((a: any, b: any) => a.km - b.km); out = out.slice(0, 12);
  if (out.length) await sb.from("vcbe_poi_cache").upsert({ key, results: out, created_at: new Date().toISOString() });
  return { results: out, source };
}
async function reverseZone(lat: number, lng: number): Promise<string> {
  try {
    const r = await fetch(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lng}&limit=1&lang=en`, { headers: { "User-Agent": UA } });
    if (!r.ok) return ""; const j = await r.json(); const p = (j.features || [])[0]?.properties || {};
    return [p.city || p.town || p.village || p.district || p.locality || p.county, p.state && p.countrycode !== "BE" ? p.state : ""].filter(Boolean).join(", ").slice(0, 80);
  } catch (_) { return ""; }
}
const CHAT_BUCKET = "vcbe-drive-chat";
const CHAT_TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/aac": "aac", "audio/mpeg": "mp3", "audio/webm": "webm", "audio/ogg": "ogg", "audio/wav": "wav" };
function b64bytes(b: string): Uint8Array { const s = atob(b.replace(/^data:[^,]*,/, "")); const a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; }

// ---------- routing ----------
const LANGS: Record<string, string> = { en: "en-US", fr: "fr-FR", nl: "nl-NL" };
function decode6(str: string): number[][] {
  let index = 0, lat = 0, lng = 0; const out: number[][] = [];
  while (index < str.length) {
    let b, shift = 0, result = 0;
    do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0; result = 0;
    do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    out.push([lat / 1e6, lng / 1e6]);
  }
  return out;
}
function encode6(pts: number[][]): string {
  let out = "", pl = 0, pg = 0;
  const enc = (v: number) => { v = v < 0 ? ~(v << 1) : (v << 1); let s = ""; while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } return s + String.fromCharCode(v + 63); };
  for (const [la, lo] of pts) { const a = Math.round(la * 1e6), b = Math.round(lo * 1e6); out += enc(a - pl) + enc(b - pg); pl = a; pg = b; }
  return out;
}
async function valhalla(locs: any[], avoid: any, lang: string, alternates: number) {
  const co: any = {};
  if (avoid?.motorways) co.use_highways = 0;
  if (avoid?.tolls) co.use_tolls = 0;
  if (avoid?.ferries) co.use_ferry = 0;
  const req = { locations: locs.map(p => ({ lat: num(p.lat), lon: num(p.lng) })), costing: "auto", costing_options: { auto: co }, directions_options: { language: LANGS[lang] || "en-US", units: "kilometers" }, alternates };
  const r = await fetch("https://valhalla1.openstreetmap.de/route", { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": UA }, body: JSON.stringify(req) });
  if (!r.ok) throw new Error("valhalla " + r.status + " " + (await r.text()).slice(0, 200));
  const j = await r.json();
  const trips = [j.trip, ...((j.alternates || []).map((a: any) => a.trip))].filter(Boolean);
  return trips.map((trip: any) => {
    let pts: number[][] = []; const man: any[] = [];
    for (const leg of trip.legs || []) {
      const off = pts.length ? pts.length - 1 : 0;
      const lp = decode6(leg.shape || "");
      pts = pts.length ? pts.concat(lp.slice(1)) : lp;
      for (const m of leg.maneuvers || []) {
        man.push({ type: m.type, text: m.instruction || "", pre: m.verbal_pre_transition_instruction || m.instruction || "", alert: m.verbal_transition_alert_instruction || "", post: m.verbal_post_transition_instruction || "", street: (m.street_names || [])[0] || "", km: m.length || 0, s: (m.time || 0), i: (m.begin_shape_index || 0) + off, exit: m.roundabout_exit_count || null });
      }
    }
    const via = (trip.legs || []).length > 1;
    const roads: string[] = []; for (const m of man) { if (m.street && !roads.includes(m.street) && m.km > 3) roads.push(m.street); }
    return { engine: "valhalla", time_s: Math.round(trip.summary?.time || 0), km: Math.round((trip.summary?.length || 0) * 10) / 10, toll: !!trip.summary?.has_toll, motorway: !!trip.summary?.has_highway, via, roads: roads.slice(0, 3), shape: encode6(pts), maneuvers: man };
  });
}
const OT: Record<string, Record<string, string>> = {
  en: { depart: "Head off", arrive: "You have arrived", left: "Turn left", right: "Turn right", sleft: "Bear left", sright: "Bear right", uturn: "Make a U-turn", straight: "Continue straight", round: "At the roundabout, take exit {n}", ramp: "Take the ramp", merge: "Merge", fork: "Keep {d} at the fork", onto: " onto {s}", kl: "left", kr: "right" },
  fr: { depart: "Partez", arrive: "Vous êtes arrivé", left: "Tournez à gauche", right: "Tournez à droite", sleft: "Serrez à gauche", sright: "Serrez à droite", uturn: "Faites demi-tour", straight: "Continuez tout droit", round: "Au rond-point, prenez la sortie {n}", ramp: "Prenez la bretelle", merge: "Insérez-vous", fork: "Restez à {d} à l'embranchement", onto: " sur {s}", kl: "gauche", kr: "droite" },
  nl: { depart: "Vertrek", arrive: "U bent aangekomen", left: "Sla linksaf", right: "Sla rechtsaf", sleft: "Houd links aan", sright: "Houd rechts aan", uturn: "Keer om", straight: "Ga rechtdoor", round: "Neem op de rotonde afslag {n}", ramp: "Neem de oprit", merge: "Voeg in", fork: "Houd {d} aan bij de splitsing", onto: " naar {s}", kl: "links", kr: "rechts" },
};
async function osrm(locs: any[], lang: string, alternates: boolean) {
  const L = OT[lang] || OT.en;
  const coords = locs.map(p => `${num(p.lng)},${num(p.lat)}`).join(";");
  const r = await fetch(`https://routing.openstreetmap.de/routed-car/route/v1/driving/${coords}?overview=full&geometries=polyline6&steps=true&alternatives=${alternates ? "true" : "false"}`, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error("osrm " + r.status);
  const j = await r.json();
  return (j.routes || []).map((rt: any) => {
    const pts = decode6(rt.geometry || ""); const man: any[] = [];
    let idx = 0;
    for (const leg of rt.legs || []) for (const st of leg.steps || []) {
      const m = st.maneuver || {}; const mod = String(m.modifier || "");
      let tx = "";
      if (m.type === "depart") tx = L.depart; else if (m.type === "arrive") tx = L.arrive;
      else if (m.type === "roundabout" || m.type === "rotary") tx = L.round.replace("{n}", String(m.exit || 1));
      else if (m.type === "on ramp" || m.type === "off ramp") tx = L.ramp;
      else if (m.type === "merge") tx = L.merge;
      else if (m.type === "fork") tx = L.fork.replace("{d}", mod.includes("left") ? L.kl : L.kr);
      else if (mod === "uturn") tx = L.uturn; else if (mod === "left" || mod === "sharp left") tx = L.left; else if (mod === "right" || mod === "sharp right") tx = L.right;
      else if (mod === "slight left") tx = L.sleft; else if (mod === "slight right") tx = L.sright; else tx = L.straight;
      if (st.name && m.type !== "arrive") tx += L.onto.replace("{s}", st.name);
      let best = idx, bd = 1e9; const ml = m.location || [0, 0];
      for (let k = idx; k < pts.length; k++) { const d = Math.abs(pts[k][0] - ml[1]) + Math.abs(pts[k][1] - ml[0]); if (d < bd) { bd = d; best = k; } if (d < 1e-6) break; }
      idx = best;
      const type = m.type === "arrive" ? 4 : m.type === "depart" ? 1 : (mod.includes("left") ? 15 : mod.includes("right") ? 10 : 8);
      man.push({ type, text: tx, pre: tx, alert: "", post: "", street: st.name || "", km: (st.distance || 0) / 1000, s: st.duration || 0, i: best, exit: m.exit || null });
    }
    return { engine: "osrm", time_s: Math.round(rt.duration || 0), km: Math.round((rt.distance || 0) / 100) / 10, toll: false, motorway: false, via: (rt.legs || []).length > 1, roads: [], shape: encode6(pts), maneuvers: man };
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let body: any = {};
  try { body = await req.json(); } catch (_) { /* */ }
  const action = String(body.action || "");
  const sb = createClient(SB_URL, getServiceKey(), { auth: { persistSession: false } });
  const { data: st0 } = await sb.from("vcbe_drive_settings").select("*").eq("id", 1).maybeSingle();
  const S = st0 || { require_code: true, session_days: 30, max_attempts: 5, lock_minutes: 15, code_length: 4 };

  // ================= ADMIN =================
  if (action.startsWith("adm_")) {
    const { data: cfg } = await sb.from("vcbe_admin_config").select("value").eq("key", "admin_password").maybeSingle();
    const pw = String(cfg?.value || "").trim();
    if (!pw || String(body.password || "").trim() !== pw) return json({ error: "unauthorized" }, 401);
    const refId = String(body.referee_id || "");

    if (action === "adm_list") {
      const [{ data: refs }, { data: acc }, { data: ses }, { data: ev }] = await Promise.all([
        sb.from("vcbe_referees").select("id,name,email,active,sort_order").eq("active", true).order("sort_order", { nullsFirst: false }).order("name"),
        sb.from("vcbe_drive_access").select("*"),
        sb.from("vcbe_drive_sessions").select("referee_id,expires_at").gt("expires_at", new Date().toISOString()),
        sb.from("vcbe_drive_events").select("kind,match_code,venue,created_at,referee_id,detail").order("created_at", { ascending: false }).limit(25),
      ]);
      const A = new Map((acc || []).map((a: any) => [a.referee_id, a]));
      const N = new Map((refs || []).map((r: any) => [r.id, r.name]));
      const now = Date.now();
      const rows = (refs || []).map((r: any) => {
        const a: any = A.get(r.id) || {};
        return { id: r.id, name: r.name, has_email: !!r.email, code: a.code || "", active: !!a.active, locked: !!(a.locked_until && new Date(a.locked_until).getTime() > now), locked_until: a.locked_until || null, failed_attempts: a.failed_attempts || 0, last_login_at: a.last_login_at || null, sessions: (ses || []).filter((s: any) => s.referee_id === r.id).length };
      });
      const { data: rq } = await sb.from("vcbe_drive_events").select("referee_id,created_at,detail").eq("kind", "access_request").gt("created_at", new Date(Date.now() - 30 * 86400000).toISOString()).order("created_at", { ascending: false });
      const seen = new Set<string>(); const requests: any[] = [];
      for (const q of rq || []) {
        if (seen.has(q.referee_id)) continue; seen.add(q.referee_id);
        const a: any = A.get(q.referee_id) || {};
        if (a.last_login_at && new Date(a.last_login_at).getTime() > new Date(q.created_at).getTime()) continue;
        if (q.detail && q.detail.dismissed) continue;
        requests.push({ referee_id: q.referee_id, name: N.get(q.referee_id) || "", created_at: q.created_at, note: q.detail?.note || null });
      }
      return json({ ok: true, settings: S, referees: rows, requests, events: (ev || []).map((e: any) => ({ ...e, name: N.get(e.referee_id) || "" })) });
    }
    if (action === "adm_dismiss_request") {
      const { data: rq } = await sb.from("vcbe_drive_events").select("id,detail").eq("kind", "access_request").eq("referee_id", refId);
      for (const q of rq || []) await sb.from("vcbe_drive_events").update({ detail: { ...(q.detail || {}), dismissed: true } }).eq("id", q.id);
      return json({ ok: true });
    }
    if (action === "adm_set") {
      if (!refId) return json({ error: "referee_id required" }, 400);
      const { data: cur } = await sb.from("vcbe_drive_access").select("*").eq("referee_id", refId).maybeSingle();
      const patch: any = { referee_id: refId, updated_at: new Date().toISOString() };
      if (body.code !== undefined) {
        const code = String(body.code || "").replace(/\D/g, "");
        if (code && (code.length < 4 || code.length > 8)) return json({ error: "code must be 4 to 8 digits" }, 400);
        patch.code = code || null; patch.failed_attempts = 0; patch.locked_until = null;
        if (!code) patch.active = false;
        if ((cur?.code || "") !== code) await sb.from("vcbe_drive_sessions").delete().eq("referee_id", refId);
      }
      if (body.active !== undefined) {
        const code = patch.code !== undefined ? patch.code : cur?.code;
        if (body.active && !code) return json({ error: "set a code first" }, 400);
        patch.active = !!body.active;
        if (!body.active) await sb.from("vcbe_drive_sessions").delete().eq("referee_id", refId);
      }
      const { error } = await sb.from("vcbe_drive_access").upsert(patch);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }
    if (action === "adm_unlock") {
      const { error } = await sb.from("vcbe_drive_access").update({ failed_attempts: 0, locked_until: null, updated_at: new Date().toISOString() }).eq("referee_id", refId);
      return error ? json({ error: error.message }, 500) : json({ ok: true });
    }
    if (action === "adm_signout") {
      await sb.from("vcbe_drive_sessions").delete().eq("referee_id", refId);
      return json({ ok: true });
    }
    if (action === "adm_generate_missing") {
      const [{ data: refs }, { data: acc }] = await Promise.all([sb.from("vcbe_referees").select("id").eq("active", true), sb.from("vcbe_drive_access").select("referee_id,code")]);
      const has = new Set((acc || []).filter((a: any) => a.code).map((a: any) => a.referee_id));
      const rows = (refs || []).filter((r: any) => !has.has(r.id)).map((r: any) => ({ referee_id: r.id, code: randDigits(Math.min(8, Math.max(4, S.code_length || 4))), active: false, failed_attempts: 0, locked_until: null, updated_at: new Date().toISOString() }));
      if (rows.length) { const { error } = await sb.from("vcbe_drive_access").upsert(rows); if (error) return json({ error: error.message }, 500); }
      return json({ ok: true, created: rows.length });
    }
    if (action === "adm_settings") {
      const p: any = { id: 1, updated_at: new Date().toISOString() };
      if (body.require_code !== undefined) p.require_code = !!body.require_code;
      const MAXV: Record<string, number> = { session_days: 365, max_attempts: 20, lock_minutes: 1440, code_length: 8 };
      for (const k of Object.keys(MAXV)) if (body[k] !== undefined) { const v = Math.round(num(body[k])); if (Number.isFinite(v) && v >= 1 && v <= MAXV[k]) p[k] = v; }
      if (p.code_length !== undefined && (p.code_length < 4 || p.code_length > 8)) return json({ error: "code_length 4-8" }, 400);
      if (p.max_attempts !== undefined && p.max_attempts < 1) return json({ error: "max_attempts >= 1" }, 400);
      const { error } = await sb.from("vcbe_drive_settings").upsert(p);
      return error ? json({ error: error.message }, 500) : json({ ok: true });
    }
    if (action === "adm_email_code") {
      const [{ data: r }, { data: a }] = await Promise.all([sb.from("vcbe_referees").select("name,email").eq("id", refId).maybeSingle(), sb.from("vcbe_drive_access").select("code,active").eq("referee_id", refId).maybeSingle()]);
      if (!r) return json({ error: "referee not found" }, 404);
      if (!r.email) return json({ error: "no email for this referee" }, 400);
      if (!a?.code) return json({ error: "no code set" }, 400);
      if (!a.active) return json({ error: "code not active" }, 400);
      const subject = "Video Challenge BE – Your personal code for Drive";
      const text = `Dear ${r.name},\n\nThe Video Challenge BE app has a new section, Drive: it shows your next match, plans the drive to the sports hall and guides you there.\n\nTo open it, tap Drive in the app and sign in with:\n- Name: ${r.name}\n- Personal code: ${a.code}\n\nThe code is personal: please do not share it.\n\nApp: ${APP_URL}\n\nIf the button or link opens a blank page or does not work, press and hold it, choose Copy, and paste the link into your browser – or type video-challenge-be.vercel.app in the address bar.\n\nKind regards,\nVideo Challenge BE`;
      const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#222;max-width:640px"><p>Dear ${esc(r.name)},</p><p>The Video Challenge BE app has a new section, <b>Drive</b>: it shows your next match, plans the drive to the sports hall and guides you there.</p><p>To open it, tap <b>Drive</b> in the app and sign in with:</p><div style="background:#EAF0FE;border-radius:10px;padding:14px 18px;margin:10px 0"><div>Name: <b>${esc(r.name)}</b></div><div>Personal code: <b style="font-size:20px;letter-spacing:3px">${esc(a.code)}</b></div></div><p>The code is personal: please do not share it.</p><p><a href="${APP_URL}" style="display:inline-block;background:#2563EB;color:#fff;text-decoration:none;font-weight:bold;padding:12px 18px;border-radius:10px">Open the app</a></p><p style="color:#555;font-size:13px">If the button or link opens a blank page or does not work, press and hold it, choose Copy, and paste the link into your browser – or type video-challenge-be.vercel.app in the address bar.</p><p>Kind regards,<br>Video Challenge BE</p></div>`;
      const res = await sendMail({ to: r.email, cc: ADMIN, subject, text, html });
      await sb.from("vcbe_drive_events").insert({ referee_id: refId, kind: "code_email", detail: { ok: res.ok, channel: res.channel } });
      return json({ ok: res.ok, channel: res.channel, detail: res.ok ? "" : res.detail });
    }
    if (action === "adm_geocode_venues") {
      const { data: vs } = await sb.from("vcbe_venues").select("*");
      let done = 0, fail: string[] = [];
      for (const v of vs || []) {
        if (v.lat != null && !body.force) continue;
        const g = await geocode(sb, [cleanAddr(v.address) + ", Belgium", v.venue + ", " + cleanAddr(v.address).split(",").pop()]);
        if (g) { await sb.from("vcbe_venues").update({ lat: g.lat, lng: g.lng, updated_at: new Date().toISOString() }).eq("id", v.id); done++; } else fail.push(v.team);
      }
      return json({ ok: true, geocoded: done, failed: fail });
    }
    return json({ error: "unknown admin action" }, 400);
  }

  // ================= LOGIN =================
  if (action === "login") {
    const name = String(body.name || "").trim();
    if (!name) return json({ ok: false, reason: "no_name" });
    const { data: ref } = await sb.from("vcbe_referees").select("id,name").eq("active", true).ilike("name", name).maybeSingle();
    if (!ref) return json({ ok: false, reason: "no_name" });
    const { data: a } = await sb.from("vcbe_drive_access").select("*").eq("referee_id", ref.id).maybeSingle();
    if (S.require_code) {
      if (!a || !a.code) return json({ ok: false, reason: "no_code" });
      if (a.locked_until && new Date(a.locked_until).getTime() > Date.now()) return json({ ok: false, reason: "locked", minutes: Math.ceil((new Date(a.locked_until).getTime() - Date.now()) / 60000) });
      if (!a.active) return json({ ok: false, reason: "inactive" });
      const code = String(body.code || "").replace(/\D/g, "");
      if (code !== a.code) {
        const f = (a.failed_attempts || 0) + 1; const max = Math.max(1, S.max_attempts || 5);
        if (f >= max) {
          await sb.from("vcbe_drive_access").update({ failed_attempts: 0, locked_until: new Date(Date.now() + (S.lock_minutes || 15) * 60000).toISOString() }).eq("referee_id", ref.id);
          await sb.from("vcbe_drive_events").insert({ referee_id: ref.id, kind: "locked" });
          return json({ ok: false, reason: "locked", minutes: S.lock_minutes || 15 });
        }
        await sb.from("vcbe_drive_access").update({ failed_attempts: f }).eq("referee_id", ref.id);
        return json({ ok: false, reason: "wrong", left: max - f });
      }
    }
    const token = randHex(32);
    const days = body.keep === false ? 0.5 : Math.max(1, S.session_days || 30);
    const expires = new Date(Date.now() + days * 86400000).toISOString();
    await sb.from("vcbe_drive_sessions").insert({ token_hash: await sha256(token), referee_id: ref.id, expires_at: expires, last_seen_at: new Date().toISOString() });
    if (a) await sb.from("vcbe_drive_access").update({ failed_attempts: 0, locked_until: null, last_login_at: new Date().toISOString() }).eq("referee_id", ref.id);
    else await sb.from("vcbe_drive_access").upsert({ referee_id: ref.id, last_login_at: new Date().toISOString() });
    await sb.from("vcbe_drive_events").insert({ referee_id: ref.id, kind: "login" });
    return json({ ok: true, token, name: ref.name, expires_at: expires });
  }

  // ================= ACCESS REQUEST (09/11/2026, richiesta utente) =================
  // Bottone «Request access» sotto nome e codice: email di notifica all'admin con il nome di chi chiede.
  // Al massimo una richiesta ogni 30 minuti per lo stesso arbitro (registro vcbe_drive_events kind=access_request).
  if (action === "request_access") {
    const name = String(body.name || "").trim();
    if (!name) return json({ ok: false, reason: "no_name" });
    const { data: ref } = await sb.from("vcbe_referees").select("id,name").eq("active", true).ilike("name", name).maybeSingle();
    if (!ref) return json({ ok: false, reason: "no_name" });
    const { data: recent } = await sb.from("vcbe_drive_events").select("id").eq("referee_id", ref.id).eq("kind", "access_request").gt("created_at", new Date(Date.now() - 30 * 60000).toISOString()).limit(1);
    if (recent && recent.length) return json({ ok: true, already: true });
    const { data: a } = await sb.from("vcbe_drive_access").select("code,active,locked_until").eq("referee_id", ref.id).maybeSingle();
    const state = !a || !a.code ? "no code yet" : a.locked_until && new Date(a.locked_until).getTime() > Date.now() ? "locked after wrong codes" : !a.active ? "code set but not active" : "code active (forgot it?)";
    const note = String(body.note || "").replace(/[\r\n]+/g, " ").trim().slice(0, 300);
    const time = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Brussels", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date());
    const subject = `[VideoReferees] Drive access request – ${ref.name}`;
    const text = `${ref.name} asked for access to the Drive section on ${time}.\n\nCurrent status: ${state}.${note ? "\nMessage: " + note : ""}\n\nTo give access: open the app, Admin, «Drive access codes», set or generate the code for ${ref.name}, switch it On and use «Email code».\n\n${APP_URL}`;
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#222;max-width:640px"><p><b>${esc(ref.name)}</b> asked for access to the <b>Drive</b> section on ${esc(time)}.</p><p>Current status: <b>${esc(state)}</b>.</p>${note ? `<p>Message: ${esc(note)}</p>` : ""}<div style="background:#EAF0FE;border-radius:10px;padding:12px 16px;margin:10px 0">To give access: open the app → Admin → <b>Drive access codes</b>, set or generate the code for ${esc(ref.name)}, switch it <b>On</b> and use <b>Email code</b>.</div><p><a href="${APP_URL}" style="display:inline-block;background:#2563EB;color:#fff;text-decoration:none;font-weight:bold;padding:10px 16px;border-radius:10px">Open the app</a></p></div>`;
    const res = await sendMail({ to: ADMIN, subject, text, html });
    await sb.from("vcbe_drive_events").insert({ referee_id: ref.id, kind: "access_request", detail: { state, note: note || null, mail: res.ok } });
    return json({ ok: res.ok, sent: res.ok });
  }

  // ================= SESSION =================
  const token = String(body.token || "");
  if (!/^[0-9a-f]{64}$/.test(token)) return json({ ok: false, reason: "signed_out" }, 401);
  const th = await sha256(token);
  const { data: sess } = await sb.from("vcbe_drive_sessions").select("referee_id,expires_at").eq("token_hash", th).maybeSingle();
  if (!sess || new Date(sess.expires_at).getTime() < Date.now()) return json({ ok: false, reason: "signed_out" }, 401);
  const { data: me } = await sb.from("vcbe_referees").select("id,name,active").eq("id", sess.referee_id).maybeSingle();
  if (!me || !me.active) return json({ ok: false, reason: "signed_out" }, 401);
  if (S.require_code) {
    const { data: a } = await sb.from("vcbe_drive_access").select("active,code").eq("referee_id", me.id).maybeSingle();
    if (!a || !a.active || !a.code) { await sb.from("vcbe_drive_sessions").delete().eq("token_hash", th); return json({ ok: false, reason: "signed_out" }, 401); }
  }

  if (action === "logout") { await sb.from("vcbe_drive_sessions").delete().eq("token_hash", th); return json({ ok: true }); }

  if (action === "me") {
    sb.from("vcbe_drive_sessions").update({ last_seen_at: new Date().toISOString() }).eq("token_hash", th).then(() => {});
    const { data: ms } = await sb.from("vcbe_assignments").select("match_code,league,match_date,match_time,home_team,away_team,venue").eq("referee_id", me.id).gte("match_date", todayBrussels()).order("match_date").order("match_time").limit(8);
    const out: any[] = [];
    for (const m of ms || []) {
      const v = splitVenue(m.venue || "");
      const g = v.address ? await geocode(sb, [cleanAddr(v.address) + ", Belgium", (v.name ? v.name + ", " : "") + v.city + ", Belgium"]) : null;
      out.push({ ...m, venue_name: v.name, venue_city: v.city, address: v.address, lat: g?.lat ?? null, lng: g?.lng ?? null });
    }
    const { data: home } = await sb.from("vcbe_drive_home").select("label,lat,lng").eq("referee_id", me.id).maybeSingle();
    return json({ ok: true, id: me.id, name: me.name, matches: out, home: home || null, settings: { session_days: S.session_days } });
  }

  if (action === "venues") {
    const { data: vs } = await sb.from("vcbe_venues").select("team,gender,venue,address,lat,lng,sort_order").order("gender", { ascending: true }).order("sort_order");
    return json({ ok: true, venues: vs || [] });
  }

  if (action === "route") {
    const from = body.from, to = body.to, via = body.via;
    if (!okPt(from) || !okPt(to) || (via && !okPt(via))) return json({ error: "bad points" }, 400);
    const lang = ["en", "fr", "nl"].includes(body.lang) ? body.lang : "en";
    const locs = via ? [from, via, to] : [from, to];
    let routes: any[] = [], err = "";
    try { routes = await valhalla(locs, body.avoid || {}, lang, via ? 0 : 2); } catch (e) { err = String((e as Error).message || e); }
    if (!routes.length) {
      try { routes = await osrm(locs, lang, !via); } catch (e) { err += " · " + String((e as Error).message || e); }
    }
    if (!routes.length) return json({ ok: false, error: "no route", detail: err });
    return json({ ok: true, routes, avoid_applied: routes[0].engine === "valhalla" });
  }

  if (action === "search") {
    const q = String(body.q || "").trim().slice(0, 120);
    const TAGS: Record<string, string> = { parking: "amenity:parking", fuel: "amenity:fuel", cafe: "amenity:cafe" };
    const tag = TAGS[String(body.tag || "")] || "";
    if (!q && !tag) return json({ ok: true, results: [] });
    let extra = "&limit=8";
    if (okPt(body)) extra += `&lat=${num(body.lat)}&lon=${num(body.lng)}&location_bias_scale=0.5`;
    if (tag) extra += `&osm_tag=${encodeURIComponent(tag)}`;
    let res = await photon(q || String(body.tag), extra);
    if (!res.length && q) { const n = await nominatim(q, "&limit=6&countrycodes=be,nl,fr,lu,de"); res = (n || []).map((x: any) => ({ lat: Number(x.lat), lon: Number(x.lon), name: x.name || x.display_name, display_name: x.display_name })); }
    let results = res.filter((x: any) => Number.isFinite(x.lat)).map((x: any) => ({ name: String(x.name || x.display_name || "").slice(0, 80), label: String(x.display_name || "").slice(0, 160), lat: x.lat, lng: x.lon }));
    if (okPt(body)) { results.forEach((r: any) => r.km = Math.round(hav(num(body.lat), num(body.lng), r.lat, r.lng) * 10) / 10); results.sort((a: any, b: any) => a.km - b.km); if (tag) results = results.filter((r: any) => r.km <= 25); }
    return json({ ok: true, results: results.slice(0, 6) });
  }

  if (action === "reports") {
    const { data: rs } = await sb.from("vcbe_road_reports").select("id,kind,lat,lng,created_at,still_there,gone,referee_id").gt("expires_at", new Date().toISOString()).order("created_at", { ascending: false }).limit(300);
    const km = Math.min(300, Math.max(1, num(body.km) || 150));
    const list = (rs || []).filter((r: any) => !okPt(body) || hav(num(body.lat), num(body.lng), r.lat, r.lng) <= km).map((r: any) => ({ id: r.id, kind: r.kind, lat: r.lat, lng: r.lng, created_at: r.created_at, still_there: r.still_there, mine: r.referee_id === me.id }));
    return json({ ok: true, reports: list });
  }

  if (action === "report") {
    const kind = String(body.kind || "");
    if (!KINDS.includes(kind) || !okPt(body)) return json({ error: "bad report" }, 400);
    const la = num(body.lat), lo = num(body.lng);
    const { data: near } = await sb.from("vcbe_road_reports").select("id,lat,lng,still_there").eq("kind", kind).gt("expires_at", new Date().toISOString()).gt("created_at", new Date(Date.now() - 45 * 60000).toISOString());
    const dup = (near || []).find((r: any) => hav(la, lo, r.lat, r.lng) < 0.3);
    if (dup) { await sb.from("vcbe_road_reports").update({ still_there: (dup.still_there || 0) + 1, expires_at: new Date(Date.now() + 2 * 3600000).toISOString() }).eq("id", dup.id); return json({ ok: true, id: dup.id, merged: true }); }
    const { data, error } = await sb.from("vcbe_road_reports").insert({ kind, lat: la, lng: lo, referee_id: me.id }).select("id").single();
    return error ? json({ error: error.message }, 500) : json({ ok: true, id: data.id });
  }

  if (action === "report_vote") {
    const id = String(body.id || "");
    const { data: r } = await sb.from("vcbe_road_reports").select("still_there,gone").eq("id", id).maybeSingle();
    if (!r) return json({ ok: true });
    if (body.still) await sb.from("vcbe_road_reports").update({ still_there: (r.still_there || 0) + 1, expires_at: new Date(Date.now() + 2 * 3600000).toISOString() }).eq("id", id);
    else { const g = (r.gone || 0) + 1; const p: any = { gone: g }; if (g >= 2) p.expires_at = new Date().toISOString(); await sb.from("vcbe_road_reports").update(p).eq("id", id); }
    return json({ ok: true });
  }

  if (action === "arrived") {
    const venue = String(body.venue || "").slice(0, 200);
    await sb.from("vcbe_drive_events").insert({ referee_id: me.id, kind: "arrived", match_code: body.match_code ? String(body.match_code).slice(0, 20) : null, match_date: /^\d{4}-\d{2}-\d{2}$/.test(String(body.match_date || "")) ? body.match_date : null, venue, detail: okPt(body) ? { lat: num(body.lat), lng: num(body.lng) } : null });
    await sb.from("vcbe_drive_live").upsert({ referee_id: me.id, status: "arrived", venue: venue || null, eta: null, updated_at: new Date().toISOString(), ...(okPt(body) ? { lat: num(body.lat), lng: num(body.lng) } : {}) });
    const time = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Brussels", hour: "2-digit", minute: "2-digit" }).format(new Date());
    const subject = `[VideoReferees] Arrived – ${me.name} at ${venue || "the venue"}${body.match_code ? " (" + body.match_code + ")" : ""}`;
    const text = `${me.name} has arrived at ${venue || "the venue"} at ${time}${body.match_code ? " for match " + body.match_code : ""}.\n\nSent from the Drive section of Video Challenge BE.`;
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#222"><p><b>${esc(me.name)}</b> has arrived at <b>${esc(venue || "the venue")}</b> at ${esc(time)}${body.match_code ? " for match <b>" + esc(body.match_code) + "</b>" : ""}.</p><p style="color:#666;font-size:13px">Sent from the Drive section of Video Challenge BE.</p></div>`;
    const res = await sendMail({ to: ADMIN, subject, text, html });
    return json({ ok: true, notified: res.ok });
  }

  if (action === "event") {
    const kind = String(body.kind || "").slice(0, 30);
    if (!["drive_start", "drive_end", "share", "plan"].includes(kind)) return json({ ok: true });
    if (kind === "drive_end") await sb.from("vcbe_drive_live").delete().eq("referee_id", me.id).eq("status", "driving");
    await sb.from("vcbe_drive_events").insert({ referee_id: me.id, kind, match_code: body.match_code ? String(body.match_code).slice(0, 20) : null, venue: body.venue ? String(body.venue).slice(0, 200) : null });
    return json({ ok: true });
  }

  // ================= v3 (10/11/2026) =================
  if (action === "home_set") {
    const label = String(body.label || "").replace(/\s+/g, " ").trim().slice(0, 160);
    if (!label || !okPt(body)) return json({ ok: false, error: "bad home" }, 400);
    await sb.from("vcbe_drive_home").upsert({ referee_id: me.id, label, lat: num(body.lat), lng: num(body.lng), updated_at: new Date().toISOString() });
    return json({ ok: true, home: { label, lat: num(body.lat), lng: num(body.lng) } });
  }
  if (action === "reverse") {
    if (!okPt(body)) return json({ ok: false }, 400);
    try {
      const r = await fetch(`https://photon.komoot.io/reverse?lat=${num(body.lat)}&lon=${num(body.lng)}&limit=1&lang=en`, { headers: { "User-Agent": UA } });
      const j = r.ok ? await r.json() : {}; const p = (j.features || [])[0]?.properties || {};
      const label = [[p.street, p.housenumber].filter(Boolean).join(" ") || p.name, [p.postcode, p.city || p.town || p.village || p.district].filter(Boolean).join(" ")].filter(Boolean).join(", ");
      return json({ ok: true, label: label.slice(0, 160) });
    } catch (_) { return json({ ok: true, label: "" }); }
  }
  if (action === "home_clear") { await sb.from("vcbe_drive_home").delete().eq("referee_id", me.id); return json({ ok: true }); }

  if (action === "poi") {
    const kind = String(body.kind || "");
    const pts = (Array.isArray(body.points) ? body.points : [body]).filter(okPt).slice(0, 3).map((p: any) => ({ lat: num(p.lat), lng: num(p.lng) }));
    if (!POI[kind] || !pts.length) return json({ ok: false, error: "bad poi" }, 400);
    const r = await poiSearch(sb, kind, pts);
    return json({ ok: true, ...r });
  }

  if (action === "live_ping") {
    if (!okPt(body)) return json({ ok: false }, 400);
    const la = num(body.lat), lo = num(body.lng);
    const { data: cur } = await sb.from("vcbe_drive_live").select("status,zone,zone_lat,zone_lng,started_at,updated_at").eq("referee_id", me.id).maybeSingle();
    let zone = cur?.zone || "", zla = cur?.zone_lat, zlo = cur?.zone_lng;
    if (!zone || zla == null || hav(la, lo, zla, zlo) > 3) { const z = await reverseZone(la, lo); if (z) { zone = z; zla = la; zlo = lo; } }
    const fresh = !cur || cur.status !== "driving" || Date.now() - new Date(cur.updated_at).getTime() > 30 * 60000;
    const eta = body.eta && !isNaN(Date.parse(body.eta)) ? new Date(body.eta).toISOString() : null;
    await sb.from("vcbe_drive_live").upsert({ referee_id: me.id, status: "driving", lat: la, lng: lo, heading: Number.isFinite(num(body.heading)) ? num(body.heading) : null, speed: Number.isFinite(num(body.speed)) ? num(body.speed) : null,
      venue: body.venue ? String(body.venue).slice(0, 200) : null, eta, zone: zone || null, zone_lat: zla ?? null, zone_lng: zlo ?? null, started_at: fresh ? new Date().toISOString() : cur!.started_at, updated_at: new Date().toISOString() });
    return json({ ok: true, zone });
  }
  if (action === "live_stop") { await sb.from("vcbe_drive_live").delete().eq("referee_id", me.id).eq("status", "driving"); return json({ ok: true }); }
  if (action === "live_list") {
    const { data: rows } = await sb.from("vcbe_drive_live").select("referee_id,status,lat,lng,heading,speed,venue,eta,zone,started_at,updated_at").gt("updated_at", new Date(Date.now() - 5 * 3600000).toISOString());
    const ids = (rows || []).map((r: any) => r.referee_id);
    const { data: refs } = ids.length ? await sb.from("vcbe_referees").select("id,name").in("id", ids) : { data: [] };
    const nm: Record<string, string> = {}; (refs || []).forEach((r: any) => nm[r.id] = r.name);
    const now = Date.now();
    const list = (rows || []).filter((r: any) => r.status === "arrived" ? now - new Date(r.updated_at).getTime() < 4 * 3600000 : now - new Date(r.updated_at).getTime() < 15 * 60000)
      .map((r: any) => ({ id: r.referee_id, name: nm[r.referee_id] || "", me: r.referee_id === me.id, status: r.status,
        lat: r.lat != null ? Math.round(r.lat * 100) / 100 : null, lng: r.lng != null ? Math.round(r.lng * 100) / 100 : null,
        speed: r.status === "driving" && r.speed != null ? Math.round(r.speed) : null, venue: r.venue, eta: r.eta, zone: r.zone, since: r.status === "arrived" ? r.updated_at : r.started_at, updated_at: r.updated_at }))
      .sort((a: any, b: any) => (a.status === b.status ? 0 : a.status === "driving" ? -1 : 1) || a.name.localeCompare(b.name));
    return json({ ok: true, live: list });
  }

  if (action === "chat_convs") {
    const { data: refs } = await sb.from("vcbe_referees").select("id,name").eq("active", true).order("name");
    const { data: grp } = await sb.from("vcbe_drive_messages").select("id,sender_id,kind,body,created_at").is("to_id", null).order("created_at", { ascending: false }).limit(1);
    const { data: dms } = await sb.from("vcbe_drive_messages").select("id,sender_id,to_id,kind,body,created_at").or(`sender_id.eq.${me.id},to_id.eq.${me.id}`).not("to_id", "is", null).order("created_at", { ascending: false }).limit(500);
    const nm: Record<string, string> = {}; (refs || []).forEach((r: any) => nm[r.id] = r.name);
    const conv: Record<string, any> = {};
    for (const m of dms || []) { const other = m.sender_id === me.id ? m.to_id : m.sender_id; if (!conv[other]) conv[other] = { id: other, name: nm[other] || "", last: m, last_at: m.created_at }; if (m.sender_id !== me.id) conv[other].last_in = conv[other].last_in || m.created_at; }
    const g = (grp || [])[0];
    const prev = (m: any) => m ? { kind: m.kind, body: m.kind === "text" ? String(m.body || "").slice(0, 90) : "", from: nm[m.sender_id] || "", mine: m.sender_id === me.id } : null;
    // per i non letti: ultimo messaggio ricevuto (non mio) del gruppo
    const { data: gin } = await sb.from("vcbe_drive_messages").select("created_at").is("to_id", null).neq("sender_id", me.id).order("created_at", { ascending: false }).limit(1);
    return json({ ok: true, me: me.id,
      convs: [{ id: "all", group: true, last: prev(g), last_at: g?.created_at || null, last_in: gin?.[0]?.created_at || null },
        ...Object.values(conv).map((c: any) => ({ id: c.id, name: c.name, last: prev(c.last), last_at: c.last_at, last_in: c.last_in || null }))],
      referees: (refs || []).filter((r: any) => r.id !== me.id).map((r: any) => ({ id: r.id, name: r.name })) });
  }
  if (action === "chat_list") {
    const conv = String(body.conv || "all");
    let q = sb.from("vcbe_drive_messages").select("id,sender_id,to_id,kind,body,media_path,media_type,duration_s,created_at").order("created_at", { ascending: false }).limit(60);
    if (conv === "all") q = q.is("to_id", null);
    else if (/^[0-9a-f-]{36}$/.test(conv)) q = q.or(`and(sender_id.eq.${me.id},to_id.eq.${conv}),and(sender_id.eq.${conv},to_id.eq.${me.id})`);
    else return json({ ok: false, error: "bad conv" }, 400);
    if (body.before && !isNaN(Date.parse(body.before))) q = q.lt("created_at", new Date(body.before).toISOString());
    if (body.after && !isNaN(Date.parse(body.after))) q = q.gt("created_at", new Date(body.after).toISOString());
    const { data: ms, error } = await q; if (error) return json({ ok: false, error: error.message }, 500);
    const ids = [...new Set((ms || []).map((m: any) => m.sender_id))];
    const { data: refs } = ids.length ? await sb.from("vcbe_referees").select("id,name").in("id", ids) : { data: [] };
    const nm: Record<string, string> = {}; (refs || []).forEach((r: any) => nm[r.id] = r.name);
    const paths = (ms || []).filter((m: any) => m.media_path).map((m: any) => m.media_path);
    const urls: Record<string, string> = {};
    if (paths.length) { const { data: su } = await sb.storage.from(CHAT_BUCKET).createSignedUrls(paths, 3600); (su || []).forEach((u: any) => { if (u.signedUrl) urls[u.path] = u.signedUrl; }); }
    const out = (ms || []).reverse().map((m: any) => ({ id: m.id, from: m.sender_id, name: nm[m.sender_id] || "", mine: m.sender_id === me.id, kind: m.kind, body: m.body, url: m.media_path ? urls[m.media_path] || null : null, type: m.media_type, duration: m.duration_s, at: m.created_at }));
    return json({ ok: true, messages: out });
  }
  if (action === "chat_send") {
    const conv = String(body.conv || "all"); const kind = String(body.kind || "text");
    if (!["text", "photo", "audio"].includes(kind)) return json({ ok: false, error: "bad kind" }, 400);
    let to: string | null = null;
    if (conv !== "all") { if (!/^[0-9a-f-]{36}$/.test(conv) || conv === me.id) return json({ ok: false, error: "bad conv" }, 400);
      const { data: r } = await sb.from("vcbe_referees").select("id").eq("id", conv).eq("active", true).maybeSingle(); if (!r) return json({ ok: false, error: "bad conv" }, 400); to = conv; }
    const text = String(body.body || "").slice(0, 2000).trim();
    let path: string | null = null, type: string | null = null;
    if (kind === "text") { if (!text) return json({ ok: false, error: "empty" }, 400); }
    else {
      type = String(body.content_type || "").split(";")[0].trim().toLowerCase();
      if (kind === "photo" && !type.startsWith("image/")) return json({ ok: false, error: "bad type" }, 400);
      if (kind === "audio" && !type.startsWith("audio/")) return json({ ok: false, error: "bad type" }, 400);
      const ext = CHAT_TYPES[type]; if (!ext) return json({ ok: false, error: "type not allowed: " + type }, 400);
      const bytes = b64bytes(String(body.file_base64 || "")); if (!bytes.length || bytes.length > 8 * 1024 * 1024) return json({ ok: false, error: "file too large" }, 400);
      path = `${to ? "dm" : "all"}/${new Date().toISOString().slice(0, 10)}/${me.id.slice(0, 8)}-${randHex(8)}.${ext}`;
      const up = await sb.storage.from(CHAT_BUCKET).upload(path, bytes, { contentType: type, upsert: false });
      if (up.error) return json({ ok: false, error: up.error.message }, 500);
    }
    const dur = Number.isFinite(num(body.duration)) ? Math.min(600, Math.max(0, num(body.duration))) : null;
    const { data, error } = await sb.from("vcbe_drive_messages").insert({ sender_id: me.id, to_id: to, kind, body: text || null, media_path: path, media_type: type, duration_s: kind === "audio" ? dur : null }).select("id,created_at").single();
    if (error) return json({ ok: false, error: error.message }, 500);
    return json({ ok: true, id: data.id, at: data.created_at });
  }

  return json({ error: "unknown action" }, 400);
});
