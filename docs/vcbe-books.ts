// Edge function vcbe-books (11/11/2026; v2 stesso giorno: source_url / source_label): sezione «Books» dell'app (libri PDF da leggere nell'app).
// Il catalogo (tabella vcbe_books, bucket pubblico vcbe-books) si legge con la chiave anon; qui passano solo
// le recensioni (token della sessione Drive: nome + codice personale) e le azioni admin (password admin).
//   reviews {book_id, token?}                         -> recensioni del libro (+ mine)
//   review_set {token, book_id, rating 1-5, title?, body?} ; review_delete {token, book_id}
//   adm_list ; adm_upload_url {kind: pdf|cover} ; adm_add {...} ; adm_update {id, ...} ; adm_delete {id} ; adm_delete_review {id}
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST,OPTIONS" };
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SECRET_KEYS") || "";
const BUCKET = "vcbe-books";
const json = (o: any, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const sha256 = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))).map((b) => b.toString(16).padStart(2, "0")).join("");
const randHex = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n))).map((b) => b.toString(16).padStart(2, "0")).join("");
const str = (v: any, max: number) => { const s = String(v ?? "").trim().slice(0, max); return s || null; };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIELDS: Record<string, number> = { title: 200, author: 200, category: 80, description: 6000, language: 40, publisher: 200, released: 40, source_label: 120 };
// Link alla fonte del documento (FIVB, CEV, Drive personale…): solo indirizzi http(s).
const srcUrl = (v: any) => { const s = String(v ?? "").trim().slice(0, 1000); return /^https?:\/\/[^\s<>"]+$/i.test(s) ? s : null; };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let body: any = {}; try { body = await req.json(); } catch { /* empty */ }
  const sb = createClient(SB_URL, SB_KEY);
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
      if ("pages" in body) row.pages = Math.max(0, Math.min(100000, Number(body.pages) || 0)) || null;
      if ("size_bytes" in body) row.size_bytes = Number(body.size_bytes) || null;
      if ("toc" in body) row.toc = Array.isArray(body.toc) ? body.toc.slice(0, 600).map((x: any) => ({ t: String(x.t || "").slice(0, 200), p: Number(x.p) || 1, l: Number(x.l) || 0 })) : null;
      if ("source_url" in body) row.source_url = srcUrl(body.source_url);
      if ("published" in body) row.published = !!body.published;
      if ("sort_order" in body) row.sort_order = Number(body.sort_order) || 0;
      return row;
    };
    if (action === "adm_list") {
      const [{ data: books, error }, { data: revs }] = await Promise.all([
        sb.from("vcbe_books").select("*").order("sort_order").order("created_at", { ascending: false }),
        sb.from("vcbe_book_reviews").select("id,book_id,referee_id,rating,title,body,created_at").order("created_at", { ascending: false }).limit(500),
      ]);
      if (error) return json({ error: error.message });
      const ids = [...new Set((revs || []).map((r: any) => r.referee_id))];
      const { data: refs } = ids.length ? await sb.from("vcbe_referees").select("id,name").in("id", ids) : { data: [] as any[] };
      const nm: Record<string, string> = {}; (refs || []).forEach((r: any) => nm[r.id] = r.name);
      return json({ ok: true, books: books || [], reviews: (revs || []).map((r: any) => ({ ...r, name: nm[r.referee_id] || "" })) });
    }
    if (action === "adm_upload_url") {
      const kind = body.kind === "cover" ? "cover" : "pdf";
      const path = `${kind === "cover" ? "covers" : "files"}/${new Date().toISOString().slice(0, 10)}-${randHex(8)}.${kind === "cover" ? "jpg" : "pdf"}`;
      const { data, error } = await sb.storage.from(BUCKET).createSignedUploadUrl(path);
      if (error || !data) return json({ error: error?.message || "no url" });
      return json({ ok: true, path, upload_token: data.token });
    }
    if (action === "adm_add") {
      const row = fields();
      if (!row.title) return json({ error: "title_required" });
      const sp = String(body.storage_path || "");
      if (!/^files\/[\w.-]+\.pdf$/.test(sp)) return json({ error: "file_required" });
      row.storage_path = sp; row.file_url = pubUrl(sp);
      const cp = String(body.cover_path || "");
      if (/^covers\/[\w.-]+\.jpg$/.test(cp)) { row.cover_path = cp; row.cover_url = pubUrl(cp); }
      const { data, error } = await sb.from("vcbe_books").insert(row).select().single();
      if (error) { await sb.storage.from(BUCKET).remove([sp, cp].filter(Boolean)); return json({ error: "save_failed: " + error.message }); }
      return json({ ok: true, book: data });
    }
    if (action === "adm_update") {
      if (!UUID.test(String(body.id || ""))) return json({ error: "id_required" });
      const row = fields();
      if ("title" in row && !row.title) return json({ error: "title_required" });
      const { data, error } = await sb.from("vcbe_books").update(row).eq("id", body.id).select().single();
      return json(error ? { error: error.message } : { ok: true, book: data });
    }
    if (action === "adm_delete") {
      if (!UUID.test(String(body.id || ""))) return json({ error: "id_required" });
      const { data: row } = await sb.from("vcbe_books").select("storage_path,cover_path").eq("id", body.id).maybeSingle();
      const rm = [row?.storage_path, row?.cover_path].filter(Boolean) as string[];
      if (rm.length) await sb.storage.from(BUCKET).remove(rm);
      const { error } = await sb.from("vcbe_books").delete().eq("id", body.id);
      return json(error ? { error: error.message } : { ok: true });
    }
    if (action === "adm_delete_review") {
      const { error } = await sb.from("vcbe_book_reviews").delete().eq("id", String(body.id || ""));
      return json(error ? { error: error.message } : { ok: true });
    }
    return json({ error: "unknown admin action" }, 400);
  }

  // ================= SESSIONE (facoltativa per leggere, obbligatoria per scrivere) =================
  let me: any = null;
  const token = String(body.token || "");
  if (/^[0-9a-f]{64}$/.test(token)) {
    const { data: sess } = await sb.from("vcbe_drive_sessions").select("referee_id,expires_at").eq("token_hash", await sha256(token)).maybeSingle();
    if (sess && new Date(sess.expires_at).getTime() > Date.now()) {
      const { data: r } = await sb.from("vcbe_referees").select("id,name,active").eq("id", sess.referee_id).maybeSingle();
      if (r && r.active !== false) me = r;
    }
  }
  const bookId = String(body.book_id || "");
  if (!UUID.test(bookId)) return json({ ok: false, reason: "book_required" }, 400);

  if (action === "reviews") {
    const { data: revs, error } = await sb.from("vcbe_book_reviews").select("id,referee_id,rating,title,body,created_at,updated_at").eq("book_id", bookId).order("updated_at", { ascending: false }).limit(300);
    if (error) return json({ ok: false, reason: error.message }, 500);
    const ids = [...new Set((revs || []).map((r: any) => r.referee_id))];
    const { data: refs } = ids.length ? await sb.from("vcbe_referees").select("id,name").in("id", ids) : { data: [] as any[] };
    const nm: Record<string, string> = {}; (refs || []).forEach((r: any) => nm[r.id] = r.name);
    const out = (revs || []).map((r: any) => ({ id: r.id, name: nm[r.referee_id] || "", rating: r.rating, title: r.title || "", body: r.body || "", at: r.updated_at || r.created_at, mine: !!me && r.referee_id === me.id }));
    return json({ ok: true, signed_in: !!me, reviews: out, mine: out.find((r: any) => r.mine) || null });
  }
  if (!me) return json({ ok: false, reason: "signed_out" }, 401);
  if (action === "review_set") {
    const rating = Math.round(Number(body.rating));
    if (!(rating >= 1 && rating <= 5)) return json({ ok: false, reason: "rating_required" }, 400);
    const { data: b } = await sb.from("vcbe_books").select("id").eq("id", bookId).maybeSingle();
    if (!b) return json({ ok: false, reason: "book_not_found" }, 404);
    const { error } = await sb.from("vcbe_book_reviews").upsert({ book_id: bookId, referee_id: me.id, rating, title: str(body.title, 120), body: str(body.body, 4000), updated_at: new Date().toISOString() }, { onConflict: "book_id,referee_id" });
    return json(error ? { ok: false, reason: error.message } : { ok: true });
  }
  if (action === "review_delete") {
    const { error } = await sb.from("vcbe_book_reviews").delete().eq("book_id", bookId).eq("referee_id", me.id);
    return json(error ? { ok: false, reason: error.message } : { ok: true });
  }
  return json({ ok: false, reason: "unknown action" }, 400);
});
