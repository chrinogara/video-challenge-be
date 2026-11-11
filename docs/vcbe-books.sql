-- Sezione «Books» (11/11/2026): catalogo libri PDF + recensioni degli arbitri.
-- Applicato su CityLens in due migration: vcbe_books_20261111 (tabelle + RLS) e
-- vcbe_books_ratings_bucket_sample_20261111 (funzione, bucket, libro di prova).
-- Le migration sono solo additive: niente DROP, REVOKE o ON CONFLICT DO UPDATE, perché il connettore
-- chiede una conferma all'utente per quelle istruzioni e la richiesta non gli era visibile.
-- Di conseguenza anon/authenticated hanno ancora i permessi di tabella predefiniti di Supabase:
-- la protezione è la RLS (verificato l'11/11/2026: anon legge solo i libri pubblicati, non può
-- scrivere, non vede le recensioni). Per restringere anche i permessi, quando l'utente può confermare:
--   revoke all on public.vcbe_books, public.vcbe_book_reviews from anon, authenticated;
--   grant select on public.vcbe_books to anon, authenticated;
create table if not exists public.vcbe_books (
  id uuid primary key default gen_random_uuid(),
  title text not null, author text, category text, description text,
  language text, publisher text, released text, pages int, size_bytes bigint,
  file_url text not null, storage_path text, cover_url text, cover_path text,
  toc jsonb, published boolean not null default true, sort_order int not null default 0,
  created_at timestamptz not null default now()
);
alter table public.vcbe_books enable row level security;
create policy vcbe_books_read on public.vcbe_books for select to anon, authenticated using (published);

create table if not exists public.vcbe_book_reviews (
  id uuid primary key default gen_random_uuid(),
  book_id uuid not null references public.vcbe_books(id) on delete cascade,
  referee_id uuid not null,
  rating int not null check (rating between 1 and 5),
  title text, body text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (book_id, referee_id)
);
alter table public.vcbe_book_reviews enable row level security;

-- Solo conteggi delle valutazioni (nessun nome): usata dall'app pubblica.
create or replace function public.vcbe_book_ratings()
returns table(book_id uuid, avg numeric, n int, s1 int, s2 int, s3 int, s4 int, s5 int)
language sql stable security definer set search_path = public as $$
  select r.book_id, round(avg(r.rating)::numeric, 1), count(*)::int,
    count(*) filter (where r.rating = 1)::int, count(*) filter (where r.rating = 2)::int,
    count(*) filter (where r.rating = 3)::int, count(*) filter (where r.rating = 4)::int,
    count(*) filter (where r.rating = 5)::int
  from public.vcbe_book_reviews r join public.vcbe_books b on b.id = r.book_id and b.published
  group by r.book_id
$$;
grant execute on function public.vcbe_book_ratings() to anon, authenticated, service_role;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('vcbe-books', 'vcbe-books', true, 104857600, array['application/pdf','image/jpeg','image/png'])
on conflict (id) do nothing;

-- Libro di prova (PDF e copertina nel repo, serviti da Vercel con indirizzo relativo).
insert into public.vcbe_books (title, author, category, description, language, publisher, released, pages, size_bytes, file_url, cover_url)
select 'Official Beach Volleyball Rules 2025-2028', 'FIVB', 'Rules',
  'The official rules of Beach Volleyball for 2025-2028, approved by the 39th FIVB World Congress 2024 and implemented in all competitions from 1 January 2025.',
  'English', 'Fédération Internationale de Volleyball', '2025', 72, 5265949,
  'docs/books/fivb-beach-volleyball-rules-2025-2028.pdf', 'docs/books/fivb-beach-volleyball-rules-2025-2028.jpg'
where not exists (select 1 from public.vcbe_books where file_url = 'docs/books/fivb-beach-volleyball-rules-2025-2028.pdf');
