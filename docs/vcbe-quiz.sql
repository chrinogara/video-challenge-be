-- Quiz per i Video Referee (16/11/2026, richiesta utente). Migration vcbe_quiz_20261116.
-- Domande con video, foto o situazione scritta + risposta Sì/No; accesso con nome + codice personale di Drive.
-- Tabelle con RLS senza policy: si leggono e scrivono SOLO tramite la edge function vcbe-quiz.
create table if not exists public.vcbe_quiz_items (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'text' check (kind in ('video','photo','text')),
  title text,
  situation text,
  question text not null,
  correct boolean not null,
  explanation text,
  media_url text,
  media_path text,
  published boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.vcbe_quiz_answers (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.vcbe_quiz_items(id) on delete cascade,
  referee_id uuid not null references public.vcbe_referees(id) on delete cascade,
  answer boolean not null,
  is_correct boolean not null,
  created_at timestamptz not null default now(),
  unique (item_id, referee_id)
);
create index if not exists vcbe_quiz_answers_ref_idx on public.vcbe_quiz_answers(referee_id);
alter table public.vcbe_quiz_items enable row level security;
alter table public.vcbe_quiz_answers enable row level security;
-- Bucket pubblico per foto e video caricati dall'admin (nomi casuali).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('vcbe-quiz','vcbe-quiz', true, 104857600, array['image/jpeg','image/png','image/webp','video/mp4','video/quicktime','video/webm','video/x-m4v'])
on conflict (id) do nothing;
