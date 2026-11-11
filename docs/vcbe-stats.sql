-- Statistiche visite dell'app (11/11/2026, richiesta utente) — migration vcbe_app_stats_20261111
-- Solo dati anonimi: id casuale del browser (localStorage), sezione aperta, tipo di dispositivo, lingua.
-- Nessun IP, nessun user agent, nessuna email. Il nome compare solo per gli arbitri collegati a Drive (sessione vcbe_drive_sessions).
-- Tabelle con RLS senza policy: scritte e lette solo dalla edge function vcbe-stats (service role).
create table if not exists public.vcbe_app_visitors(
  visitor_id text primary key,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  referee_id uuid,
  device text,
  lang text,
  sessions int not null default 1
);
create table if not exists public.vcbe_app_presence(
  session_id text primary key,
  visitor_id text not null,
  referee_id uuid,
  page text,
  device text,
  lang text,
  started_at timestamptz not null default now(),
  last_seen timestamptz not null default now()
);
create index if not exists vcbe_app_presence_seen on public.vcbe_app_presence(last_seen);
create table if not exists public.vcbe_app_events(
  id bigserial primary key,
  created_at timestamptz not null default now(),
  visitor_id text not null,
  session_id text,
  referee_id uuid,
  kind text not null default 'view',   -- view | action | error
  name text not null
);
create index if not exists vcbe_app_events_created on public.vcbe_app_events(created_at);
create index if not exists vcbe_app_events_kind on public.vcbe_app_events(kind, created_at);
alter table public.vcbe_app_visitors enable row level security;
alter table public.vcbe_app_presence enable row level security;
alter table public.vcbe_app_events enable row level security;

-- Aggregati per il pannello admin. p_days: 1 = oggi, 7, 30, 0 = tutto. Ora di Bruxelles.
-- Rifiuta anon/authenticated (la funzione è chiamata solo da vcbe-stats).
create or replace function public.vcbe_app_stats(p_days int default 7)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  tz constant text := 'Europe/Brussels';
  today date := (now() at time zone tz)::date;
  t0 timestamptz := (today::timestamp at time zone tz);
  pfrom timestamptz;
  r jsonb;
begin
  -- via API (PostgREST) solo service_role; senza claims = SQL diretto dal database
  if coalesce(nullif(current_setting('request.jwt.claims', true),'')::jsonb->>'role','service_role') <> 'service_role' then
    raise exception 'not allowed';
  end if;
  pfrom := case when coalesce(p_days,0) <= 0 then '-infinity'::timestamptz
                when p_days = 1 then t0
                else ((today - (p_days-1))::timestamp at time zone tz) end;
  select jsonb_build_object(
    'now', now(),
    'live', coalesce((select jsonb_agg(jsonb_build_object(
        'sid', right(p.session_id,6), 'vid', right(p.visitor_id,4), 'name', rf.name, 'page', p.page,
        'device', p.device, 'lang', p.lang, 'started_at', p.started_at, 'last_seen', p.last_seen,
        'new', (v.first_seen >= now() - interval '1 hour'))
        order by p.started_at)
      from vcbe_app_presence p left join vcbe_referees rf on rf.id = p.referee_id
      left join vcbe_app_visitors v on v.visitor_id = p.visitor_id
      where p.last_seen > now() - interval '75 seconds'), '[]'::jsonb),
    'totals', jsonb_build_object(
      'today', (select count(distinct visitor_id) from vcbe_app_events where created_at >= t0),
      'd7', (select count(distinct visitor_id) from vcbe_app_events where created_at >= ((today-6)::timestamp at time zone tz)),
      'd30', (select count(distinct visitor_id) from vcbe_app_events where created_at >= ((today-29)::timestamp at time zone tz)),
      'all', (select count(*) from vcbe_app_visitors),
      'new_today', (select count(*) from vcbe_app_visitors where first_seen >= t0),
      'views_today', (select count(*) from vcbe_app_events where kind='view' and created_at >= t0),
      'views_period', (select count(*) from vcbe_app_events where kind='view' and created_at >= pfrom),
      'visitors_period', (select count(distinct visitor_id) from vcbe_app_events where created_at >= pfrom),
      'referees_period', (select count(distinct referee_id) from vcbe_app_events where referee_id is not null and created_at >= pfrom),
      'since', (select min(first_seen) from vcbe_app_visitors)),
    'sections', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'views', n, 'visitors', u) order by n desc)
      from (select name, count(*) n, count(distinct visitor_id) u from vcbe_app_events
            where kind='view' and created_at >= pfrom group by name) s), '[]'::jsonb),
    'actions', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'n', n, 'visitors', u) order by n desc)
      from (select name, count(*) n, count(distinct visitor_id) u from vcbe_app_events
            where kind='action' and created_at >= pfrom group by name) s), '[]'::jsonb),
    'errors', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'n', n, 'visitors', u, 'last', l) order by l desc)
      from (select name, count(*) n, count(distinct visitor_id) u, max(created_at) l from vcbe_app_events
            where kind='error' and created_at >= pfrom group by name order by max(created_at) desc limit 15) s), '[]'::jsonb),
    'hourly', (select jsonb_agg(jsonb_build_object('h', h, 'views', coalesce(x.n,0), 'visitors', coalesce(x.u,0)) order by h)
      from generate_series(0,23) h left join (
        select extract(hour from created_at at time zone tz)::int hh, count(*) filter (where kind='view') n, count(distinct visitor_id) u
        from vcbe_app_events where created_at >= t0 group by 1) x on x.hh = h),
    'daily', (select jsonb_agg(jsonb_build_object('d', d, 'views', coalesce(x.n,0), 'visitors', coalesce(x.u,0)) order by d)
      from (select (today - k) d from generate_series(0,29) k) dd
      left join (
        select (created_at at time zone tz)::date dy, count(*) filter (where kind='view') n, count(distinct visitor_id) u
        from vcbe_app_events where created_at >= ((today-29)::timestamp at time zone tz) group by 1) x on x.dy = dd.d),
    'devices', coalesce((select jsonb_object_agg(coalesce(device,'?'), n) from (
        select v.device, count(*) n from vcbe_app_visitors v
        where v.visitor_id in (select distinct visitor_id from vcbe_app_events where created_at >= pfrom) group by 1) s), '{}'::jsonb),
    'langs', coalesce((select jsonb_object_agg(coalesce(lang,'?'), n) from (
        select v.lang, count(*) n from vcbe_app_visitors v
        where v.visitor_id in (select distinct visitor_id from vcbe_app_events where created_at >= pfrom) group by 1) s), '{}'::jsonb),
    'referees', coalesce((select jsonb_agg(jsonb_build_object('name', rf.name, 'views', s.n, 'last', s.l) order by s.l desc)
      from (select referee_id, count(*) n, max(created_at) l from vcbe_app_events
            where referee_id is not null and created_at >= pfrom group by 1) s join vcbe_referees rf on rf.id = s.referee_id), '[]'::jsonb)
  ) into r;
  return r;
end $$;
