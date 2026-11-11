-- Instachallenge (11/11/2026, richiesta utente). Migration vcbe_insta_20261111.
-- Tutte le tabelle: RLS attiva senza policy (accesso solo dalla edge function vcbe-insta con service role).
create table if not exists vcbe_insta_profiles (
  referee_id uuid primary key references vcbe_referees(id) on delete cascade,
  username text unique not null,
  bio text,
  avatar_path text,
  onboarded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists vcbe_insta_posts (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references vcbe_referees(id) on delete cascade,
  caption text,
  media jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists vcbe_insta_posts_created on vcbe_insta_posts (created_at desc) where deleted_at is null;
create index if not exists vcbe_insta_posts_author on vcbe_insta_posts (author_id, created_at desc);
create table if not exists vcbe_insta_likes (
  post_id uuid not null references vcbe_insta_posts(id) on delete cascade,
  referee_id uuid not null references vcbe_referees(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, referee_id)
);
create table if not exists vcbe_insta_saves (
  post_id uuid not null references vcbe_insta_posts(id) on delete cascade,
  referee_id uuid not null references vcbe_referees(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, referee_id)
);
create table if not exists vcbe_insta_comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references vcbe_insta_posts(id) on delete cascade,
  parent_id uuid references vcbe_insta_comments(id) on delete cascade,
  author_id uuid not null references vcbe_referees(id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists vcbe_insta_comments_post on vcbe_insta_comments (post_id, created_at);
create table if not exists vcbe_insta_comment_likes (
  comment_id uuid not null references vcbe_insta_comments(id) on delete cascade,
  referee_id uuid not null references vcbe_referees(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (comment_id, referee_id)
);
create table if not exists vcbe_insta_follows (
  follower_id uuid not null references vcbe_referees(id) on delete cascade,
  followee_id uuid not null references vcbe_referees(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_id, followee_id)
);
create table if not exists vcbe_insta_reposts (
  post_id uuid not null references vcbe_insta_posts(id) on delete cascade,
  referee_id uuid not null references vcbe_referees(id) on delete cascade,
  thought text,
  created_at timestamptz not null default now(),
  primary key (post_id, referee_id)
);
create table if not exists vcbe_insta_stories (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null references vcbe_referees(id) on delete cascade,
  media_path text not null,
  media_type text not null default 'image',
  poster_path text,
  text text,
  poll jsonb,
  question text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '24 hours',
  deleted_at timestamptz
);
create index if not exists vcbe_insta_stories_exp on vcbe_insta_stories (expires_at desc);
create table if not exists vcbe_insta_story_views (
  story_id uuid not null references vcbe_insta_stories(id) on delete cascade,
  referee_id uuid not null references vcbe_referees(id) on delete cascade,
  liked boolean not null default false,
  vote smallint,
  created_at timestamptz not null default now(),
  primary key (story_id, referee_id)
);
alter table vcbe_insta_profiles enable row level security;
alter table vcbe_insta_posts enable row level security;
alter table vcbe_insta_likes enable row level security;
alter table vcbe_insta_saves enable row level security;
alter table vcbe_insta_comments enable row level security;
alter table vcbe_insta_comment_likes enable row level security;
alter table vcbe_insta_follows enable row level security;
alter table vcbe_insta_reposts enable row level security;
alter table vcbe_insta_stories enable row level security;
alter table vcbe_insta_story_views enable row level security;
revoke all on vcbe_insta_profiles, vcbe_insta_posts, vcbe_insta_likes, vcbe_insta_saves, vcbe_insta_comments,
  vcbe_insta_comment_likes, vcbe_insta_follows, vcbe_insta_reposts, vcbe_insta_stories, vcbe_insta_story_views from anon, authenticated;
-- bucket privato per foto e video (50 MB per file, solo immagini e video)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('vcbe-insta', 'vcbe-insta', false, 52428800, array['image/*','video/*'])
on conflict (id) do update set public = false, file_size_limit = 52428800, allowed_mime_types = array['image/*','video/*'];
