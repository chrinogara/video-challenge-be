// Edge function vcbe-quiz (v1, 16/11/2026, richiesta utente): sezione «Quiz» dell'app.
// Ogni domanda ha un video, una foto o una situazione scritta, una domanda e la risposta giusta Sì/No.
// Accesso arbitri: stesso nome + codice personale di Drive (login con vcbe-drive, stesso token vcbe_drive_sessions).
// Una sola risposta per arbitro e domanda (non modificabile). La risposta giusta non viene mai inviata prima della risposta.
//   summary {}                      -> {count, recent:[created_at ultimi 7 giorni]} (pubblico, per il riquadro Home)
//   list {token}                    -> domande pubblicate + mie risposte (con esito e spiegazione per quelle già risposte)
//   answer {token, item_id, answer} -> salva la risposta, restituisce correct, explanation
// Admin (password di vcbe_admin_config):
//   adm_list -> items, referees (con conteggi), answers
//   adm_upload_url {kind photo|video, ext} ; adm_add {...} ; adm_update {id, ...} ; adm_reorder {ids} ; adm_delete {id}
//   adm_reset {referee_id?, item_id?} (cancella risposte)
// Codice sorgente: docs/vcbe-quiz.ts del repo chrinogara/video-challenge-be.
// Tabelle vcbe_quiz_items, vcbe_quiz_answers (RLS senza policy), bucket pubblico vcbe-quiz. Migration vcbe_quiz_20261116.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST,OPTIONS" };
const SB_URL = Deno.env.get("SUPABASE_URL")!;
function getServiceKey(): string {
  const direct = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (direct) return direct;
  try { const d = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}"); return d.secret ?? d.service_role ?? (Object.values(d)[0] as string) ?? ""; } catch (_) { return ""; }
}
const BUCKET = "vcbe-quiz";
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const sha256 = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))).map((b) => b.toString(16).padStart(2, "0")).join("");
const randHex = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n))).map((b) => b.toString(16).padStart(2, "0")).join("");
const str = (v: any, max: number) => { const s = String(v ?? "").trim().slice(0, max); return s || null; };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const httpUrl = (v: any) => { const s = String(v ?? "").trim().slice(0, 1500); return /^https?:\/\/[^\s<>"]+$/i.test(s) ? s : null; };
const OUR = /^(photos|videos)\/[\w.-]+\.[a-z0-9]{2,5}$/;
const EXT: Record<string, string[]> = { photo: ["jpg", "jpeg", "png", "webp"], video: ["mp4", "m4v", "mov", "webm"] };
const FIELDS: Record<string, number> = { title: 200, situation: 6000, question: 1000, explanation: 6000 };
const pub = (it: any) => ({ id: it.id, kind: it.kind, title: it.title || "", situation: it.situation || "", question: it.question, media_url: it.media_url || "", sort_order: it.sort_order, created_at: it.created_at });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let body: any = {}; try { body = await req.json(); } catch { /* empty */ }
  const sb = createClient(SB_URL, getServiceKey(), { auth: { persistSession: false } });
  const action = String(body.action || "");
  const pubUrl = (p: string) => sb.storage.from(BUCKET).getPublicUrl(p).data.publicUrl;

  // ================= ADMIN =================
  if (action.startsWith("adm_")) {
    const { data: cfg } = await sb.from("vcbe_admin_config").select("value").eq("key", "admin_password").maybeSingle();
    const pw = String(cfg?.value || "").trim();
    if (!pw || String(body.password || "").trim() !== pw) return json({ error: "unauthorized" }, 401);
    const fields = () => {
      const row: any = {};
      for (const k in FIELDS) if (k in body) row[k] = str(body[k], FIELDS[k]);
      if ("kind" in body) row.kind = ["video", "photo", "text"].includes(body.kind) ? body.kind : "text";
      if ("correct" in body) row.correct = body.correct === true || body.correct === "yes";
      if ("published" in body) row.published = !!body.published;
      if ("sort_order" in body) row.sort_order = Number(body.sort_order) || 0;
      if ("media_url" in body) { row.media_url = httpUrl(body.media_url); row.media_path = null; }
      if ("media_path" in body) { const sp = String(body.media_path || ""); if (OUR.test(sp)) { row.media_path = sp; row.media_url = pubUrl(sp); } }
      return row;
    };
    if (action === "adm_list") {
      const [{ data: items, error }, { data: ans }, { data: refs }, { data: acc }] = await Promise.all([
        sb.from("vcbe_quiz_items").select("*").order("sort_order").order("created_at", { ascending: false }),
        sb.from("vcbe_quiz_answers").select("id,item_id,referee_id,answer,is_correct,created_at").order("created_at", { ascending: false }).limit(20000),
        sb.from("vcbe_referees").select("id,name,email,active,sort_order").order("sort_order", { nullsFirst: false }).order("name"),
        sb.from("vcbe_drive_access").select("referee_id,code,active"),
      ]);
      if (error) return json({ error: error.message });
      const hasCode: Record<string, boolean> = {}; (acc || []).forEach((a: any) => hasCode[a.referee_id] = !!(a.code && a.active));
      const st: Record<string, any> = {};
      (ans || []).forEach((a: any) => { const s = st[a.referee_id] ||= { answered: 0, correct: 0, wrong: 0, last_at: null }; s.answered++; a.is_correct ? s.correct++ : s.wrong++; if (!s.last_at || a.created_at > s.last_at) s.last_at = a.created_at; });
      const referees = (refs || []).filter((r: any) => r.active !== false || st[r.id]).map((r: any) => ({ id: r.id, name: r.name, email: r.email || "", has_code: !!hasCode[r.id], ...(st[r.id] || { answered: 0, correct: 0, wrong: 0, last_at: null }) }));
      return json({ ok: true, items: items || [], answers: ans || [], referees });
    }
    if (action === "adm_upload_url") {
      const kind = body.kind === "video" ? "video" : "photo";
      let ext = String(body.ext || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      if (ext === "jpeg") ext = "jpg";
      if (!EXT[kind].includes(ext)) return json({ error: "bad_file_type" });
      const path = `${kind}s/${new Date().toISOString().slice(0, 10)}-${randHex(8)}.${ext}`;
      const { data, error } = await sb.storage.from(BUCKET).createSignedUploadUrl(path);
      if (error || !data) return json({ error: error?.message || "no url" });
      return json({ ok: true, path, upload_token: data.token });
    }
    if (action === "adm_add") {
      const row = fields();
      if (!row.question) return json({ error: "question_required" });
      if (!("correct" in row)) return json({ error: "correct_required" });
      if (row.kind !== "text" && !row.media_url) return json({ error: "media_required" });
      if (!("sort_order" in row)) {
        const { data: mx } = await sb.from("vcbe_quiz_items").select("sort_order").order("sort_order", { ascending: false }).limit(1);
        row.sort_order = ((mx && mx[0]?.sort_order) || 0) + 1;
      }
      const { data, error } = await sb.from("vcbe_quiz_items").insert(row).select().single();
      if (error) { if (row.media_path) await sb.storage.from(BUCKET).remove([row.media_path]); return json({ error: "save_failed: " + error.message }); }
      return json({ ok: true, item: data });
    }
    if (action === "adm_update") {
      if (!UUID.test(String(body.id || ""))) return json({ error: "id_required" });
      const row = fields();
      if ("question" in row && !row.question) return json({ error: "question_required" });
      const { data: old } = await sb.from("vcbe_quiz_items").select("media_path,correct").eq("id", body.id).maybeSingle();
      row.updated_at = new Date().toISOString();
      const { data, error } = await sb.from("vcbe_quiz_items").update(row).eq("id", body.id).select().single();
      if (error) return json({ error: error.message });
      if (old?.media_path && "media_url" in row && row.media_path !== old.media_path) await sb.storage.from(BUCKET).remove([old.media_path]);
      // Se l'admin cambia la risposta giusta, l'esito delle risposte già date viene ricalcolato.
      if ("correct" in row && old && old.correct !== row.correct) {
        await sb.from("vcbe_quiz_answers").update({ is_correct: true }).eq("item_id", body.id).eq("answer", row.correct);
        await sb.from("vcbe_quiz_answers").update({ is_correct: false }).eq("item_id", body.id).eq("answer", !row.correct);
      }
      return json({ ok: true, item: data });
    }
    if (action === "adm_reorder") {
      const ids = Array.isArray(body.ids) ? body.ids.filter((x: any) => UUID.test(String(x))).slice(0, 2000) : [];
      for (let i = 0; i < ids.length; i++) await sb.from("vcbe_quiz_items").update({ sort_order: i + 1 }).eq("id", ids[i]);
      return json({ ok: true });
    }
    if (action === "adm_delete") {
      if (!UUID.test(String(body.id || ""))) return json({ error: "id_required" });
      const { data: row } = await sb.from("vcbe_quiz_items").select("media_path").eq("id", body.id).maybeSingle();
      const { error } = await sb.from("vcbe_quiz_items").delete().eq("id", body.id);
      if (error) return json({ error: error.message });
      if (row?.media_path) await sb.storage.from(BUCKET).remove([row.media_path]);
      return json({ ok: true });
    }
    if (action === "adm_reset") {
      const rid = String(body.referee_id || ""), iid = String(body.item_id || "");
      if (!UUID.test(rid) && !UUID.test(iid)) return json({ error: "referee_or_item_required" });
      let q = sb.from("vcbe_quiz_answers").delete();
      if (UUID.test(rid)) q = q.eq("referee_id", rid);
      if (UUID.test(iid)) q = q.eq("item_id", iid);
      const { error } = await q;
      return json(error ? { error: error.message } : { ok: true });
    }
    return json({ error: "unknown admin action" }, 400);
  }

  // Riquadro Home: numero di domande e date di caricamento recenti (etichetta «New» 7 giorni), nessun contenuto.
  if (action === "summary") {
    const { data: its } = await sb.from("vcbe_quiz_items").select("created_at").eq("published", true);
    const since = Date.now() - 7 * 86400000;
    return json({ ok: true, count: (its || []).length, recent: (its || []).map((x: any) => x.created_at).filter((c: string) => new Date(c).getTime() > since) });
  }

  // ================= SESSIONE (stesso token di Drive) =================
  const token = String(body.token || "");
  if (!/^[0-9a-f]{64}$/.test(token)) return json({ ok: false, reason: "signed_out" }, 401);
  const th = await sha256(token);
  const { data: sess } = await sb.from("vcbe_drive_sessions").select("referee_id,expires_at").eq("token_hash", th).maybeSingle();
  if (!sess || new Date(sess.expires_at).getTime() < Date.now()) return json({ ok: false, reason: "signed_out" }, 401);
  const { data: me } = await sb.from("vcbe_referees").select("id,name,active").eq("id", sess.referee_id).maybeSingle();
  if (!me || me.active === false) return json({ ok: false, reason: "signed_out" }, 401);
  const { data: st0 } = await sb.from("vcbe_drive_settings").select("require_code").eq("id", 1).maybeSingle();
  if (!st0 || st0.require_code !== false) {
    const { data: a } = await sb.from("vcbe_drive_access").select("active,code").eq("referee_id", me.id).maybeSingle();
    if (!a || !a.active || !a.code) return json({ ok: false, reason: "signed_out" }, 401);
  }

  if (action === "list") {
    const [{ data: items, error }, { data: mine }] = await Promise.all([
      sb.from("vcbe_quiz_items").select("*").eq("published", true).order("sort_order").order("created_at", { ascending: false }),
      sb.from("vcbe_quiz_answers").select("item_id,answer,is_correct,created_at").eq("referee_id", me.id),
    ]);
    if (error) return json({ ok: false, reason: error.message }, 500);
    const m: Record<string, any> = {}; (mine || []).forEach((a: any) => m[a.item_id] = a);
    const out = (items || []).map((it: any) => {
      const a = m[it.id];
      return a ? { ...pub(it), my: { answer: a.answer, correct: a.is_correct, right: it.correct, explanation: it.explanation || "", at: a.created_at } } : pub(it);
    });
    return json({ ok: true, name: me.name, items: out });
  }
  if (action === "answer") {
    const id = String(body.item_id || "");
    if (!UUID.test(id)) return json({ ok: false, reason: "item_required" }, 400);
    if (typeof body.answer !== "boolean") return json({ ok: false, reason: "answer_required" }, 400);
    const { data: it } = await sb.from("vcbe_quiz_items").select("id,correct,explanation,published").eq("id", id).maybeSingle();
    if (!it || !it.published) return json({ ok: false, reason: "not_found" }, 404);
    const { data: prev } = await sb.from("vcbe_quiz_answers").select("answer,is_correct").eq("item_id", id).eq("referee_id", me.id).maybeSingle();
    if (prev) return json({ ok: true, already: true, answer: prev.answer, correct: prev.is_correct, right: it.correct, explanation: it.explanation || "" });
    const isC = body.answer === it.correct;
    const { error } = await sb.from("vcbe_quiz_answers").insert({ item_id: id, referee_id: me.id, answer: body.answer, is_correct: isC });
    if (error) return json({ ok: false, reason: error.message }, 500);
    return json({ ok: true, answer: body.answer, correct: isC, right: it.correct, explanation: it.explanation || "" });
  }
  return json({ ok: false, reason: "unknown action" }, 400);
});
