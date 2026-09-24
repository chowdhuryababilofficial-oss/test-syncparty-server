-- SyncParty persistent database for Supabase
-- Version: 0.7.3 (Our Story lifecycle + season/episode heal)
--
-- SAFE TO RUN AS A WHOLE, on a FRESH database AND on an EXISTING one, and
-- safe to re-run any number of times.
--
-- Ordering matters and is now correct: every CREATE TABLE comes before any
-- ALTER TABLE that touches it. The previous revision of this file altered
-- public.relations and public.scrapbook_entries near the top, before those
-- tables were created, so it aborted on a fresh database. Every ADD
-- CONSTRAINT is also now preceded by DROP CONSTRAINT IF EXISTS, so a second
-- run cannot fail with "constraint already exists".
--
-- The Node.js server uses the Supabase service role key, so these tables are
-- intentionally backend-managed. RLS is still enabled as defense-in-depth so
-- the tables are not directly writable/readable through the public API roles.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------

create table if not exists public.users (
  id text primary key,
  email text not null,
  name text not null,
  avatar text not null default '🦊',
  color text not null default '#54a0ff',
  provider text not null check (provider in ('email','google')),
  password_hash text,
  password_salt text,
  google_sub text,
  created_at bigint not null
);

create table if not exists public.sessions (
  token_hash text primary key,
  user_id text not null references public.users(id) on delete cascade,
  created_at bigint not null,
  expires_at bigint not null
);

create table if not exists public.relations (
  id text primary key,
  user1_id text not null references public.users(id) on delete cascade,
  user2_id text not null references public.users(id) on delete cascade,
  created_at bigint not null,
  accepted_at bigint,
  constraint relations_distinct_users check (user1_id <> user2_id)
);

create table if not exists public.invites (
  id text primary key,
  from_user_id text not null references public.users(id) on delete cascade,
  to_user_id text not null references public.users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','accepted','declined')),
  created_at bigint not null,
  responded_at bigint,
  constraint invites_distinct_users check (from_user_id <> to_user_id)
);

create table if not exists public.scrapbook_entries (
  id text primary key,
  user_id text not null references public.users(id) on delete cascade,
  scope text not null default 'personal',
  relation_id text references public.relations(id) on delete set null,
  source_key text not null,
  title text not null,
  kind text not null,
  content_type text not null default 'movie',
  canonical_title text,
  artwork text,
  artwork_candidates jsonb not null default '[]'::jsonb,
  backdrop text,
  thumbnail text,
  metadata_provider text not null default '',
  metadata_id text not null default '',
  metadata_year integer,
  platform text not null default '',
  season integer,
  episode integer,
  episode_title text,
  story_total_episodes integer not null default 0,
  story_episodes_completed integer not null default 0,
  story_progress numeric(5,4),
  story_progress_confidence numeric(5,4),
  series_episode_counts jsonb,
  progress numeric(5,4) check (progress >= 0 and progress <= 1),
  status text check (status in ('completed','watching','paused')),
  watch_duration_sec bigint not null default 0,
  together_duration_sec bigint not null default 0,
  session_count integer not null default 0,
  completed_at bigint,
  first_watched_at bigint not null,
  last_watched_at bigint not null,
  created_at bigint not null default 0,
  updated_at bigint not null default 0,
  archived_at bigint
);

-- ---------------------------------------------------------------------------
-- 2. Additive columns (safe on existing databases, no-ops on a fresh one)
-- ---------------------------------------------------------------------------

-- Party Identity: the social identity shown to other SyncParty users.
-- Deliberately separate from name/email (Google/OAuth identity) so signing in
-- can never overwrite a user's Party Name / emoji PFP / party color.
alter table public.users add column if not exists party_name text;
alter table public.users add column if not exists party_avatar text;
alter table public.users add column if not exists party_color text;

-- Ending or archiving an Our Story is non-destructive: the relation row and all
-- shared memories are kept, only stamped so the story is no longer active.
alter table public.relations add column if not exists archived_at bigint;
alter table public.relations add column if not exists ended_at bigint;

-- Scrapbook 2.0 / Cinematic Memory / episode-experience columns.
alter table public.scrapbook_entries add column if not exists content_type text;
alter table public.scrapbook_entries add column if not exists canonical_title text;
alter table public.scrapbook_entries add column if not exists artwork text;
alter table public.scrapbook_entries add column if not exists artwork_candidates jsonb not null default '[]'::jsonb;
alter table public.scrapbook_entries add column if not exists backdrop text;
alter table public.scrapbook_entries add column if not exists metadata_provider text not null default '';
alter table public.scrapbook_entries add column if not exists metadata_id text not null default '';
alter table public.scrapbook_entries add column if not exists metadata_year integer;
alter table public.scrapbook_entries add column if not exists season integer;
alter table public.scrapbook_entries add column if not exists episode integer;
-- Episode title. Nullable on purpose: it is only written when a reliable
-- source exists (JSON-LD TVEpisode name, or the TMDB episode name). NULL
-- means "unknown", and the UI shows "Episode N" rather than guessing.
alter table public.scrapbook_entries add column if not exists episode_title text;
alter table public.scrapbook_entries add column if not exists story_total_episodes integer not null default 0;
alter table public.scrapbook_entries add column if not exists story_episodes_completed integer not null default 0;
alter table public.scrapbook_entries add column if not exists story_progress numeric(5,4);
alter table public.scrapbook_entries add column if not exists story_progress_confidence numeric(5,4);
alter table public.scrapbook_entries add column if not exists series_episode_counts jsonb;
-- together_duration_sec is intentionally a separate column from
-- watch_duration_sec, never derived from it — see sampleTogether() in
-- scrapbook-collector.js for exactly what it counts.
alter table public.scrapbook_entries add column if not exists together_duration_sec bigint not null default 0;
alter table public.scrapbook_entries add column if not exists session_count integer not null default 0;
alter table public.scrapbook_entries add column if not exists completed_at bigint;
-- Archived memories stay saved and remain viewable read-only.
alter table public.scrapbook_entries add column if not exists archived_at bigint;

-- ---------------------------------------------------------------------------
-- 3. Backfills for pre-existing rows
-- ---------------------------------------------------------------------------

update public.scrapbook_entries set content_type = kind where content_type is null;
update public.scrapbook_entries set canonical_title = title where canonical_title is null;
-- Existing rows predate session counting; treat each as at least one known
-- session rather than leaving a misleading 0.
update public.scrapbook_entries set session_count = 1 where session_count = 0;

alter table public.scrapbook_entries alter column content_type set default 'movie';
alter table public.scrapbook_entries alter column content_type set not null;

-- ---------------------------------------------------------------------------
-- 4. Constraints (drop-then-add so re-runs are safe)
-- ---------------------------------------------------------------------------

alter table public.scrapbook_entries drop constraint if exists scrapbook_entries_kind_check;
alter table public.scrapbook_entries add constraint scrapbook_entries_kind_check
  check (kind in ('movie','series','anime','manual'));

alter table public.scrapbook_entries drop constraint if exists scrapbook_entries_content_type_check;
alter table public.scrapbook_entries add constraint scrapbook_entries_content_type_check
  check (content_type in ('movie','series','anime','manual'));

alter table public.scrapbook_entries drop constraint if exists scrapbook_scope_check;
alter table public.scrapbook_entries add constraint scrapbook_scope_check
  check (scope = 'personal' or scope like 'shared:%');

alter table public.scrapbook_entries drop constraint if exists scrapbook_entries_together_nonneg;
alter table public.scrapbook_entries add constraint scrapbook_entries_together_nonneg
  check (together_duration_sec >= 0);

alter table public.scrapbook_entries drop constraint if exists scrapbook_entries_session_count_nonneg;
alter table public.scrapbook_entries add constraint scrapbook_entries_session_count_nonneg
  check (session_count >= 0);

-- ---------------------------------------------------------------------------
-- 5. Indexes
-- ---------------------------------------------------------------------------

create unique index if not exists users_provider_email_uidx
  on public.users (provider, email);

create unique index if not exists users_google_sub_uidx
  on public.users (google_sub)
  where google_sub is not null;

create index if not exists sessions_user_idx on public.sessions(user_id);
create index if not exists sessions_expires_idx on public.sessions(expires_at);

create unique index if not exists relations_pair_uidx
  on public.relations (least(user1_id, user2_id), greatest(user1_id, user2_id));

create index if not exists invites_to_user_idx on public.invites(to_user_id, status);
create index if not exists invites_from_user_idx on public.invites(from_user_id, status);

-- One row per (user, scope, source_key). Because the client's source key
-- includes season+episode for episodic content, this is exactly what keeps
-- each watched episode as its own row while preventing duplicate rows when
-- the same episode is re-watched or re-uploaded.
create unique index if not exists scrapbook_entry_identity_uidx
  on public.scrapbook_entries(user_id, scope, source_key);

create index if not exists scrapbook_entries_user_lastwatched_idx
  on public.scrapbook_entries(user_id, last_watched_at desc);

create index if not exists scrapbook_entries_relation_idx
  on public.scrapbook_entries(relation_id);

-- Fast season/episode ordering for the episode browser.
create index if not exists scrapbook_entries_episode_idx
  on public.scrapbook_entries(user_id, scope, canonical_title, season, episode);

-- ---------------------------------------------------------------------------
-- 6. RLS and grants
-- ---------------------------------------------------------------------------

alter table public.users enable row level security;
alter table public.sessions enable row level security;
alter table public.relations enable row level security;
alter table public.invites enable row level security;
alter table public.scrapbook_entries enable row level security;

revoke all on public.users from anon, authenticated;
revoke all on public.sessions from anon, authenticated;
revoke all on public.relations from anon, authenticated;
revoke all on public.invites from anon, authenticated;
revoke all on public.scrapbook_entries from anon, authenticated;

grant all on public.users to service_role;
grant all on public.sessions to service_role;
grant all on public.relations to service_role;
grant all on public.invites to service_role;
grant all on public.scrapbook_entries to service_role;

-- ---------------------------------------------------------------------------
-- 7. Maintenance function
-- ---------------------------------------------------------------------------

create or replace function public.cleanup_expired_syncparty_sessions()
returns integer
language sql
security definer
set search_path = public
as $$
  with deleted as (
    delete from public.sessions
    where expires_at < (extract(epoch from now()) * 1000)::bigint
    returning 1
  )
  select count(*)::integer from deleted;
$$;

revoke execute on function public.cleanup_expired_syncparty_sessions() from public, anon, authenticated;
grant execute on function public.cleanup_expired_syncparty_sessions() to service_role;

-- ---------------------------------------------------------------------------
-- 8. One-time data heal: season/episode 0 means "unknown", not "zero"
-- ---------------------------------------------------------------------------
-- Older builds coerced an unknown season/episode to 0 (Number(null) === 0),
-- which the UI then rendered as "Season 0 / Episode 0". The application code
-- now stores NULL for unknown, and this statement heals rows written before
-- that fix. It is idempotent: a second run matches nothing.

update public.scrapbook_entries set season = null where season is not null and season <= 0;
update public.scrapbook_entries set episode = null where episode is not null and episode <= 0;
