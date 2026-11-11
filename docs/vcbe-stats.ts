// Edge function vcbe-stats (11/11/2026, richiesta utente): visite dell'app e presenze in tempo reale.
// Pubblica (verify_jwt false). Dati raccolti SOLO anonimi: id casuale del browser (localStorage), id della visita,
// sezione aperta, tipo di dispositivo (phone/tablet/desktop), lingua dell'app. Nessun IP, nessun user agent.
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

  const { data: pres } = await sb.from("vcbe_app_presence").select("session_id").eq("session_id", sid).maybeSingle();
  const { data: vis } = await sb.from("vcbe_app_visitors").select("visitor_id,sessions,referee_id").eq("visitor_id", vid).maybeSingle();
  if (!vis) {
    await sb.from("vcbe_app_visitors").insert({ visitor_id: vid, first_seen: now, last_seen: now, referee_id: ref, device, lang, sessions: 1 });
  } else {
    const up: Record<string, unknown> = { last_seen: now };
    if (ref) up.referee_id = ref;
    if (device) up.device = device;
    if (lang) up.lang = lang;
    if (!pres) up.sessions = (vis.sessions || 0) + 1;
    await sb.from("vcbe_app_visitors").update(up).eq("visitor_id", vid);
  }
  const rid = ref || vis?.referee_id || null;
  if (pres) await sb.from("vcbe_app_presence").update({ last_seen: now, page, referee_id: rid, device, lang }).eq("session_id", sid);
  else await sb.from("vcbe_app_presence").insert({ session_id: sid, visitor_id: vid, referee_id: rid, page, device, lang, started_at: now, last_seen: now });

  const ev = [
    ...list(body.views, NAME, 20, 48).map((name) => ({ kind: "view", name })),
    ...list(body.acts, NAME, 20, 48).map((name) => ({ kind: "action", name })),
    ...list(body.errs, null, 5, 160).map((name) => ({ kind: "error", name })),
  ].map((e) => ({ ...e, visitor_id: vid, session_id: sid, referee_id: rid, created_at: now }));
  if (ev.length) await sb.from("vcbe_app_events").insert(ev);

  if (Math.random() < 0.05) await sb.from("vcbe_app_presence").delete().lt("last_seen", new Date(Date.now() - 86400000).toISOString());
  return json({ ok: true });
});
