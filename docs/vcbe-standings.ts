// vcbe-standings — Video Challenge BE (25/11/2026)
// Public read-only proxy of the official VolleyAdmin standings (Lotto Volley League):
//   https://www.volleyadmin2.be/services/rangschikking_xml.php?reeks=LIGH  (men)
//   https://www.volleyadmin2.be/services/rangschikking_xml.php?reeks=LIGD  (women)
// The browser cannot read that XML (no CORS header), so the app calls this function.
// VolleyAdmin recalculates the standings as soon as a result is entered: the function re-reads
// the XML at most every REFRESH ms and keeps the last good copy in vcbe_standings (RLS, server only),
// so the table still shows if VolleyAdmin is down.
// Response: { ok, standings: { LIGH: {fetched_at, rows:[...]}, LIGD: {...} } }
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };
const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const SRC = 'https://www.volleyadmin2.be/services/rangschikking_xml.php?reeks=';
const SERIES = ['LIGH', 'LIGD'];
const REFRESH = 90_000;

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), {
  status, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=30' },
});
const tag = (s: string, k: string) => { const m = s.match(new RegExp('<' + k + '>([\\s\\S]*?)</' + k + '>')); return m ? m[1].trim() : ''; };
const num = (v: string) => { const x = parseInt(v, 10); return Number.isFinite(x) ? x : 0; };
const unent = (s: string) => s.replace(/&amp;/g, '&').replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

function parse(xml: string) {
  const rows: any[] = [];
  for (const m of xml.matchAll(/<rangschikking>([\s\S]*?)<\/rangschikking>/g)) {
    const b = m[1];
    if (tag(b, 'wedstrijdtype') && tag(b, 'wedstrijdtype') !== 'Hoofd') continue;
    const name = unent(tag(b, 'ploegnaam'));
    rows.push({
      pos: num(tag(b, 'volgorde')),
      team: name.replace(/\s+[A-Z]$/, ''),
      team_raw: name,
      team_id: tag(b, 'ploegid'),
      played: num(tag(b, 'aantalGespeeldeWedstrijden')),
      w30: num(tag(b, 'aantalGewonnen30_31')),
      w32: num(tag(b, 'aantalGewonnen32')),
      l23: num(tag(b, 'aantalVerloren32')),
      l03: num(tag(b, 'aantalVerloren30_31')),
      sets_won: num(tag(b, 'aantalGewonnenSets')),
      sets_lost: num(tag(b, 'aantalVerlorenSets')),
      points: num(tag(b, 'puntentotaal')),
      forfait: num(tag(b, 'forfait')),
    });
  }
  return rows.sort((a, b) => a.pos - b.pos);
}

async function fetchSeries(reeks: string) {
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), 9000);
  try {
    const r = await fetch(SRC + reeks, { signal: ctl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (VC Referee app)' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const buf = new Uint8Array(await r.arrayBuffer());
    let txt = new TextDecoder('utf-8').decode(buf);
    if (txt.includes('�')) txt = new TextDecoder('iso-8859-1').decode(buf);
    const rows = parse(txt);
    if (!rows.length) throw new Error('empty standings');
    return rows;
  } finally { clearTimeout(tm); }
}

Deno.serve(async (r) => {
  if (r.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const sb = createClient(SB_URL, SB_KEY);
  let force = false;
  try { const b = await r.json(); force = !!b?.force; } catch (_) { /* no body */ }
  const { data: cached } = await sb.from('vcbe_standings').select('*').in('reeks', SERIES);
  const by: Record<string, any> = {};
  for (const c of cached || []) by[c.reeks] = c;

  await Promise.all(SERIES.map(async (s) => {
    const c = by[s];
    const age = c ? Date.now() - Date.parse(c.fetched_at) : Infinity;
    if (!force && c && c.ok && age < REFRESH) return;
    if (!force && c && !c.ok && age < 30_000) return; // VolleyAdmin failing: do not hammer it
    try {
      const rows = await fetchSeries(s);
      const row = { reeks: s, rows, fetched_at: new Date().toISOString(), ok: true, error: null };
      await sb.from('vcbe_standings').upsert(row);
      by[s] = row;
    } catch (e) {
      const row = { reeks: s, rows: c?.rows || [], fetched_at: new Date().toISOString(), ok: false, error: String((e as Error)?.message || e) };
      await sb.from('vcbe_standings').upsert(row);
      by[s] = { ...row, fetched_at: c?.ok ? c.fetched_at : row.fetched_at };
    }
  }));

  const standings: Record<string, unknown> = {};
  for (const s of SERIES) standings[s] = { fetched_at: by[s]?.fetched_at || null, stale: by[s] ? !by[s].ok : true, rows: by[s]?.rows || [] };
  return json({ ok: true, standings });
});
