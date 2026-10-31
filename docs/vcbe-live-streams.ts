// vcbe-live-streams — Video Challenge BE (31/10/2026)
// Public read-only helper for the "Live streaming" button of the page "Matches of the week".
// Source: the agenda of https://watch.lottovolleyleague.be/agenda (JSON inside the page, element data-agenda-events:
// [{day:"2026-10-31", time:"19:45", title:"[CUP] Knack Roeselare - Waremme Volley", url:"/watch/cup-knack-roeselare-waremme-volley~e7fa1e3c50", start:<unix>}]).
// The stream pages have no VolleyAdmin match number, so each match of vcbe_assignments is paired with an agenda entry
// of the same day whose title contains BOTH team names (home first); ties -> start closest to 15 min before kick-off.
// The browser cannot read the agenda (no CORS header), so the app calls this function. The agenda is read at most
// every 10 minutes when matches are close, otherwise every 6 hours; links are stored in vcbe_stream_links.
// Response: { ok, fetched_at, links:[{match_code, match_date, url}] }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };
const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const AGENDA = 'https://watch.lottovolleyleague.be/agenda';
const NEAR_EVERY = 10 * 60_000;
const IDLE_EVERY = 6 * 3600_000;

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), {
  status, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' },
});

function nowBx() {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Brussels', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const o: Record<string, string> = {};
  for (const p of f.formatToParts(new Date())) o[p.type] = p.value;
  return Date.UTC(+o.year, +o.month - 1, +o.day, (+o.hour) % 24, +o.minute);
}
const startOf = (d: string, t: string) => { const [y, m, dd] = d.split('-').map(Number); const [h, mi] = (t || '00:00').split(':').map(Number); return Date.UTC(y, m - 1, dd, h || 0, mi || 0); };
const iso = (ts: number) => new Date(ts).toISOString().slice(0, 10);

const STOP = new Set(['volley', 'volleybal', 'volleyball', 'damesvolley', 'vc', 'vbc', 'vt', 'sab', 'diving', 'bao', 'avo', 'team', 'the', 'de', 'les', 'cup', 'tv', 'friendly', 'women', 'men']);
const words = (s: string) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/\[[^\]]*\]/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
const keyWords = (team: string) => words(team).filter((w) => w.length >= 3 && !STOP.has(w));

// returns {score, pos} if the title names this team (>= 2 key words, or >= 60% of them), else null
function teamIn(title: string[], team: string) {
  const kw = keyWords(team);
  if (!kw.length) return null;
  let hit = 0, pos = Infinity;
  for (const w of kw) { const i = title.indexOf(w); if (i >= 0) { hit++; pos = Math.min(pos, i); } }
  if (!(hit >= 2 || hit / kw.length >= 0.6)) return null;
  return { score: hit / kw.length, pos };
}

Deno.serve(async (r) => {
  if (r.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const sb = createClient(SB_URL, SB_KEY);
  const now = nowBx();
  const from = iso(now - 8 * 86400_000), to = iso(now + 8 * 86400_000);

  const { data: meta } = await sb.from('vcbe_stream_meta').select('*').eq('id', 1).maybeSingle();
  const age = Date.now() - (meta?.fetched_at ? Date.parse(meta.fetched_at) : 0);
  const { data: asg } = await sb.from('vcbe_assignments').select('match_code,match_date,match_time,home_team,away_team').gte('match_date', from).lte('match_date', to);
  const near = (asg || []).some((a: any) => { const s = startOf(a.match_date, a.match_time); return now >= s - 2 * 86400_000 && now <= s + 4 * 3600_000; });
  const due = age > (near ? NEAR_EVERY : IDLE_EVERY);

  let info: any = { fetched: false };
  if (due && (asg || []).length) {
    await sb.from('vcbe_stream_meta').update({ fetched_at: new Date().toISOString() }).eq('id', 1);
    try {
      const res = await fetch(AGENDA, { headers: { 'User-Agent': 'Mozilla/5.0 (VideoChallengeBE live streaming links)', Accept: 'text/html' } });
      if (!res.ok) throw new Error('agenda HTTP ' + res.status);
      const html = await res.text();
      const m = html.match(/data-agenda-events[^>]*>\s*(\[[\s\S]*?\])\s*</);
      if (!m) throw new Error('agenda events not found');
      const events = JSON.parse(m[1]);
      if (!Array.isArray(events)) throw new Error('agenda is not a list');
      const ev = events
        .filter((e: any) => e && typeof e.url === 'string' && /^\/watch\/[A-Za-z0-9._~-]+$/.test(e.url) && !/no stream/i.test(e.title || ''))
        .map((e: any) => ({ day: String(e.day || ''), time: String(e.time || ''), title: String(e.title || ''), url: e.url, w: words(e.title || '') }));
      const rows: any[] = [];
      for (const a of asg || []) {
        const kick = startOf(a.match_date, a.match_time);
        let best: any = null;
        for (const e of ev) {
          if (e.day !== a.match_date) continue;
          const h = teamIn(e.w, a.home_team), v = teamIn(e.w, a.away_team);
          if (!h || !v || h.pos >= v.pos) continue;
          const score = h.score + v.score, dist = Math.abs(startOf(e.day, e.time) - (kick - 15 * 60_000));
          if (!best || score > best.score || (score === best.score && dist < best.dist)) best = { ...e, score, dist };
        }
        if (best) rows.push({ match_code: a.match_code, match_date: a.match_date, url: best.url, title: best.title, stream_day: best.day, stream_time: best.time, updated_at: new Date().toISOString() });
      }
      if (rows.length) {
        const { error } = await sb.from('vcbe_stream_links').upsert(rows, { onConflict: 'match_code,match_date' });
        if (error) throw new Error(error.message);
      }
      await sb.from('vcbe_stream_meta').update({ ok: true, message: `agenda ${events.length} events`, found: rows.length }).eq('id', 1);
      info = { fetched: true, events: events.length, saved: rows.length };
    } catch (e) {
      await sb.from('vcbe_stream_meta').update({ ok: false, message: String((e as Error).message || e).slice(0, 300) }).eq('id', 1);
      info = { fetched: true, error: String((e as Error).message || e) };
    }
  }

  const { data: links } = await sb.from('vcbe_stream_links').select('match_code,match_date,url').order('match_date');
  const { data: m2 } = await sb.from('vcbe_stream_meta').select('fetched_at,ok').eq('id', 1).maybeSingle();
  return json({ ok: m2?.ok !== false, fetched_at: m2?.fetched_at || null, ...info, links: links || [] });
});
