// vcbe-live-scores — Video Challenge BE (31/10/2026)
// Public read-only proxy of the unofficial VolleyAdmin live score feed (https://livescore.volleyadmin2.be/update).
// The browser cannot read that feed (no CORS header), so the app calls this function instead.
// It reads the feed at most once a minute (only when a match with a Video Referee is close to or in play;
// otherwise at most every 15 minutes, to save final results), keeps ONLY the matches of vcbe_assignments
// and stores them in vcbe_live_scores, so results stay visible in the previous weeks too.
// Response: { ok, fetched_at, scores:[{match_code, match_date, status live|final, sets_home, sets_away, set_scores:[[h,a],...]}] }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };
const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const FEED = 'https://livescore.volleyadmin2.be/update';
const LIVE_EVERY = 55_000;       // ms between feed reads around live matches
const IDLE_EVERY = 15 * 60_000;  // ms between feed reads otherwise (final results)

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), {
  status, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=30' },
});

// Brussels wall-clock time as a UTC timestamp (same trick as the app)
function nowBx() {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Brussels', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const o: Record<string, string> = {};
  for (const p of f.formatToParts(new Date())) o[p.type] = p.value;
  return Date.UTC(+o.year, +o.month - 1, +o.day, (+o.hour) % 24, +o.minute);
}
const startOf = (d: string, t: string) => { const [y, m, dd] = d.split('-').map(Number); const [h, mi] = (t || '00:00').split(':').map(Number); return Date.UTC(y, m - 1, dd, h || 0, mi || 0); };
const iso = (ts: number) => new Date(ts).toISOString().slice(0, 10);
const n = (v: unknown) => { const x = parseInt(String(v ?? ''), 10); return Number.isFinite(x) ? x : 0; };

function parseMatch(m: any) {
  // finished: match_score "0 - 3", match_sets "19/25, 21/25, 12/25"
  if (m.match_score && String(m.match_score).includes('-')) {
    const [h, a] = String(m.match_score).split('-').map((s: string) => n(s));
    const sets = String(m.match_sets || '').split(',').map((s: string) => s.trim()).filter(Boolean)
      .map((s: string) => s.split('/').map((x) => n(x)));
    return { status: 'final', sets_home: h, sets_away: a, set_scores: sets };
  }
  // in play: score_home / score_visitors = sets won, score_setNhome / score_setNvisitors = points
  if (m.score_set1home === undefined) return null;
  const sh = n(m.score_home), sa = n(m.score_visitors);
  const sets: number[][] = [];
  for (let s = 1; s <= 5; s++) sets.push([n(m['score_set' + s + 'home']), n(m['score_set' + s + 'visitors'])]);
  const played = sh + sa;
  const active = sh >= 3 || sa >= 3 ? played : played + 1;
  const list = sets.slice(0, Math.max(active, 0));
  if (!list.some(([a, b]) => a > 0 || b > 0)) return null; // not started yet
  return { status: sh >= 3 || sa >= 3 ? 'final' : 'live', sets_home: sh, sets_away: sa, set_scores: list };
}

Deno.serve(async (r) => {
  if (r.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const sb = createClient(SB_URL, SB_KEY);
  const now = nowBx();
  const today = iso(now);
  const from = iso(now - 8 * 86400_000), to = iso(now + 8 * 86400_000);

  const { data: meta } = await sb.from('vcbe_live_meta').select('*').eq('id', 1).maybeSingle();
  const last = meta?.fetched_at ? Date.parse(meta.fetched_at) : 0;
  const age = Date.now() - last;

  const { data: asg } = await sb.from('vcbe_assignments').select('match_code,match_date,match_time').gte('match_date', from).lte('match_date', to);
  const { data: have } = await sb.from('vcbe_live_scores').select('match_code,match_date,status').gte('match_date', from);
  const finals = new Set((have || []).filter((x: any) => x.status === 'final').map((x: any) => x.match_code + '|' + x.match_date));
  let liveWindow = false, missingFinal = false;
  for (const a of asg || []) {
    const s = startOf(a.match_date, a.match_time);
    if (now >= s - 15 * 60_000 && now <= s + 4 * 3600_000 && !finals.has(a.match_code + '|' + a.match_date)) liveWindow = true;
    if (now > s + 90 * 60_000 && a.match_date >= iso(now - 7 * 86400_000) && !finals.has(a.match_code + '|' + a.match_date)) missingFinal = true;
  }
  const due = (liveWindow && age > LIVE_EVERY) || (missingFinal && age > IDLE_EVERY);

  let fetchInfo: any = { fetched: false };
  if (due) {
    // claim the slot first, so parallel visitors do not all hit VolleyAdmin
    await sb.from('vcbe_live_meta').update({ fetched_at: new Date().toISOString() }).eq('id', 1);
    try {
      const res = await fetch(FEED, { headers: { 'User-Agent': 'Mozilla/5.0 (VideoChallengeBE live scores)', Accept: 'application/json' } });
      if (!res.ok) throw new Error('feed HTTP ' + res.status);
      const feed = await res.json();
      if (!Array.isArray(feed)) throw new Error('feed is not a list');
      const byKey = new Map<string, string>(); // code|dd/mm -> yyyy-mm-dd
      for (const a of asg || []) { const [y, m, d] = a.match_date.split('-'); byKey.set(a.match_code + '|' + d + '/' + m, a.match_date); }
      const rows: any[] = [];
      for (const m of feed) {
        const date = byKey.get(String(m.matchno || '').trim() + '|' + String(m.matchdate || '').trim());
        if (!date) continue;
        const p = parseMatch(m);
        if (!p) continue;
        rows.push({ match_code: String(m.matchno).trim(), match_date: date, ...p, source_match_id: String(m.matchid || ''), updated_at: new Date().toISOString() });
      }
      if (rows.length) {
        const { error } = await sb.from('vcbe_live_scores').upsert(rows, { onConflict: 'match_code,match_date' });
        if (error) throw new Error(error.message);
      }
      await sb.from('vcbe_live_meta').update({ ok: true, message: `feed ${feed.length} matches`, found: rows.length }).eq('id', 1);
      fetchInfo = { fetched: true, feed: feed.length, saved: rows.length };
    } catch (e) {
      await sb.from('vcbe_live_meta').update({ ok: false, message: String((e as Error).message || e).slice(0, 300) }).eq('id', 1);
      fetchInfo = { fetched: true, error: String((e as Error).message || e) };
    }
  }

  const { data: scores } = await sb.from('vcbe_live_scores')
    .select('match_code,match_date,status,sets_home,sets_away,set_scores,updated_at').order('match_date');
  const { data: m2 } = await sb.from('vcbe_live_meta').select('fetched_at,ok').eq('id', 1).maybeSingle();
  return json({ ok: m2?.ok !== false, fetched_at: m2?.fetched_at || null, today, live_window: liveWindow, ...fetchInfo, scores: scores || [] });
});
