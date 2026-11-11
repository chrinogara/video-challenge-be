// Edge function vcbe-videos (11/11/2026): gestione admin della pagina «Video & slides».
// Il catalogo (tabella vcbe_videos, solo righe published) si legge con la chiave anon direttamente dall'app;
// qui passano SOLO le azioni admin, protette dalla password di vcbe_admin_config.
//   adm_list
//   adm_upload_url {kind: video|slides|cover, ext}  -> link firmato per caricare il file nel bucket pubblico vcbe-videos (cartella app/)
//   adm_add {title, subtitle, description, presenter, category, duration, kind, url | storage_path, cover_path | cover_url, published}
//   adm_update {id, ...stessi campi}   adm_reorder {ids:[...]}   adm_delete {id}  (toglie anche i file caricati da qui)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST,OPTIONS" };
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SECRET_KEYS") || "";
const BUCKET = "vcbe-videos";
const json = (o: any, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const randHex = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n))).map((b) => b.toString(16).padStart(2, "0")).join("");
const str = (v: any, max: number) => { const s = String(v ?? "").trim().slice(0, max); return s || null; };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIELDS: Record<string, number> = { title: 200, subtitle: 200, description: 6000, presenter: 300, category: 80, duration: 20 };
const httpUrl = (v: any) => { const s = String(v ?? "").trim().slice(0, 1500); return /^https?:\/\/[^\s<>"]+$/i.test(s) ? s : null; };
const OUR = /^app\/(files|covers)\/[\w.-]+\.[a-z0-9]{2,5}$/;
const EXT: Record<string, string[]> = { video: ["mp4", "m4v", "mov", "webm"], slides: ["pptx", "ppt", "pdf", "key", "odp"], cover: ["jpg"] };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let body: any = {}; try { body = await req.json(); } catch { /* empty */ }
  const sb = createClient(SB_URL, SB_KEY);
  const action = String(body.action || "");
  const pubUrl = (p: string) => sb.storage.from(BUCKET).getPublicUrl(p).data.publicUrl;
  const { data: cfg } = await sb.from("vcbe_admin_config").select("value").eq("key", "admin_password").maybeSingle();
  const pw = String(cfg?.value || "").trim();
  if (!pw || String(body.password || "").trim() !== pw) return json({ error: "unauthorized" }, 401);

  const fields = () => {
    const row: any = {};
    for (const k in FIELDS) if (k in body) row[k] = str(body[k], FIELDS[k]);
    if ("kind" in body) row.kind = ["video", "slides"].includes(body.kind) ? body.kind : null;
    if ("published" in body) row.published = !!body.published;
    if ("sort_order" in body) row.sort_order = Number(body.sort_order) || 0;
    if ("url" in body) row.url = httpUrl(body.url);
    if ("storage_path" in body) { const sp = String(body.storage_path || ""); if (OUR.test(sp)) { row.storage_path = sp; row.url = pubUrl(sp); } }
    if ("cover_url" in body) { row.cover_url = httpUrl(body.cover_url); row.cover_path = null; }
    if ("cover_path" in body) { const cp = String(body.cover_path || ""); if (OUR.test(cp)) { row.cover_path = cp; row.cover_url = pubUrl(cp); } }
    return row;
  };
  const removeOurs = async (paths: (string | null | undefined)[]) => { const rm = paths.filter((p) => p && OUR.test(p)) as string[]; if (rm.length) await sb.storage.from(BUCKET).remove(rm); };

  if (action === "adm_list") {
    const { data, error } = await sb.from("vcbe_videos").select("*").order("sort_order").order("created_at", { ascending: false });
    return json(error ? { error: error.message } : { ok: true, videos: data || [] });
  }
  if (action === "adm_upload_url") {
    const kind = ["video", "slides", "cover"].includes(body.kind) ? body.kind : "";
    const ext = String(body.ext || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!kind || !EXT[kind].includes(ext)) return json({ error: "bad_file_type" });
    const path = `app/${kind === "cover" ? "covers" : "files"}/${new Date().toISOString().slice(0, 10)}-${randHex(8)}.${ext}`;
    const { data, error } = await sb.storage.from(BUCKET).createSignedUploadUrl(path);
    if (error || !data) return json({ error: error?.message || "no url" });
    return json({ ok: true, path, upload_token: data.token, public_url: pubUrl(path) });
  }
  if (action === "adm_add") {
    const row = fields();
    if (!row.title) return json({ error: "title_required" });
    if (!row.url) return json({ error: "link_or_file_required" });
    if (!("sort_order" in row)) {
      const { data: mn } = await sb.from("vcbe_videos").select("sort_order").order("sort_order").limit(1);
      row.sort_order = (mn && mn.length ? Number(mn[0].sort_order) || 0 : 0) - 1; // nuovo video in cima
    }
    if (!("published" in row)) row.published = true;
    const { data, error } = await sb.from("vcbe_videos").insert(row).select().single();
    if (error) { await removeOurs([row.storage_path, row.cover_path]); return json({ error: "save_failed: " + error.message }); }
    return json({ ok: true, video: data });
  }
  if (action === "adm_update") {
    if (!UUID.test(String(body.id || ""))) return json({ error: "id_required" });
    const { data: old } = await sb.from("vcbe_videos").select("storage_path,cover_path").eq("id", body.id).maybeSingle();
    if (!old) return json({ error: "not_found" });
    const row = fields();
    if ("title" in row && !row.title) return json({ error: "title_required" });
    if ("url" in row && !row.url) return json({ error: "link_or_file_required" });
    if ("url" in body && !("storage_path" in body) && row.url) row.storage_path = null; // nuovo link al posto del file
    const { data, error } = await sb.from("vcbe_videos").update(row).eq("id", body.id).select().single();
    if (error) return json({ error: error.message });
    const drop: string[] = [];
    if ("storage_path" in row && old.storage_path !== row.storage_path) drop.push(old.storage_path);
    if ("cover_path" in row && old.cover_path !== row.cover_path) drop.push(old.cover_path);
    await removeOurs(drop);
    return json({ ok: true, video: data });
  }
  if (action === "adm_reorder") {
    const ids = Array.isArray(body.ids) ? body.ids.filter((x: any) => UUID.test(String(x))).slice(0, 500) : [];
    for (let i = 0; i < ids.length; i++) await sb.from("vcbe_videos").update({ sort_order: i }).eq("id", ids[i]);
    return json({ ok: true });
  }
  if (action === "adm_delete") {
    if (!UUID.test(String(body.id || ""))) return json({ error: "id_required" });
    const { data: old } = await sb.from("vcbe_videos").select("storage_path,cover_path").eq("id", body.id).maybeSingle();
    const { error } = await sb.from("vcbe_videos").delete().eq("id", body.id);
    if (error) return json({ error: error.message });
    await removeOurs([old?.storage_path, old?.cover_path]); // i file vecchi (vcbe-slides, link esterni) non si toccano
    return json({ ok: true });
  }
  return json({ error: "unknown action" }, 400);
});
