-- SyncParty persistent database for Supabase
-- Version: 0.7.1
-- Run this entire script once in the Supabase SQL Editor.
-- The Node.js server uses the Supabase service role key, so these tables are
-- intentionally backend-managed. RLS is still enabled as defense-in-depth so
-- the tables are not directly writable/readable through the public API roles.

create extension if not exists pgcrypto;

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

create unique index if not exists users_provider_email_uidx
  on public.users (provider, email);

create unique index if not exists users_google_sub_uidx
  on public.users (google_sub)
  where google_sub is not null;

create table if not exists public.sessions (
  token_hash text primary key,
  user_id text not null references public.users(id) on delete cascade,
  created_at bigint not null,
  expires_at bigint not null
);

create index if not exists sessions_user_idx on public.sessions(user_id);
create index if not exists sessions_expires_idx on public.sessions(expires_at);

create table if not exists public.relations (
  id text primary key,
  user1_id text not null references public.users(id) on delete cascade,
  user2_id text not null references public.users(id) on delete cascade,
  created_at bigint not null,
  accepted_at bigint,
  constraint relations_distinct_users check (user1_id <> user2_id),
  constraint relations_sorted_users check (user1_id < user2_id)
);

create unique index if not exists relations_pair_uidx
  on public.relations(user1_id,user2_id);

create table if not exists public.invites (
  id text primary key,
  from_user_id text not null references public.users(id) on delete cascade,
  to_user_id text not null references public.users(id) on delete cascade,
  status text not null check (status in ('pending','accepted','declined')),
  created_at bigint not null,
  responded_at bigint,
  constraint invites_distinct_users check (from_user_id <> to_user_id)
);

create index if not exists invites_to_status_idx
  on public.invites(to_user_id,status,created_at desc);
create index if not exists invites_from_status_idx
  on public.invites(from_user_id,status,created_at desc);

create unique index if not exists invites_one_pending_direction_uidx
  on public.invites(from_user_id,to_user_id)
  where status = 'pending';

create table if not exists public.scrapbook_entries (
  id text primary key,
  user_id text not null references public.users(id) on delete cascade,
  scope text not null,
  relation_id text references public.relations(id) on delete cascade,
  source_key text not null,
  title text not null,
  kind text not null check (kind in ('movie','series','anime')),
  content_type text not null default 'movie' check (content_type in ('movie','series','anime')),
  canonical_title text,
  artwork text,
  thumbnail text,
  platform text not null default '',
  season integer,
  episode integer,
  progress numeric(5,4) not null default 0 check (progress >= 0 and progress <= 1),
  status text not null check (status in ('completed','watching','paused')),
  watch_duration_sec bigint not null default 0 check (watch_duration_sec >= 0),
  first_watched_at bigint not null,
  last_watched_at bigint not null,
  created_at bigint not null,
  updated_at bigint not null,
  constraint scrapbook_scope_check check (
    (scope = 'personal' and relation_id is null)
    or
    (scope like 'shared:%' and relation_id is not null)
  )
);

create unique index if not exists scrapbook_entry_identity_uidx
  on public.scrapbook_entries(user_id,scope,source_key);

create index if not exists scrapbook_entries_user_lastwatched_idx
  on public.scrapbook_entries(user_id,last_watched_at desc);

create index if not exists scrapbook_entries_relation_idx
  on public.scrapbook_entries(relation_id,last_watched_at desc);

-- Defense-in-depth: the Node.js API is the only application path intended to
-- access these tables, using the server-side Supabase service/secret key.
alter table public.users enable row level security;
alter table public.sessions enable row level security;
alter table public.relations enable row level security;
alter table public.invites enable row level security;
alter table public.scrapbook_entries enable row level security;

-- Do not grant application table access to anon/authenticated roles.
revoke all on table public.users from anon, authenticated;
revoke all on table public.sessions from anon, authenticated;
revoke all on table public.relations from anon, authenticated;
revoke all on table public.invites from anon, authenticated;
revoke all on table public.scrapbook_entries from anon, authenticated;

-- Keep full table access available to the backend service role.
grant all on table public.users to service_role;
grant all on table public.sessions to service_role;
grant all on table public.relations to service_role;
grant all on table public.invites to service_role;
grant all on table public.scrapbook_entries to service_role;

-- Optional cleanup helper for expired sessions. Safe to run manually or from a cron later.
create or replace function public.cleanup_expired_syncparty_sessions()
returns integer
language sql
security definer
set search_path = public
as $$
  with deleted as (
    delete from public.sessions where expires_at <= (extract(epoch from clock_timestamp()) * 1000)::bigint
    returning 1
  )
  select count(*)::integer from deleted;
$$;

revoke execute on function public.cleanup_expired_syncparty_sessions() from public, anon, authenticated;
grant execute on function public.cleanup_expired_syncparty_sessions() to service_role;


-- Scrapbook 2.0 migration for an existing Supabase database. Run after the original schema.
alter table public.scrapbook_entries drop constraint if exists scrapbook_entries_kind_check;
alter table public.scrapbook_entries add constraint scrapbook_entries_kind_check check (kind in ('movie','series','anime'));
alter table public.scrapbook_entries add column if not exists content_type text;
alter table public.scrapbook_entries add column if not exists canonical_title text;
alter table public.scrapbook_entries add column if not exists artwork text;
update public.scrapbook_entries set content_type = kind where content_type is null;
update public.scrapbook_entries set canonical_title = title where canonical_title is null;
alter table public.scrapbook_entries alter column content_type set default 'movie';
alter table public.scrapbook_entries alter column content_type set not null;
alter table public.scrapbook_entries add constraint scrapbook_entries_content_type_check check (content_type in ('movie','series','anime'));

-- Cinematic Memory migration: journey/insight fields, additive only.
-- together_duration_sec is intentionally a separate column from
-- watch_duration_sec, never derived from it — see sampleTogether() in
-- scrapbook-collector.js for exactly what it counts.
alter table public.scrapbook_entries add column if not exists together_duration_sec bigint not null default 0 check (together_duration_sec >= 0);
alter table public.scrapbook_entries add column if not exists session_count integer not null default 0 check (session_count >= 0);
alter table public.scrapbook_entries add column if not exists completed_at bigint;
alter table public.scrapbook_entries add column if not exists artwork_candidates jsonb not null default '[]'::jsonb;
-- Existing rows predate session counting; treat each as at least one
-- known session rather than leaving a misleading 0.
update public.scrapbook_entries set session_count = 1 where session_count = 0;
