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
select 'Official Volleyball Rules 2025-2028', 'FIVB', 'Rules',
  'The official rules of Volleyball for 2025-2028, approved by the 39th FIVB World Congress 2024 and implemented in all competitions beginning after 1 January 2025.',
  'English', 'Fédération Internationale de Volleyball', '2025', 89, 5178252,
  'docs/books/fivb-volleyball-rules-2025-2028.pdf', 'docs/books/fivb-volleyball-rules-2025-2028.jpg'
where not exists (select 1 from public.vcbe_books where file_url = 'docs/books/fivb-volleyball-rules-2025-2028.pdf');

-- 11/11/2026 (migration vcbe_books_source_link_20261111): link alla fonte mostrato sotto la descrizione.
alter table public.vcbe_books add column if not exists source_url text;
alter table public.vcbe_books add column if not exists source_label text;

-- 11/11/2026 (migration vcbe_books_replace_with_volleyball_rules_20261111): su richiesta dell'utente il libro di prova
-- «Official Beach Volleyball Rules 2025-2028» è stato sostituito (stessa riga) da «Official Volleyball Rules 2025-2028» (FIVB, 89 pagine).
-- 11/11/2026: i documenti di «Browse documents» (vcbe_documents) diventano voci della sezione Documents (ex Books, vcbe_books),
-- divisi per argomento (category = rules | vc | tech | training | other). vcbe_documents resta invariata (nessuna riga cancellata).
update public.vcbe_books set category = 'rules', sort_order = 0 where file_url = 'docs/books/fivb-volleyball-rules-2025-2028.pdf';
insert into public.vcbe_books (title, author, category, description, language, publisher, released, pages, size_bytes, file_url, cover_url, source_label, source_url, sort_order, created_at)
select v.title, v.author, v.category, v.description, v.language, v.publisher, v.released, v.pages, v.size_bytes, v.file_url, v.cover_url, v.source_label, v.source_url, v.sort_order, d.created_at
from (values
 ('2cf5e28b-7461-4d0d-8ca9-58f062dad331'::uuid,'FIVB VCHR','FIVB','rules','The Volleyball Video Challenge System Regulations 2026: how teams and referees request and review challenges, and the new initiatives of the 2026 review.','English','FIVB','2026',5,234419::bigint,'https://apbusqbeneppepfkvklv.supabase.co/storage/v1/object/public/vcbe-documents/1783976804585_vcs-regs-2026-5.pdf','docs/books/covers/fivb-vcs-regulations-2026.jpg','FIVB','https://www.fivb.com/',1),
 ('3caddfcd-23c0-484c-b303-0fb00b1ae9cf'::uuid,'VChallenge Rules 2025/26 BE','Volley Belgium','rules','Video Challenge System – Indoor Volleyball 2025–2028, Belgian version: roles of Video Referee and Operator, challenge requests, eligible situations, procedure, timing and displays.','English','Volley Belgium','2025',7,255479::bigint,'https://apbusqbeneppepfkvklv.supabase.co/storage/v1/object/public/vcbe-documents/1783975478731_Vcs_Regulation_2025_BE.pdf','docs/books/covers/vchallenge-rules-2025-26-be.jpg',null,null,2),
 ('f9629387-d8de-4f65-a4d9-a784cf523d2c'::uuid,'VBRS 1','Volley Belgium','rules','Video Challenge System Regulations 2025 of Volley Belgium and the National Referee Commission.','English','Volley Belgium','2025',5,231345::bigint,'https://apbusqbeneppepfkvklv.supabase.co/storage/v1/object/public/vcbe-documents/1783975618282_VBRS_1.pdf','docs/books/covers/vbrs-1.jpg',null,null,3),
 ('b1cd8a00-cf4e-4d85-a747-bcf01fe6918b'::uuid,'Casebook','FIVB','rules','Casebook chapter 9 – Using technology: cases on headsets, e-scoresheet and the Video Challenge System, with rulings.','English','FIVB',null,3,181898::bigint,'https://apbusqbeneppepfkvklv.supabase.co/storage/v1/object/public/vcbe-documents/1783975581739_Casebook_.pdf','docs/books/covers/casebook.jpg','FIVB','https://www.fivb.com/',4),
 ('2f219e1f-02f5-45d1-a0d7-b6c0fabf4ad7'::uuid,'VChallenge Protocoll',null,'vc','VideoChallenge Referee official guide: role and responsibilities, pre-match diagnostics, camera map, challenge protocol, review methods and end of match.','English',null,null,15,794147::bigint,'https://apbusqbeneppepfkvklv.supabase.co/storage/v1/object/public/vcbe-documents/1783975252144_VChallenge_Protocoll.pdf','docs/books/covers/vchallenge-protocoll.jpg',null,null,0),
 ('6c5699b0-1242-4f8d-81de-ddde98fd4b14'::uuid,'Belgian VCHR','Volley Belgium','vc','Belgian Variant 3 challenge request procedure: how the FIVB 2025 guidelines are applied in Belgium, with the tasks of the referees and the Challenge Operator.','English','Volley Belgium','2025',9,2517527::bigint,'https://apbusqbeneppepfkvklv.supabase.co/storage/v1/object/public/vcbe-documents/1783975561261_Belgian_VCHR.pdf','docs/books/covers/belgian-vchr.jpg',null,null,1),
 ('e6697240-a3f7-4c17-a1b3-18621c66144c'::uuid,'VChallenge guidelines BE','Volley Belgium','vc','Challenge guidelines 2025-2026 for Belgium: what has changed, possible challenges and decisions.','English','Volley Belgium','2025',5,352245::bigint,'https://apbusqbeneppepfkvklv.supabase.co/storage/v1/object/public/vcbe-documents/1783975428912_Challenge_guidelines_2025-2026_-_Belgium_-_VBRS_-_DRAFT.pdf','docs/books/covers/vchallenge-guidelines-be.jpg',null,null,2),
 ('d3bfc1a1-2e7f-4696-816a-6ef5f071b5be'::uuid,'VBRS 2','Volley Belgium','vc','Video Challenge System guidelines and instructions 2025: responsibilities of the club, system preparation and timing.','English','Volley Belgium','2025',3,186025::bigint,'https://apbusqbeneppepfkvklv.supabase.co/storage/v1/object/public/vcbe-documents/1783975624989_VBRS_2.pdf','docs/books/covers/vbrs-2.jpg',null,null,3),
 ('85217bf8-ac91-4b3f-8488-0be68f7990ac'::uuid,'e-Scoresheet Tablet Guide','Data Project','tech','e-Scoresheet tablet app guide (release 1.2.12, Android and Windows).','English','Data Project – Genius Sports',null,12,2497333::bigint,'docs/TabletGuidelines.pdf','docs/books/covers/e-scoresheet-tablet-guide.jpg','Data Project','https://www.dataproject.com/',0),
 ('869abb5b-9ca5-4c21-b151-591912126d2d'::uuid,'Headsets VCh',null,'tech','User manual of the headset for 4 users: pairing and use. English, Dutch and French.','English, Dutch, French',null,null,6,515957::bigint,'https://apbusqbeneppepfkvklv.supabase.co/storage/v1/object/public/vcbe-documents/1783975661395_Headset_4_-_ENG-NED-FRA.pdf','docs/books/covers/headsets-vch.jpg',null,null,1),
 ('dc3246a8-5ac7-4b06-adbf-e1bab0c1ca51'::uuid,'Reset headsets EJEAS V4',null,'tech','EJEAS / Vnetphone V4 intercom reset guide: which buttons to press to clear the pairing.','English',null,null,2,490160::bigint,'docs/Reset_EJEAS_V4.pdf','docs/books/covers/reset-headsets-ejeas-v4.jpg',null,null,2),
 ('056a2189-353c-4582-8de2-90a71571341a'::uuid,'Split - QTag','VideoCheck','training','Video Operator quick guide to SPLIT and Q-TAG in VideoCheck, with real match screenshots.','English',null,null,9,1307728::bigint,'https://apbusqbeneppepfkvklv.supabase.co/storage/v1/object/public/vcbe-documents/1794143271770_VideoCheck_Training_CORRECTED.pdf','docs/books/covers/split-qtag.jpg',null,null,0)
) as v(doc_id,title,author,category,description,language,publisher,released,pages,size_bytes,file_url,cover_url,source_label,source_url,sort_order)
join public.vcbe_documents d on d.id = v.doc_id
where not exists (select 1 from public.vcbe_books b where b.file_url = v.file_url);
