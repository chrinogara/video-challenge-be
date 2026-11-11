// Edge function vcbe-stats (11/11/2026, richiesta utente): visite dell'app e presenze in tempo reale.
// Pubblica (verify_jwt false). Dati raccolti SOLO anonimi: id casuale del browser (localStorage), id della visita,
// sezione aperta, tipo di dispositivo (phone/tablet/desktop), lingua dell'app. Nessun user agent.
// v4 (11/11/2026, seconda richiesta utente): paese, regione e città ricavati dall'IP (header cf-connecting-ip) una volta
// per visita con un servizio di geolocalizzazione gratuito (ipwho.is, ripieghi ipapi.co e api.country.is).
// L'IP NON viene salvato da nessuna parte: si salvano solo paese/regione/città.
// Il nome compare solo per gli arbitri collegati a Drive: il token di Drive viene confrontato (hash SHA-256)
// con vcbe_drive_sessions, come in vcbe-drive.
// Azioni:
//   ping  {vid, sid, page, views:[sezioni], acts:[azioni], errs:[errori], lang, device, token?}  -> presenza + eventi
//   leave {sid}                                                                                 -> visita chiusa
//   adm_stats {password, days}  (password admin da vcbe_admin_config)                           -> vcbe_app_stats(days)
//   adm_reset {password}                                                                        -> cancella tutte le statistiche
// Tabelle: vcbe_app_visitors, vcbe_app_presence, vcbe_app_events (RLS senza policy). SQL in docs/vcbe-stats.sql.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST,OPTIONS" };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "");
const ID = /^[A-Za-z0-9_-]{8,64}$/;
const NAME = /^[a-z0-9_:.\-]{1,48}$/;
const DEVICES = ["phone", "tablet", "desktop"];
const LANGS = ["en", "fr", "nl"];

async function sha256(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
async function refereeOf(token: unknown): Promise<string | null> {
  const t = String(token || "");
  if (t.length < 16 || t.length > 200) return null;
  const { data } = await sb.from("vcbe_drive_sessions").select("referee_id,expires_at").eq("token_hash", await sha256(t)).maybeSingle();
  if (!data || new Date(data.expires_at).getTime() < Date.now()) return null;
  return data.referee_id || null;
}
type Geo = { country: string | null; country_name: string | null; region: string | null; city: string | null };
const GEO_CACHE = new Map<string, Geo>();
const NOGEO: Geo = { country: null, country_name: null, region: null, city: null };
const clip = (v: unknown, n = 60) => { const t = String(v ?? "").trim(); return t ? t.slice(0, n) : null; };
async function getJson(url: string): Promise<any> {
  const r = await fetch(url, { signal: AbortSignal.timeout(2500), headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(String(r.status));
  return await r.json();
}
function clientIp(req: Request): string {
  const ip = req.headers.get("cf-connecting-ip") || req.headers.get("sb-forwarded-for") || (req.headers.get("x-forwarded-for") || "").split(",")[0];
  return String(ip || "").trim();
}
function isPrivate(ip: string) {
  return !ip || /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|f[cd]|fe80)/i.test(ip);
}
async function geoOf(ip: string): Promise<Geo> {
  if (isPrivate(ip) || !/^[0-9a-f:.]{3,45}$/i.test(ip)) return NOGEO;
  const hit = GEO_CACHE.get(ip); if (hit) return hit;
  let g: Geo = NOGEO;
  try {
    const j = await getJson(`https://ipwho.is/${ip}?fields=success,country,country_code,region,city`);
    if (j && j.success !== false && j.country_code) g = { country: String(j.country_code).slice(0, 2).toUpperCase(), country_name: clip(j.country), region: clip(j.region), city: clip(j.city) };
  } catch { /* next */ }
  if (!g.country) try {
    const j = await getJson(`https://ipapi.co/${ip}/json/`);
    if (j && !j.error && j.country_code) g = { country: String(j.country_code).slice(0, 2).toUpperCase(), country_name: clip(j.country_name), region: clip(j.region), city: clip(j.city) };
  } catch { /* next */ }
  if (!g.country) try {
    const j = await getJson(`https://api.country.is/${ip}`);
    if (j && j.country) g = { country: String(j.country).slice(0, 2).toUpperCase(), country_name: null, region: null, city: null };
  } catch { /* none */ }
  if (g.country && !g.country_name) { try { g = { ...g, country_name: new Intl.DisplayNames(["en"], { type: "region" }).of(g.country) || null }; } catch { /* */ } }
  if (GEO_CACHE.size > 1000) GEO_CACHE.clear();
  if (g.country) GEO_CACHE.set(ip, g);
  return g;
}
const list = (v: unknown, re: RegExp | null, max: number, len: number) =>
  (Array.isArray(v) ? v : []).slice(0, max).map((x) => String(x ?? "").trim().slice(0, len)).filter((x) => x && (!re || re.test(x)));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let body: any = {};
  try { body = await req.json(); } catch { /* sendBeacon sends text */ }
  const action = String(body.action || "");

  if (action === "adm_stats" || action === "adm_reset") {
    let pw = "";
    try { const { data } = await sb.from("vcbe_admin_config").select("value").eq("key", "admin_password").single(); pw = String(data?.value || "").trim(); } catch { /* */ }
    if (!pw || String(body.password || "").trim() !== pw) return json({ error: "unauthorized" }, 401);
    if (action === "adm_reset") {
      const a = await sb.from("vcbe_app_events").delete().gt("id", 0);
      const b = await sb.from("vcbe_app_presence").delete().neq("session_id", "");
      const c = await sb.from("vcbe_app_visitors").delete().neq("visitor_id", "");
      const err = a.error || b.error || c.error;
      return json(err ? { error: err.message } : { ok: true });
    }
    const days = [0, 1, 7, 30].includes(Number(body.days)) ? Number(body.days) : 7;
    const { data, error } = await sb.rpc("vcbe_app_stats", { p_days: days });
    return json(error ? { error: error.message } : { ok: true, days, stats: data });
  }

  const sid = String(body.sid || "");
  if (!ID.test(sid)) return json({ error: "bad sid" }, 400);
  if (action === "leave") {
    await sb.from("vcbe_app_presence").delete().eq("session_id", sid);
    return json({ ok: true });
  }
  if (action !== "ping") return json({ error: "unknown action" }, 400);
  const vid = String(body.vid || "");
  if (!ID.test(vid)) return json({ error: "bad vid" }, 400);
  const page = NAME.test(String(body.page || "")) ? String(body.page) : null;
  const device = DEVICES.includes(String(body.device)) ? String(body.device) : null;
  const lang = LANGS.includes(String(body.lang)) ? String(body.lang) : null;
  const ref = await refereeOf(body.token);
  const now = new Date().toISOString();

  const { data: pres } = await sb.from("vcbe_app_presence").select("session_id,country,country_name,region,city").eq("session_id", sid).maybeSingle();
  // paese/città: una sola ricerca per visita; l'IP resta in memoria solo per questa richiesta
  const geo: Geo = pres?.country ? { country: pres.country, country_name: pres.country_name, region: pres.region, city: pres.city } : await geoOf(clientIp(req));
  const { data: vis } = await sb.from("vcbe_app_visitors").select("visitor_id,sessions,referee_id").eq("visitor_id", vid).maybeSingle();
  if (!vis) {
    await sb.from("vcbe_app_visitors").insert({ visitor_id: vid, first_seen: now, last_seen: now, referee_id: ref, device, lang, sessions: 1, ...geo });
  } else {
    const up: Record<string, unknown> = { last_seen: now };
    if (ref) up.referee_id = ref;
    if (device) up.device = device;
    if (lang) up.lang = lang;
    if (!pres) up.sessions = (vis.sessions || 0) + 1;
    if (geo.country) Object.assign(up, geo);
    await sb.from("vcbe_app_visitors").update(up).eq("visitor_id", vid);
  }
  const rid = ref || vis?.referee_id || null;
  if (pres) await sb.from("vcbe_app_presence").update({ last_seen: now, page, referee_id: rid, device, lang, ...(geo.country ? geo : {}) }).eq("session_id", sid);
  else await sb.from("vcbe_app_presence").insert({ session_id: sid, visitor_id: vid, referee_id: rid, page, device, lang, started_at: now, last_seen: now, ...geo });

  const ev = [
    ...list(body.views, NAME, 20, 48).map((name) => ({ kind: "view", name })),
    ...list(body.acts, NAME, 20, 48).map((name) => ({ kind: "action", name })),
    ...list(body.errs, null, 5, 160).map((name) => ({ kind: "error", name })),
  ].map((e) => ({ ...e, visitor_id: vid, session_id: sid, referee_id: rid, created_at: now, ...geo }));
  if (ev.length) await sb.from("vcbe_app_events").insert(ev);

  if (Math.random() < 0.05) await sb.from("vcbe_app_presence").delete().lt("last_seen", new Date(Date.now() - 86400000).toISOString());
  return json({ ok: true });
});
