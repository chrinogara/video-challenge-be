// vcbe-match-deleted - Video Challenge BE (v1, 02/11/2026, richiesta utente)
// Il modulo di fine gara chiede «Match correctly deleted from the system?». Se l'arbitro risponde No, la partita
// PRECEDENTE nella stessa sala non e' stata cancellata: il trigger vcbe_reports_track_issues chiama questa funzione,
// che trova il Video Referee della gara precedente nella stessa sala (SQL vcbe_prev_match_for_report, sulle
// designazioni caricate in vcbe_assignments) e gli scrive in inglese da cnogara25 (Apps Script "send"), CC admin.
// Registro vcbe_deletion_notices (una riga per modulo, niente doppioni). Se l'arbitro precedente non si trova,
// e' lo stesso arbitro o non ha email: avviso solo all'admin.
// Body: {password, action:"match_not_deleted", report_id, dry_run?, test?, recipient?}
//   dry_run: nessun invio, restituisce testo e destinatario.  test: email [TEST] a recipient (default admin), nessuna registrazione.
// Richiede la password admin (vcbe_admin_config). Segreti: DRIVE_HOOK_SECRET (Apps Script), RESEND_API_KEY (ripiego).
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

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const fmtDate = (iso: string | null | undefined) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || "")); return m ? `${m[3]}/${m[2]}/${m[1]}` : String(iso || "-"); };
const weekday = (iso: string) => { try { return new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone: "UTC" }).format(new Date(iso + "T12:00:00Z")); } catch (_) { return ""; } };
const venueShort = (v: string | null | undefined) => String(v || "").split(",").slice(0, 2).map(s => s.trim()).filter(Boolean).join(", ");
const titleCase = (s: string) => String(s || "").toLowerCase().replace(/(^|[\s'-])(\S)/g, (_m, p, c) => p + c.toUpperCase());

type Cand = Record<string, any>;
type Mail = { to: string; cc?: string; subject: string; html: string; text: string };

// ---------- invio email: Apps Script (da cnogara25) -> ripiego Resend ----------
async function sendMail(m: Mail): Promise<{ ok: boolean; channel: string; status: string; detail: string }> {
  let hookErr = "";
  if (HOOK_URL && HOOK_SECRET) {
    try {
      const r = await fetch(HOOK_URL, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ action: "send", secret: HOOK_SECRET, ...m }), redirect: "follow" });
      const txt = await r.text();
      let j: any = null; try { j = JSON.parse(txt); } catch (_) { /* */ }
      if (j && j.ok) return { ok: true, channel: "apps_script", status: "sent", detail: String(j.from || "") };
      hookErr = (j && j.error) ? String(j.error) : `http ${r.status}`;
    } catch (e) { hookErr = String((e as Error)?.message ?? e); }
  } else hookErr = "DRIVE_HOOK_SECRET not set";
  if (RESEND_KEY) {
    const body: Record<string, unknown> = { from: FROM, to: [m.to], subject: m.subject, html: m.html, text: m.text };
    if (m.cc && m.cc.toLowerCase() !== m.to.toLowerCase()) body.cc = [m.cc];
    const r = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (r.ok) return { ok: true, channel: "resend", status: "sent", detail: `apps_script: ${hookErr}` };
    const t = await r.text();
    const blocked = r.status === 403 && /own email address|verify a domain/i.test(t);
    return { ok: false, channel: "resend", status: blocked ? "blocked_test_mode" : "failed", detail: `apps_script: ${hookErr} · resend ${r.status}: ${t.slice(0, 300)}` };
  }
  return { ok: false, channel: "none", status: "failed", detail: hookErr || "no email channel configured" };
}

// ---------- email al Video Referee della gara precedente ----------
function buildNotDeleted(refName: string, prev: Cand, cur: Cand | null, info: Cand, isTest: boolean) {
  const venue = venueShort(prev.venue) || prev.home_team || "the venue";
  const prevLine = `${weekday(prev.match_date)} ${fmtDate(prev.match_date)}${prev.match_time ? ", " + prev.match_time : ""} – ${prev.home_team || "home team"} vs ${prev.away_team || "away team"}${prev.match_code ? ", " + prev.match_code : ""}`;
  const nextDate = cur?.match_date || info.match_date;
  const nextLine = cur ? `${weekday(cur.match_date)} ${fmtDate(cur.match_date)}${cur.match_time ? ", " + cur.match_time : ""} – ${cur.home_team || "home team"} vs ${cur.away_team || "away team"}` : `${weekday(nextDate)} ${fmtDate(nextDate)} – ${info.host_team || "home team"}`;
  const subject = (isTest ? "[TEST] " : "") + `Video Challenge BE – Match not deleted from the system at ${venue}`;
  const intro = `According to the official designations, you were the Video Referee for this match:`;
  const found = `The Video Referee of the next match at the same venue reported that, when they arrived, your match had not been deleted from the Video Challenge system:`;
  const ask = `At the end of every match, please make sure the match is correctly deleted from the Video Challenge system before you leave the sports hall. This is important: a match that is not deleted can cause problems for the next match at this venue and for the Video Referee who works there.`;
  const text = (isTest ? "THIS IS A TEST MESSAGE – example only, no action is needed.\n\n" : "") +
    `Dear ${refName},\n\n${intro}\n- ${prevLine}\n  Venue: ${venue}\n\n${found}\n- Next match: ${nextLine}\n\nIt seems the match was not deleted at the end. ${ask}\n\nThank you for your cooperation,\nVideo Challenge BE`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#222;max-width:640px">` +
    (isTest ? `<div style="background:#fff3cd;border:1px solid #f0c36d;padding:10px 14px;border-radius:6px;margin-bottom:16px"><b>THIS IS A TEST MESSAGE</b> – example only, no action is needed.</div>` : "") +
    `<p>Dear ${esc(refName)},</p><p>${esc(intro)}</p><ul><li><b>${esc(prevLine)}</b><br><span style="color:#555">Venue: ${esc(venue)}</span></li></ul>` +
    `<p>${esc(found)}</p><ul><li>Next match: ${esc(nextLine)}</li></ul>` +
    `<div style="background:#FEF2F2;border:1.5px solid #FCA5A5;border-radius:8px;padding:12px 16px;margin:10px 0"><b style="color:#991B1B">It seems the match was not deleted at the end.</b><br>${esc(ask)}</div>` +
    `<p>Thank you for your cooperation,<br>Video Challenge BE</p></div>`;
  return { subject, text, html };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let body: any = {};
  try { body = await req.json(); } catch (_) { /* */ }
  const sb = createClient(SB_URL, getServiceKey(), { auth: { persistSession: false } });
  const { data: cfg } = await sb.from("vcbe_admin_config").select("value").eq("key", "admin_password").maybeSingle();
  const pw = String(cfg?.value ?? "").trim();
  if (!pw || String(body.password || "").trim() !== pw) return json({ error: "unauthorized" }, 401);
  const action = String(body.action || "match_not_deleted");
  try {
    if (action === "match_not_deleted") {
      const reportId = String(body.report_id || "").trim();
      if (!reportId) return json({ ok: false, error: "report_id required" }, 400);
      const isTest = body.test === true; const dry = body.dry_run === true;
      const { data: info, error: e1 } = await sb.rpc("vcbe_prev_match_for_report", { p_report_id: reportId });
      if (e1) throw new Error(e1.message);
      const { data: rep } = await sb.from("vcbe_reports").select("id,referee_name,match_date,host_team,match_deleted,created_at").eq("id", reportId).maybeSingle();
      if (!rep) return json({ ok: false, error: "report not found" }, 404);
      if (rep.match_deleted !== false && !isTest && !dry) return json({ ok: true, skipped: "match_deleted is not No" });
      if (!isTest && !dry) {
        const { data: done } = await sb.from("vcbe_deletion_notices").select("id,outcome").eq("report_id", reportId).maybeSingle();
        if (done) return json({ ok: true, skipped: "already handled", outcome: done.outcome });
      }
      const prev: Cand | null = info?.previous || null; const cur: Cand | null = info?.current || null;
      const prevName = String(info?.prev_referee_name || "").trim(); const prevEmail = String(info?.prev_referee_email || "").trim();
      let outcome = "sent"; let reason = "";
      if (!prev) { outcome = "no_previous_match"; reason = String(info?.error || "no previous match at this venue in the loaded designations"); }
      else if (info?.same_referee) { outcome = "same_referee"; reason = "the previous match at this venue had the same Video Referee"; }
      else if (!prevEmail) { outcome = "no_email"; reason = `no email address for ${prevName || "the previous Video Referee"} in the referee list`; }
      const mail = prev ? buildNotDeleted(titleCase(prevName || "Video Referee"), prev, cur, info, isTest) : null;
      if (dry) return json({ ok: true, dry_run: true, outcome, reason, info, to: prevEmail || null, subject: mail?.subject, text: mail?.text });
      let res: { ok: boolean; channel: string; status: string; detail: string } | null = null;
      if (outcome === "sent" && mail) {
        const to = isTest ? String(body.recipient || ADMIN).trim() : prevEmail;
        res = await sendMail({ to, cc: ADMIN, subject: mail.subject, html: mail.html, text: mail.text });
        if (!res.ok) { outcome = "failed"; reason = res.detail; }
      }
      if (outcome !== "sent") {
        // nessun arbitro avvisato: l'admin riceve i dati per intervenire a mano
        const subj = (isTest ? "[TEST] " : "") + `[VideoReferees] Match not deleted – previous Video Referee NOT notified (${rep.host_team || "?"}, ${fmtDate(rep.match_date)})`;
        const lines = [
          `${rep.referee_name || "A Video Referee"} answered No to "Match correctly deleted from the system?" for the match of ${fmtDate(rep.match_date)} at ${rep.host_team || "?"}.`,
          `The automatic email to the Video Referee of the previous match was NOT sent: ${reason}.`,
          prev ? `Previous match found: ${prev.match_code || ""} ${fmtDate(prev.match_date)} ${prev.match_time || ""} – ${prev.home_team || ""} vs ${prev.away_team || ""}, Video Referee ${prevName || prev.video_referee || "?"}.` : `Only matches loaded from the designations ("Aanduidingen") are checked.`,
        ];
        const r2 = await sendMail({ to: isTest ? String(body.recipient || ADMIN).trim() : ADMIN, subject: subj, text: lines.join("\n\n"), html: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#222;max-width:640px">` + lines.map(l => `<p>${esc(l)}</p>`).join("") + `</div>` });
        res = res || r2;
      }
      if (!isTest) {
        await sb.from("vcbe_deletion_notices").upsert({
          report_id: reportId, reported_by: rep.referee_name, report_match_date: rep.match_date, report_host_team: rep.host_team,
          prev_match_code: prev?.match_code || null, prev_match_date: prev?.match_date || null, prev_referee_name: prevName || null, prev_referee_email: prevEmail || null,
          outcome, channel: res?.channel || null, detail: (reason || res?.detail || "").slice(0, 500),
        }, { onConflict: "report_id" });
      }
      return json({ ok: true, test: isTest, outcome, reason, previous: prev ? { code: prev.match_code, date: prev.match_date, referee: prevName, email: prevEmail } : null, sent: res, subject: mail?.subject });
    }

    return json({ error: "unknown action" }, 400);
  } catch (e) {
    console.error(e);
    return json({ ok: false, error: String((e as Error)?.message ?? e) }, 500);
  }
});
