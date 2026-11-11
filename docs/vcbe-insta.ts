// vcbe-insta - Video Challenge BE (v1, 11/11/2026, richiesta utente)
// Sezione «Instachallenge»: spazio social chiuso degli arbitri (foto e video, feed, like, commenti, profilo, segui,
// salvati, attività, condivisione di un post nella chat degli arbitri di Drive).
// Accesso: stesso token di sessione della sezione Drive (nome + codice personale, tabella vcbe_drive_sessions).
// Tabelle (RLS senza policy, solo server): vcbe_insta_profiles, vcbe_insta_posts, vcbe_insta_likes, vcbe_insta_comments,
//   vcbe_insta_follows, vcbe_insta_saves. Bucket PRIVATO vcbe-insta (link firmati 1 h). Migration vcbe_insta_20261111.
// Azioni (tutte con {token}): me, username_check {username}, profile_save {username?, bio?, avatar_base64?, avatar_type?, avatar_clear?, done?},
//   upload_url {content_type} -> {path, url} (PUT diretto del file nel bucket, fino al limite del bucket),
//   post_create {caption?, media:[{path, type image|video, w?, h?, poster?}]}, post_delete {id}, post_edit {id, caption},
//   feed {mode all|following|saved|videos, before?, author?}, post {id}, like {id, on}, save {id, on},
//   comments {id}, comment_add {id, body}, comment_delete {id}, follow {id, on}, follow_many {ids},
//   people {q?}, profile {id}, activity {}, share {id, to "all"|referee_id, note?},
//   comment_like {id, on}, comments restituisce parent/likes/by_author; comment_add accetta parent; likes_list {id}; repost {id, on, thought?},
//   stories {}, story_create {path, type, poster?, text?, poll?:{q,a,b}, question?}, story_view {id, liked?, vote?}, story_reply {id, body, kind reply|reaction|answer},
//   story_delete {id}, story_viewers {id}. Risposte alle storie e condivisioni arrivano in chat (vcbe_drive_messages, testo con [ic:id] / [ics:id]).
// Azioni admin (password admin di vcbe_admin_config): adm_list {}, adm_delete_post {id}, adm_delete_comment {id}
// Deploy: index.ts su Supabase contiene solo l'import di questo file da raw.githubusercontent.com/<commit>.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "POST,OPTIONS" };
const SB_URL = Deno.env.get("SUPABASE_URL")!;
function getServiceKey(): string {
  const direct = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (direct) return direct;
  try { const d = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}"); return d.secret ?? d.service_role ?? (Object.values(d)[0] as string) ?? ""; } catch (_) { return ""; }
}
const BUCKET = "vcbe-insta";
const TYPES: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/heic": "heic", "image/heif": "heif",
  "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm", "video/3gpp": "3gp", "video/x-m4v": "m4v",
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });
async function sha256(s: string): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, "0")).join("");
}
function randHex(n: number) { const a = new Uint8Array(n); crypto.getRandomValues(a); return Array.from(a).map(x => x.toString(16).padStart(2, "0")).join(""); }
function b64bytes(b: string): Uint8Array { const s = atob(b.replace(/^data:[^,]*,/, "")); const a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; }
const clean = (s: unknown, max: number) => String(s ?? "").replace(/\r/g, "").trim().slice(0, max);
const userOk = (u: string) => /^[a-z0-9](?:[a-z0-9._]{1,28})[a-z0-9]$/.test(u) && !/\.\./.test(u);
function suggest(name: string): string {
  const base = String(name || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().split(/\s+/).filter(Boolean);
  // DB: COGNOME NOME -> nome.cognome
  const s = (base.length >= 2 ? [base[base.length - 1], ...base.slice(0, -1)] : base).join(".").replace(/[^a-z0-9.]/g, "");
  return (s || "referee").slice(0, 26);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  let body: any = {};
  try { body = await req.json(); } catch (_) { /* */ }
  const action = String(body.action || "");
  const sb = createClient(SB_URL, getServiceKey(), { auth: { persistSession: false } });

  const sign = async (paths: string[]) => {
    const out: Record<string, string> = {};
    const u = [...new Set(paths.filter(Boolean))];
    for (let i = 0; i < u.length; i += 100) {
      const { data } = await sb.storage.from(BUCKET).createSignedUrls(u.slice(i, i + 100), 3600);
      (data || []).forEach((x: any) => { if (x.signedUrl && x.path) out[x.path] = x.signedUrl; });
    }
    return out;
  };
  const refMap = async (ids: string[]) => {
    const u = [...new Set(ids.filter(Boolean))];
    const m: Record<string, any> = {};
    if (!u.length) return m;
    const [{ data: r }, { data: p }] = await Promise.all([
      sb.from("vcbe_referees").select("id,name").in("id", u),
      sb.from("vcbe_insta_profiles").select("referee_id,username,avatar_path,bio").in("referee_id", u),
    ]);
    (r || []).forEach((x: any) => m[x.id] = { id: x.id, name: x.name, username: null, avatar_path: null, bio: null });
    (p || []).forEach((x: any) => { if (m[x.referee_id]) Object.assign(m[x.referee_id], { username: x.username, avatar_path: x.avatar_path, bio: x.bio }); });
    return m;
  };
  const pubUser = (u: any, urls: Record<string, string>) => u ? { id: u.id, name: u.name, username: u.username || null, avatar: u.avatar_path ? urls[u.avatar_path] || null : null, bio: u.bio || "" } : null;

  // ================= ADMIN =================
  if (action.startsWith("adm_")) {
    const { data: cfg } = await sb.from("vcbe_admin_config").select("value").eq("key", "admin_password").maybeSingle();
    const pw = String(cfg?.value || "").trim();
    if (!pw || String(body.password || "").trim() !== pw) return json({ error: "unauthorized" }, 401);
    if (action === "adm_list") {
      const { data: ps } = await sb.from("vcbe_insta_posts").select("id,author_id,caption,media,created_at").is("deleted_at", null).order("created_at", { ascending: false }).limit(200);
      const rm = await refMap((ps || []).map((p: any) => p.author_id));
      const urls = await sign((ps || []).flatMap((p: any) => (p.media || []).slice(0, 1).map((m: any) => m.poster || m.path)));
      return json({ ok: true, posts: (ps || []).map((p: any) => ({ id: p.id, author: rm[p.author_id]?.name || "", caption: p.caption, at: p.created_at, n: (p.media || []).length, thumb: urls[(p.media?.[0]?.poster || p.media?.[0]?.path)] || null, video: p.media?.[0]?.type === "video" })) });
    }
    if (action === "adm_delete_post") { await sb.from("vcbe_insta_posts").update({ deleted_at: new Date().toISOString() }).eq("id", String(body.id || "")); return json({ ok: true }); }
    if (action === "adm_delete_comment") { await sb.from("vcbe_insta_comments").update({ deleted_at: new Date().toISOString() }).eq("id", String(body.id || "")); return json({ ok: true }); }
    return json({ error: "unknown admin action" }, 400);
  }

  // ================= SESSION (token della sezione Drive) =================
  const token = String(body.token || "");
  if (!/^[0-9a-f]{64}$/.test(token)) return json({ ok: false, reason: "signed_out" }, 401);
  const th = await sha256(token);
  const { data: sess } = await sb.from("vcbe_drive_sessions").select("referee_id,expires_at").eq("token_hash", th).maybeSingle();
  if (!sess || new Date(sess.expires_at).getTime() < Date.now()) return json({ ok: false, reason: "signed_out" }, 401);
  const { data: me } = await sb.from("vcbe_referees").select("id,name,active").eq("id", sess.referee_id).maybeSingle();
  if (!me || !me.active) return json({ ok: false, reason: "signed_out" }, 401);
  const { data: st0 } = await sb.from("vcbe_drive_settings").select("require_code").eq("id", 1).maybeSingle();
  if (!st0 || st0.require_code !== false) {
    const { data: a } = await sb.from("vcbe_drive_access").select("active,code").eq("referee_id", me.id).maybeSingle();
    if (!a || !a.active || !a.code) return json({ ok: false, reason: "signed_out" }, 401);
  }

  // costruisce i post per la risposta (autore, media firmati, like, commenti, salvati)
  const buildPosts = async (ps: any[]) => {
    if (!ps.length) return [];
    const ids = ps.map(p => p.id);
    const [{ data: likes }, { data: coms }, { data: mine }, { data: saved }, { data: reps }] = await Promise.all([
      sb.from("vcbe_insta_likes").select("post_id,referee_id").in("post_id", ids),
      sb.from("vcbe_insta_comments").select("id,post_id,author_id,body,created_at").in("post_id", ids).is("deleted_at", null).order("created_at", { ascending: true }),
      sb.from("vcbe_insta_likes").select("post_id").in("post_id", ids).eq("referee_id", me.id),
      sb.from("vcbe_insta_saves").select("post_id").in("post_id", ids).eq("referee_id", me.id),
      sb.from("vcbe_insta_reposts").select("post_id,referee_id").in("post_id", ids),
    ]);
    const rp: Record<string, string[]> = {}; (reps || []).forEach((r: any) => (rp[r.post_id] ||= []).push(r.referee_id));
    const lk: Record<string, string[]> = {}; (likes || []).forEach((l: any) => (lk[l.post_id] ||= []).push(l.referee_id));
    const cm: Record<string, any[]> = {}; (coms || []).forEach((c: any) => (cm[c.post_id] ||= []).push(c));
    const myL = new Set((mine || []).map((x: any) => x.post_id)), myS = new Set((saved || []).map((x: any) => x.post_id));
    const rm = await refMap([...ps.map(p => p.author_id), ...(coms || []).map((c: any) => c.author_id), ...Object.values(lk).flat().slice(0, 300)]);
    const urls = await sign([...ps.flatMap(p => (p.media || []).flatMap((m: any) => [m.path, m.poster])), ...Object.values(rm).map((u: any) => u.avatar_path)]);
    return ps.map(p => {
      const c = cm[p.id] || [], l = lk[p.id] || [];
      const liker = l.find(x => x !== me.id) || l[0];
      return {
        id: p.id, at: p.created_at, caption: p.caption || "", mine: p.author_id === me.id, author: pubUser(rm[p.author_id], urls),
        media: (p.media || []).map((m: any) => ({ type: m.type, url: urls[m.path] || null, poster: m.poster ? urls[m.poster] || null : null, w: m.w || null, h: m.h || null })),
        likes: l.length, liked: myL.has(p.id), saved: myS.has(p.id), liked_by: liker ? (rm[liker]?.username || rm[liker]?.name || "") : null,
        reposts: (rp[p.id] || []).length, reposted: (rp[p.id] || []).includes(me.id),
        comments: c.length, last_comments: c.slice(-2).map(x => ({ id: x.id, user: rm[x.author_id]?.username || rm[x.author_id]?.name || "", body: x.body })),
      };
    });
  };
  const counts = async (id: string) => {
    const [a, b, c] = await Promise.all([
      sb.from("vcbe_insta_posts").select("id", { count: "exact", head: true }).eq("author_id", id).is("deleted_at", null),
      sb.from("vcbe_insta_follows").select("follower_id", { count: "exact", head: true }).eq("followee_id", id),
      sb.from("vcbe_insta_follows").select("followee_id", { count: "exact", head: true }).eq("follower_id", id),
    ]);
    return { posts: a.count || 0, followers: b.count || 0, following: c.count || 0 };
  };

  if (action === "me") {
    const { data: p } = await sb.from("vcbe_insta_profiles").select("*").eq("referee_id", me.id).maybeSingle();
    const urls = p?.avatar_path ? await sign([p.avatar_path]) : {};
    let sug = suggest(me.name), n = 1;
    if (!p) { for (;;) { const { data: t } = await sb.from("vcbe_insta_profiles").select("referee_id").eq("username", sug).maybeSingle(); if (!t) break; n++; sug = suggest(me.name).slice(0, 24) + n; if (n > 50) break; } }
    return json({ ok: true, id: me.id, name: me.name, profile: p ? { username: p.username, bio: p.bio || "", avatar: p.avatar_path ? urls[p.avatar_path] || null : null, onboarded: !!p.onboarded_at } : null, suggestion: sug, counts: await counts(me.id) });
  }

  if (action === "username_check") {
    const u = clean(body.username, 30).toLowerCase();
    if (!userOk(u)) return json({ ok: true, valid: false, free: false });
    const { data: t } = await sb.from("vcbe_insta_profiles").select("referee_id").eq("username", u).maybeSingle();
    return json({ ok: true, valid: true, free: !t || t.referee_id === me.id });
  }

  if (action === "profile_save") {
    const { data: cur } = await sb.from("vcbe_insta_profiles").select("*").eq("referee_id", me.id).maybeSingle();
    const row: any = { referee_id: me.id, updated_at: new Date().toISOString() };
    if (body.username !== undefined || !cur) {
      const u = clean(body.username ?? suggest(me.name), 30).toLowerCase();
      if (!userOk(u)) return json({ ok: false, reason: "bad_username" });
      const { data: t } = await sb.from("vcbe_insta_profiles").select("referee_id").eq("username", u).maybeSingle();
      if (t && t.referee_id !== me.id) return json({ ok: false, reason: "taken" });
      row.username = u;
    }
    if (body.bio !== undefined) row.bio = clean(body.bio, 300);
    if (body.avatar_clear) row.avatar_path = null;
    if (body.avatar_base64) {
      const type = String(body.avatar_type || "image/jpeg").toLowerCase();
      if (!type.startsWith("image/") || !TYPES[type]) return json({ ok: false, reason: "bad_type" });
      const bytes = b64bytes(String(body.avatar_base64)); if (!bytes.length || bytes.length > 4 * 1024 * 1024) return json({ ok: false, reason: "too_large" });
      const path = `avatars/${me.id}/${randHex(6)}.${TYPES[type]}`;
      const up = await sb.storage.from(BUCKET).upload(path, bytes, { contentType: type, upsert: false });
      if (up.error) return json({ ok: false, reason: up.error.message }, 500);
      row.avatar_path = path;
      if (cur?.avatar_path) sb.storage.from(BUCKET).remove([cur.avatar_path]).then(() => {});
      // «Also share this picture as a post»
      if (body.avatar_post) await sb.from("vcbe_insta_posts").insert({ author_id: me.id, caption: clean(body.avatar_caption, 2200) || null, media: [{ path, type: "image", w: 1, h: 1 }] });
    }
    if (body.done && !cur?.onboarded_at) row.onboarded_at = new Date().toISOString();
    const { error } = await sb.from("vcbe_insta_profiles").upsert(row);
    if (error) return json({ ok: false, reason: error.message }, 500);
    return json({ ok: true });
  }

  if (action === "upload_url") {
    const type = String(body.content_type || "").split(";")[0].trim().toLowerCase();
    const ext = TYPES[type]; if (!ext) return json({ ok: false, reason: "type_not_allowed", type }, 400);
    const path = `p/${me.id}/${new Date().toISOString().slice(0, 10)}-${randHex(8)}.${ext}`;
    const { data, error } = await sb.storage.from(BUCKET).createSignedUploadUrl(path);
    if (error || !data) return json({ ok: false, reason: error?.message || "no url" }, 500);
    return json({ ok: true, path, url: data.signedUrl, upload_token: data.token });
  }

  if (action === "post_create") {
    const media = Array.isArray(body.media) ? body.media.slice(0, 10) : [];
    const pre = `p/${me.id}/`;
    const clean_m = media.filter((m: any) => m && typeof m.path === "string" && m.path.startsWith(pre) && !m.path.includes("..") && (m.type === "image" || m.type === "video"))
      .map((m: any) => ({ path: m.path, type: m.type, w: Number(m.w) || null, h: Number(m.h) || null, poster: typeof m.poster === "string" && m.poster.startsWith(pre) && !m.poster.includes("..") ? m.poster : null }));
    if (!clean_m.length) return json({ ok: false, reason: "no_media" }, 400);
    const { data, error } = await sb.from("vcbe_insta_posts").insert({ author_id: me.id, caption: clean(body.caption, 2200) || null, media: clean_m }).select("id").single();
    if (error) return json({ ok: false, reason: error.message }, 500);
    await sb.from("vcbe_insta_profiles").upsert({ referee_id: me.id, username: (await sb.from("vcbe_insta_profiles").select("username").eq("referee_id", me.id).maybeSingle()).data?.username || suggest(me.name) + randHex(1) }, { onConflict: "referee_id", ignoreDuplicates: true });
    return json({ ok: true, id: data.id });
  }

  const pid = String(body.id || "");
  const getPost = async () => { if (!UUID.test(pid)) return null; const { data } = await sb.from("vcbe_insta_posts").select("*").eq("id", pid).is("deleted_at", null).maybeSingle(); return data; };

  if (action === "post_delete") {
    const p = await getPost(); if (!p || p.author_id !== me.id) return json({ ok: false, reason: "not_found" }, 404);
    await sb.from("vcbe_insta_posts").update({ deleted_at: new Date().toISOString() }).eq("id", pid);
    return json({ ok: true });
  }
  if (action === "post_edit") {
    const p = await getPost(); if (!p || p.author_id !== me.id) return json({ ok: false, reason: "not_found" }, 404);
    await sb.from("vcbe_insta_posts").update({ caption: clean(body.caption, 2200) || null }).eq("id", pid);
    return json({ ok: true });
  }

  if (action === "feed") {
    const mode = String(body.mode || "all");
    let q = sb.from("vcbe_insta_posts").select("*").is("deleted_at", null).order("created_at", { ascending: false }).limit(Math.min(30, Math.max(1, Number(body.limit) || 12)));
    if (body.before && !isNaN(Date.parse(body.before))) q = q.lt("created_at", new Date(body.before).toISOString());
    if (body.author && UUID.test(String(body.author))) q = q.eq("author_id", String(body.author));
    if (mode === "following") {
      const { data: f } = await sb.from("vcbe_insta_follows").select("followee_id").eq("follower_id", me.id);
      const ids = [me.id, ...(f || []).map((x: any) => x.followee_id)];
      q = q.in("author_id", ids);
    } else if (mode === "saved") {
      const { data: s } = await sb.from("vcbe_insta_saves").select("post_id").eq("referee_id", me.id).order("created_at", { ascending: false }).limit(300);
      const ids = (s || []).map((x: any) => x.post_id); if (!ids.length) return json({ ok: true, posts: [] });
      q = q.in("id", ids);
    } else if (mode === "videos") q = q.contains("media", [{ type: "video" }]);
    const { data, error } = await q; if (error) return json({ ok: false, reason: error.message }, 500);
    return json({ ok: true, posts: await buildPosts(data || []) });
  }
  if (action === "post") { const p = await getPost(); if (!p) return json({ ok: false, reason: "not_found" }, 404); return json({ ok: true, post: (await buildPosts([p]))[0] }); }

  if (action === "like") {
    const p = await getPost(); if (!p) return json({ ok: false, reason: "not_found" }, 404);
    if (body.on === false) await sb.from("vcbe_insta_likes").delete().eq("post_id", pid).eq("referee_id", me.id);
    else await sb.from("vcbe_insta_likes").upsert({ post_id: pid, referee_id: me.id }, { onConflict: "post_id,referee_id", ignoreDuplicates: true });
    const { count } = await sb.from("vcbe_insta_likes").select("post_id", { count: "exact", head: true }).eq("post_id", pid);
    return json({ ok: true, likes: count || 0 });
  }
  if (action === "save") {
    const p = await getPost(); if (!p) return json({ ok: false, reason: "not_found" }, 404);
    if (body.on === false) await sb.from("vcbe_insta_saves").delete().eq("post_id", pid).eq("referee_id", me.id);
    else await sb.from("vcbe_insta_saves").upsert({ post_id: pid, referee_id: me.id }, { onConflict: "post_id,referee_id", ignoreDuplicates: true });
    return json({ ok: true });
  }
  if (action === "comments") {
    const p = await getPost(); if (!p) return json({ ok: false, reason: "not_found" }, 404);
    const { data: cs } = await sb.from("vcbe_insta_comments").select("id,parent_id,author_id,body,created_at").eq("post_id", pid).is("deleted_at", null).order("created_at").limit(800);
    const cids = (cs || []).map((c: any) => c.id);
    const { data: cl } = cids.length ? await sb.from("vcbe_insta_comment_likes").select("comment_id,referee_id").in("comment_id", cids) : { data: [] as any[] };
    const cnt: Record<string, number> = {}, mineL = new Set<string>(), byAuthor = new Set<string>();
    (cl || []).forEach((x: any) => { cnt[x.comment_id] = (cnt[x.comment_id] || 0) + 1; if (x.referee_id === me.id) mineL.add(x.comment_id); if (x.referee_id === p.author_id) byAuthor.add(x.comment_id); });
    const rm = await refMap([p.author_id, ...(cs || []).map((c: any) => c.author_id)]);
    const urls = await sign(Object.values(rm).map((u: any) => u.avatar_path));
    return json({ ok: true, post: { id: p.id, caption: p.caption || "", at: p.created_at, author: pubUser(rm[p.author_id], urls) },
      comments: (cs || []).map((c: any) => ({ id: c.id, parent: c.parent_id, at: c.created_at, body: c.body, mine: c.author_id === me.id, is_author: c.author_id === p.author_id,
        likes: cnt[c.id] || 0, liked: mineL.has(c.id), by_author: byAuthor.has(c.id), can_delete: c.author_id === me.id || p.author_id === me.id, author: pubUser(rm[c.author_id], urls) })) });
  }
  if (action === "comment_add") {
    const p = await getPost(); if (!p) return json({ ok: false, reason: "not_found" }, 404);
    const t = clean(body.body, 1000); if (!t) return json({ ok: false, reason: "empty" }, 400);
    let parent: string | null = null;
    if (body.parent && UUID.test(String(body.parent))) {
      const { data: pc } = await sb.from("vcbe_insta_comments").select("id,parent_id,post_id").eq("id", String(body.parent)).maybeSingle();
      if (pc && pc.post_id === pid) parent = pc.parent_id || pc.id; // un solo livello di risposte
    }
    const { data, error } = await sb.from("vcbe_insta_comments").insert({ post_id: pid, author_id: me.id, body: t, parent_id: parent }).select("id,created_at").single();
    if (error) return json({ ok: false, reason: error.message }, 500);
    return json({ ok: true, id: data.id, at: data.created_at });
  }
  if (action === "comment_delete") {
    if (!UUID.test(pid)) return json({ ok: false }, 400);
    const { data: c } = await sb.from("vcbe_insta_comments").select("id,author_id,post_id").eq("id", pid).maybeSingle();
    if (!c) return json({ ok: false, reason: "not_found" }, 404);
    const { data: p } = await sb.from("vcbe_insta_posts").select("author_id").eq("id", c.post_id).maybeSingle();
    if (c.author_id !== me.id && p?.author_id !== me.id) return json({ ok: false, reason: "forbidden" }, 403);
    await sb.from("vcbe_insta_comments").update({ deleted_at: new Date().toISOString() }).eq("id", pid);
    return json({ ok: true });
  }

  if (action === "comment_like") {
    if (!UUID.test(pid)) return json({ ok: false }, 400);
    if (body.on === false) await sb.from("vcbe_insta_comment_likes").delete().eq("comment_id", pid).eq("referee_id", me.id);
    else await sb.from("vcbe_insta_comment_likes").upsert({ comment_id: pid, referee_id: me.id }, { onConflict: "comment_id,referee_id", ignoreDuplicates: true });
    return json({ ok: true });
  }
  if (action === "likes_list") {
    const p = await getPost(); if (!p) return json({ ok: false, reason: "not_found" }, 404);
    const { data: lk } = await sb.from("vcbe_insta_likes").select("referee_id,created_at").eq("post_id", pid).order("created_at", { ascending: false }).limit(500);
    const rm = await refMap((lk || []).map((x: any) => x.referee_id));
    const urls = await sign(Object.values(rm).map((u: any) => u.avatar_path));
    const { data: f } = await sb.from("vcbe_insta_follows").select("followee_id").eq("follower_id", me.id);
    const fol = new Set((f || []).map((x: any) => x.followee_id));
    return json({ ok: true, people: (lk || []).map((x: any) => ({ ...pubUser(rm[x.referee_id], urls), following: fol.has(x.referee_id), me: x.referee_id === me.id })) });
  }
  if (action === "repost") {
    const p = await getPost(); if (!p) return json({ ok: false, reason: "not_found" }, 404);
    if (body.on === false) await sb.from("vcbe_insta_reposts").delete().eq("post_id", pid).eq("referee_id", me.id);
    else await sb.from("vcbe_insta_reposts").upsert({ post_id: pid, referee_id: me.id, thought: clean(body.thought, 120) || null }, { onConflict: "post_id,referee_id" });
    return json({ ok: true });
  }

  // ================= STORIES (24 h) =================
  if (action === "stories") {
    const now = new Date().toISOString();
    const { data: ss } = await sb.from("vcbe_insta_stories").select("*").is("deleted_at", null).gt("expires_at", now).order("created_at").limit(500);
    const sids = (ss || []).map((s: any) => s.id);
    const { data: vw } = sids.length ? await sb.from("vcbe_insta_story_views").select("story_id,referee_id,liked,vote").in("story_id", sids) : { data: [] as any[] };
    const mineV: Record<string, any> = {}, votes: Record<string, number[]> = {}, nviews: Record<string, number> = {};
    (vw || []).forEach((v: any) => { if (v.referee_id === me.id) mineV[v.story_id] = v; if (v.vote != null) { (votes[v.story_id] ||= [0, 0])[v.vote ? 1 : 0]++; } if (v.referee_id !== me.id) nviews[v.story_id] = (nviews[v.story_id] || 0) + 1; });
    const rm = await refMap([me.id, ...(ss || []).map((s: any) => s.author_id)]);
    const urls = await sign([...(ss || []).flatMap((s: any) => [s.media_path, s.poster_path]), ...Object.values(rm).map((u: any) => u.avatar_path)]);
    const groups: Record<string, any> = {};
    for (const s of ss || []) {
      const g = groups[s.author_id] ||= { user: pubUser(rm[s.author_id], urls), mine: s.author_id === me.id, items: [], seen: true, last: s.created_at };
      const v = mineV[s.id], vt = votes[s.id] || [0, 0];
      g.items.push({ id: s.id, at: s.created_at, type: s.media_type, url: urls[s.media_path] || null, poster: s.poster_path ? urls[s.poster_path] || null : null, text: s.text || "",
        poll: s.poll || null, question: s.question || null, seen: !!v || s.author_id === me.id, liked: !!v?.liked, vote: v?.vote ?? null,
        results: (v?.vote != null || s.author_id === me.id) ? vt : null, views: s.author_id === me.id ? nviews[s.id] || 0 : null });
      if (!v && s.author_id !== me.id) g.seen = false; g.last = s.created_at;
    }
    const list = Object.values(groups).sort((a: any, b: any) => (a.mine ? -1 : b.mine ? 1 : 0) || (a.seen === b.seen ? b.last.localeCompare(a.last) : a.seen ? 1 : -1));
    return json({ ok: true, me: pubUser(rm[me.id], urls), groups: list });
  }
  if (action === "story_create") {
    const pre = `p/${me.id}/`;
    const path = String(body.path || ""), type = body.type === "video" ? "video" : "image";
    if (!path.startsWith(pre) || path.includes("..")) return json({ ok: false, reason: "bad_path" }, 400);
    const poster = typeof body.poster === "string" && body.poster.startsWith(pre) && !body.poster.includes("..") ? body.poster : null;
    let poll: any = null;
    if (body.poll && clean(body.poll.a, 40) && clean(body.poll.b, 40)) poll = { q: clean(body.poll.q, 80), a: clean(body.poll.a, 40), b: clean(body.poll.b, 40) };
    const { data, error } = await sb.from("vcbe_insta_stories").insert({ author_id: me.id, media_path: path, media_type: type, poster_path: poster, text: clean(body.text, 200) || null, poll, question: clean(body.question, 120) || null }).select("id").single();
    if (error) return json({ ok: false, reason: error.message }, 500);
    return json({ ok: true, id: data.id });
  }
  const getStory = async () => { if (!UUID.test(pid)) return null; const { data } = await sb.from("vcbe_insta_stories").select("*").eq("id", pid).is("deleted_at", null).maybeSingle(); return data; };
  if (action === "story_view") {
    const s = await getStory(); if (!s) return json({ ok: false, reason: "not_found" }, 404);
    if (s.author_id === me.id) return json({ ok: true });
    const row: any = { story_id: pid, referee_id: me.id };
    if (typeof body.liked === "boolean") row.liked = body.liked;
    if ((body.vote === 0 || body.vote === 1) && s.poll) row.vote = body.vote;
    const { data: ex } = await sb.from("vcbe_insta_story_views").select("vote").eq("story_id", pid).eq("referee_id", me.id).maybeSingle();
    if (ex && ex.vote != null) delete row.vote; // un solo voto
    await sb.from("vcbe_insta_story_views").upsert(row, { onConflict: "story_id,referee_id" });
    let results = null;
    if (s.poll) { const { data: vv } = await sb.from("vcbe_insta_story_views").select("vote").eq("story_id", pid).not("vote", "is", null); results = [0, 0]; (vv || []).forEach((x: any) => results![x.vote ? 1 : 0]++); }
    return json({ ok: true, results });
  }
  if (action === "story_reply") {
    const s = await getStory(); if (!s) return json({ ok: false, reason: "not_found" }, 404);
    if (s.author_id === me.id) return json({ ok: false, reason: "own" }, 400);
    const t = clean(body.body, 1000); if (!t) return json({ ok: false, reason: "empty" }, 400);
    const kind = body.kind === "answer" ? "answer" : body.kind === "reaction" ? "reaction" : "reply";
    const head = kind === "answer" ? `Instachallenge · answer to your story question «${String(s.question || "").slice(0, 80)}»` : kind === "reaction" ? "Instachallenge · reacted to your story" : "Instachallenge · replied to your story";
    const { error } = await sb.from("vcbe_drive_messages").insert({ sender_id: me.id, to_id: s.author_id, kind: "text", body: `${head}
${t}
[ics:${s.id}]` });
    if (error) return json({ ok: false, reason: error.message }, 500);
    return json({ ok: true });
  }
  if (action === "story_delete") {
    const s = await getStory(); if (!s || s.author_id !== me.id) return json({ ok: false, reason: "not_found" }, 404);
    await sb.from("vcbe_insta_stories").update({ deleted_at: new Date().toISOString() }).eq("id", pid);
    return json({ ok: true });
  }
  if (action === "story_viewers") {
    const s = await getStory(); if (!s || s.author_id !== me.id) return json({ ok: false, reason: "not_found" }, 404);
    const { data: vw } = await sb.from("vcbe_insta_story_views").select("referee_id,liked,vote,created_at").eq("story_id", pid).order("created_at", { ascending: false });
    const rm = await refMap((vw || []).map((v: any) => v.referee_id));
    const urls = await sign(Object.values(rm).map((u: any) => u.avatar_path));
    return json({ ok: true, viewers: (vw || []).map((v: any) => ({ ...pubUser(rm[v.referee_id], urls), liked: v.liked, vote: v.vote })) });
  }

  if (action === "follow") {
    if (!UUID.test(pid) || pid === me.id) return json({ ok: false }, 400);
    if (body.on === false) await sb.from("vcbe_insta_follows").delete().eq("follower_id", me.id).eq("followee_id", pid);
    else await sb.from("vcbe_insta_follows").upsert({ follower_id: me.id, followee_id: pid }, { onConflict: "follower_id,followee_id", ignoreDuplicates: true });
    return json({ ok: true });
  }
  if (action === "follow_many") {
    const ids = (Array.isArray(body.ids) ? body.ids : []).map(String).filter((x: string) => UUID.test(x) && x !== me.id).slice(0, 100);
    if (ids.length) await sb.from("vcbe_insta_follows").upsert(ids.map((x: string) => ({ follower_id: me.id, followee_id: x })), { onConflict: "follower_id,followee_id", ignoreDuplicates: true });
    return json({ ok: true, n: ids.length });
  }

  if (action === "people") {
    const { data: refs } = await sb.from("vcbe_referees").select("id,name").eq("active", true).neq("id", me.id).order("name");
    const rm = await refMap((refs || []).map((r: any) => r.id));
    const urls = await sign(Object.values(rm).map((u: any) => u.avatar_path));
    const [{ data: f }, { data: fb }, { data: pc }] = await Promise.all([
      sb.from("vcbe_insta_follows").select("followee_id").eq("follower_id", me.id),
      sb.from("vcbe_insta_follows").select("follower_id").eq("followee_id", me.id),
      sb.from("vcbe_insta_posts").select("author_id").is("deleted_at", null).limit(2000),
    ]);
    const fol = new Set((f || []).map((x: any) => x.followee_id)), fby = new Set((fb || []).map((x: any) => x.follower_id));
    const np: Record<string, number> = {}; (pc || []).forEach((x: any) => np[x.author_id] = (np[x.author_id] || 0) + 1);
    const q = clean(body.q, 40).toLowerCase();
    const list = (refs || []).map((r: any) => ({ ...pubUser(rm[r.id], urls), following: fol.has(r.id), follows_you: fby.has(r.id), posts: np[r.id] || 0 }))
      .filter((u: any) => !q || u.name.toLowerCase().includes(q) || String(u.username || "").includes(q));
    return json({ ok: true, people: list });
  }

  if (action === "profile") {
    const id = UUID.test(pid) ? pid : me.id;
    const rm = await refMap([id]); if (!rm[id]) return json({ ok: false, reason: "not_found" }, 404);
    const urls = await sign([rm[id].avatar_path]);
    const { data: fo } = id === me.id ? { data: null } : await sb.from("vcbe_insta_follows").select("follower_id").eq("follower_id", me.id).eq("followee_id", id).maybeSingle();
    const { data: fb } = id === me.id ? { data: null } : await sb.from("vcbe_insta_follows").select("follower_id").eq("follower_id", id).eq("followee_id", me.id).maybeSingle();
    const { data: ps } = await sb.from("vcbe_insta_posts").select("id,media,created_at").eq("author_id", id).is("deleted_at", null).order("created_at", { ascending: false }).limit(120);
    const { data: rps } = await sb.from("vcbe_insta_reposts").select("post_id,created_at").eq("referee_id", id).order("created_at", { ascending: false }).limit(120);
    const rids = (rps || []).map((r: any) => r.post_id);
    const { data: rpp } = rids.length ? await sb.from("vcbe_insta_posts").select("id,media").in("id", rids).is("deleted_at", null) : { data: [] as any[] };
    const turls = await sign([...(ps || []), ...(rpp || [])].map((p: any) => p.media?.[0]?.poster || p.media?.[0]?.path));
    const cell = (p: any) => ({ id: p.id, thumb: turls[p.media?.[0]?.poster || p.media?.[0]?.path] || null, video: (p.media || []).some((m: any) => m.type === "video"), multi: (p.media || []).length > 1 });
    const rpm: Record<string, any> = {}; (rpp || []).forEach((p: any) => rpm[p.id] = p);
    return json({ ok: true, user: pubUser(rm[id], urls), me: id === me.id, following: !!fo, follows_you: !!fb, counts: await counts(id),
      grid: (ps || []).map(cell), reposts: rids.filter(x => rpm[x]).map(x => cell(rpm[x])) });
  }

  if (action === "activity") {
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    const { data: myPosts } = await sb.from("vcbe_insta_posts").select("id,media").eq("author_id", me.id).is("deleted_at", null).order("created_at", { ascending: false }).limit(300);
    const ids = (myPosts || []).map((p: any) => p.id);
    const [{ data: lk }, { data: cs }, { data: fo }] = await Promise.all([
      ids.length ? sb.from("vcbe_insta_likes").select("post_id,referee_id,created_at").in("post_id", ids).neq("referee_id", me.id).gt("created_at", since).order("created_at", { ascending: false }).limit(100) : Promise.resolve({ data: [] } as any),
      ids.length ? sb.from("vcbe_insta_comments").select("post_id,author_id,body,created_at").in("post_id", ids).neq("author_id", me.id).is("deleted_at", null).gt("created_at", since).order("created_at", { ascending: false }).limit(100) : Promise.resolve({ data: [] } as any),
      sb.from("vcbe_insta_follows").select("follower_id,created_at").eq("followee_id", me.id).gt("created_at", since).order("created_at", { ascending: false }).limit(100),
    ]);
    const rm = await refMap([...(lk || []).map((x: any) => x.referee_id), ...(cs || []).map((x: any) => x.author_id), ...(fo || []).map((x: any) => x.follower_id)]);
    const pm: Record<string, any> = {}; (myPosts || []).forEach((p: any) => pm[p.id] = p.media?.[0]?.poster || p.media?.[0]?.path);
    const urls = await sign([...Object.values(rm).map((u: any) => u.avatar_path), ...Object.values(pm)]);
    const { data: myF } = await sb.from("vcbe_insta_follows").select("followee_id").eq("follower_id", me.id);
    const fol = new Set((myF || []).map((x: any) => x.followee_id));
    const items = [
      ...(lk || []).map((x: any) => ({ kind: "like", at: x.created_at, user: pubUser(rm[x.referee_id], urls), post: x.post_id, thumb: urls[pm[x.post_id]] || null })),
      ...(cs || []).map((x: any) => ({ kind: "comment", at: x.created_at, user: pubUser(rm[x.author_id], urls), post: x.post_id, body: String(x.body).slice(0, 120), thumb: urls[pm[x.post_id]] || null })),
      ...(fo || []).map((x: any) => ({ kind: "follow", at: x.created_at, user: pubUser(rm[x.follower_id], urls), following: fol.has(x.follower_id) })),
    ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 120);
    return json({ ok: true, items });
  }

  if (action === "share") {
    const p = await getPost(); if (!p) return json({ ok: false, reason: "not_found" }, 404);
    const to = String(body.to || "all");
    let toId: string | null = null;
    if (to !== "all") {
      if (!UUID.test(to) || to === me.id) return json({ ok: false, reason: "bad_to" }, 400);
      const { data: r } = await sb.from("vcbe_referees").select("id").eq("id", to).eq("active", true).maybeSingle(); if (!r) return json({ ok: false, reason: "bad_to" }, 400);
      toId = to;
    }
    const rm = await refMap([p.author_id]);
    const au = rm[p.author_id];
    const note = clean(body.note, 500);
    // messaggio di testo nella chat di Drive; l'app riconosce [ic:<id>] e mostra la scheda del post
    const txt = `${note ? note + "\n" : ""}Instachallenge · @${au?.username || au?.name || ""}${p.caption ? ": " + String(p.caption).slice(0, 140) : ""}\n[ic:${p.id}]`;
    const { error } = await sb.from("vcbe_drive_messages").insert({ sender_id: me.id, to_id: toId, kind: "text", body: txt });
    if (error) return json({ ok: false, reason: error.message }, 500);
    return json({ ok: true });
  }

  return json({ error: "unknown action" }, 400);
});
