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

-- ===========================================================================
-- 9. Scrapbook v2: Story Chapters, shared memories, sittings, journey state
-- ===========================================================================
-- STRICTLY ADDITIVE and safe to re-run. Nothing below drops a table or a
-- column, renames anything, or deletes a legacy scrapbook row. Legacy
-- shared copies (scope 'shared:<relation>') stay in scrapbook_entries and are
-- only LINKED to their merged v2 memory by the backfill script
-- (scripts/scrapbook-v2-backfill.js, run with --dry-run first).

-- 9.1 Story Chapters. A chapter is created when a Story starts or restarts
-- and is immutable once ended_at is set (enforced by the application and by
-- the trigger below). Restarting a Story always creates a NEW chapter id.
create table if not exists public.story_chapters (
  id text primary key,
  relation_id text not null references public.relations(id),
  chapter_no integer not null,
  started_at bigint not null,
  ended_at bigint,
  end_mode text,
  ended_by text,
  legacy boolean not null default false,
  created_at bigint not null
);
create unique index if not exists story_chapters_relation_no_idx on public.story_chapters (relation_id, chapter_no);
create unique index if not exists story_chapters_one_open_idx on public.story_chapters (relation_id) where ended_at is null;

-- A closed chapter can never be changed, reopened or deleted. An open
-- chapter's only legal change is being closed (ended_at / end_mode /
-- ended_by); its identity (id, relation, number, start, legacy) is fixed.
create or replace function public.story_chapters_immutable() returns trigger language plpgsql set search_path = public as $$
begin
  if old.ended_at is not null then
    raise exception 'story chapter % is closed and read-only', old.id using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  if new.id is distinct from old.id or new.relation_id is distinct from old.relation_id
     or new.chapter_no is distinct from old.chapter_no or new.started_at is distinct from old.started_at
     or new.legacy is distinct from old.legacy or new.created_at is distinct from old.created_at then
    raise exception 'story chapter % identity is immutable', old.id using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists story_chapters_immutable_trg on public.story_chapters;
create trigger story_chapters_immutable_trg before update or delete on public.story_chapters
  for each row execute function public.story_chapters_immutable();

-- 9.2 One shared memory per (chapter, episode save key, journey version).
create table if not exists public.shared_memories (
  id text primary key,
  chapter_id text not null references public.story_chapters(id),
  source_key text not null,
  journey_key text not null,
  journey_version integer not null default 1,
  entry jsonb not null default '{}'::jsonb,
  together_sec bigint not null default 0,
  session_count integer not null default 0,
  first_watched_at bigint,
  last_watched_at bigint,
  completed_at bigint,
  legacy boolean not null default false,
  created_at bigint not null,
  updated_at bigint not null
);
create unique index if not exists shared_memories_key_idx on public.shared_memories (chapter_id, source_key, journey_version);

create table if not exists public.shared_memory_members (
  id text primary key,
  memory_id text not null references public.shared_memories(id),
  user_id text not null,
  watch_sec bigint not null default 0,
  together_sec bigint not null default 0,
  session_count integer not null default 0,
  first_watched_at bigint,
  last_watched_at bigint,
  updated_at bigint not null
);
create unique index if not exists shared_memory_members_idx on public.shared_memory_members (memory_id, user_id);

-- 9.3 Journey state: presentation title, archive/remove, removal requests.
-- space = 'u:<userId>' (My Scrapbook) or 'c:<chapterId>' (a Story Chapter).
create table if not exists public.journey_state (
  id text primary key,
  space text not null,
  journey_key text not null,
  generation integer not null default 1,
  display_title text,
  title_edited_by text,
  title_edited_at bigint,
  archived_at bigint,
  removed_at bigint,
  removed_by text,
  purge_after bigint,
  purged_at bigint,
  removal_state text not null default 'none',
  removal_requested_by text,
  removal_requested_at bigint,
  removal_blocked_until bigint,
  updated_at bigint not null
);
create unique index if not exists journey_state_key_idx on public.journey_state (space, journey_key, generation);

create table if not exists public.journey_member_prefs (
  id text primary key,
  space text not null,
  journey_key text not null,
  user_id text not null,
  hidden_at bigint,
  updated_at bigint not null
);
create unique index if not exists journey_member_prefs_idx on public.journey_member_prefs (space, journey_key, user_id);

-- 9.4 Sittings: intents, co-sittings, write-once decisions, idempotent ledger.
create table if not exists public.sitting_intents (
  sitting_id text primary key,
  user_id text not null,
  source_key text not null,
  room_id text,
  playing boolean not null default false,
  first_seen_at bigint not null,
  last_seen_at bigint not null
);
create index if not exists sitting_intents_lookup_idx on public.sitting_intents (source_key, room_id, last_seen_at);

create table if not exists public.co_sittings (
  id text primary key,
  chapter_id text not null references public.story_chapters(id),
  source_key text not null,
  opened_at bigint not null,
  last_active_at bigint not null,
  applied_together_sec bigint not null default 0,
  memory_id text
);
create index if not exists co_sittings_lookup_idx on public.co_sittings (chapter_id, source_key, last_active_at);

create table if not exists public.sitting_decisions (
  sitting_id text primary key,
  user_id text not null,
  source_key text not null,
  destination text not null check (destination in ('PERSONAL','SHARED')),
  chapter_id text,
  co_sitting_id text,
  reason text,
  decided_at bigint not null,
  last_active_at bigint not null
);
create index if not exists sitting_decisions_user_idx on public.sitting_decisions (user_id, source_key, last_active_at);

create table if not exists public.sitting_ledger (
  sitting_id text primary key,
  user_id text not null,
  destination text not null,
  target_id text not null,
  co_sitting_id text,
  last_seq integer not null default 0,
  watch_sec_cum bigint not null default 0,
  together_sec_cum bigint not null default 0,
  interval_start bigint not null,
  interval_end bigint not null,
  applied_watch_sec bigint not null default 0,
  applied_together_sec bigint not null default 0,
  applied_sessions integer not null default 0,
  updated_at bigint not null
);
create index if not exists sitting_ledger_target_idx on public.sitting_ledger (target_id, user_id);

-- 9.5 Tombstones, events, moments, maintenance.
create table if not exists public.memory_tombstones (
  id text primary key,
  space text not null,
  journey_key text not null,
  generation integer not null,
  source_keys jsonb not null default '[]'::jsonb,
  purged_at bigint not null
);
create table if not exists public.memory_events (
  id text primary key,
  space text not null,
  journey_key text,
  actor_id text,
  kind text not null,
  payload jsonb not null default '{}'::jsonb,
  at bigint not null
);
create index if not exists memory_events_space_idx on public.memory_events (space, at);
create table if not exists public.moment_seen (
  id text primary key,
  user_id text not null,
  moment_id text not null,
  seen_at bigint not null
);
create unique index if not exists moment_seen_idx on public.moment_seen (user_id, moment_id);
create table if not exists public.maintenance_runs (
  id text primary key,
  kind text not null,
  started_at bigint not null,
  finished_at bigint,
  report jsonb not null default '{}'::jsonb
);
create table if not exists public.maintenance_lease (
  name text primary key,
  holder text not null,
  until_at bigint not null
);

-- 9.6 Additive columns on legacy scrapbook rows (links, twin flag).
alter table public.scrapbook_entries add column if not exists migrated_to_shared_id text;
alter table public.scrapbook_entries add column if not exists twin_of_shared_id text;
alter table public.scrapbook_entries add column if not exists twin_class text;

-- My Scrapbook journey generations > 1 live under scope 'personal:v<n>' so a
-- removed generation is never overwritten. This WIDENS the existing check
-- (every previously valid row stays valid).
alter table public.scrapbook_entries drop constraint if exists scrapbook_scope_check;
alter table public.scrapbook_entries add constraint scrapbook_scope_check
  check (scope = 'personal' or scope like 'personal:v%' or scope like 'shared:%');

alter table public.story_chapters enable row level security;
alter table public.shared_memories enable row level security;
alter table public.shared_memory_members enable row level security;
alter table public.journey_state enable row level security;
alter table public.journey_member_prefs enable row level security;
alter table public.sitting_intents enable row level security;
alter table public.co_sittings enable row level security;
alter table public.sitting_decisions enable row level security;
alter table public.sitting_ledger enable row level security;
alter table public.memory_tombstones enable row level security;
alter table public.memory_events enable row level security;
alter table public.moment_seen enable row level security;
alter table public.maintenance_runs enable row level security;
alter table public.maintenance_lease enable row level security;

-- Purge / expiry / ledger compaction run in the Node server (boot, every 6 h,
-- and at most hourly from the Scrapbook list route) under the
-- maintenance_lease row, so only one instance runs them at a time.

-- ---------------------------------------------------------------------------
-- 9.7 Multi-instance safety: cross-instance locks + atomic functions
-- ---------------------------------------------------------------------------
-- Several Node instances may serve the same database. Critical Scrapbook v2
-- sections (sitting decisions, shared saves, journey actions, purge) hold a
-- row in scrapbook_locks (acquire = INSERT on the primary key, or steal an
-- EXPIRED row with one conditional UPDATE; renewed while held, released by
-- holder). The functions below make the remaining multi-row steps atomic so
-- correctness never depends on the lease alone. All are idempotent to
-- (re)create and are callable by service_role only.
create table if not exists public.scrapbook_locks (
  key text primary key,
  holder text not null,
  until_at bigint not null
);
alter table public.scrapbook_locks enable row level security;

-- totals += deltas (clamped at 0) as ONE statement.
create or replace function public.sp_scrapbook_bump_totals(
  p_table text, p_id text, p_watch bigint default 0, p_together bigint default 0, p_sessions integer default 0, p_at bigint default 0
) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if p_table = 'shared_memory_members' then
    update public.shared_memory_members set
      watch_sec = greatest(0, watch_sec + coalesce(p_watch, 0)),
      together_sec = greatest(0, together_sec + coalesce(p_together, 0)),
      session_count = greatest(0, session_count + coalesce(p_sessions, 0)),
      last_watched_at = greatest(coalesce(last_watched_at, 0), p_at),
      updated_at = p_at
    where id = p_id;
  elsif p_table = 'shared_memories' then
    update public.shared_memories set
      together_sec = greatest(0, together_sec + coalesce(p_together, 0)),
      session_count = greatest(0, session_count + coalesce(p_sessions, 0)),
      last_watched_at = greatest(coalesce(last_watched_at, 0), p_at),
      updated_at = p_at
    where id = p_id;
  elsif p_table = 'scrapbook_entries' then
    update public.scrapbook_entries set
      watch_duration_sec = greatest(0, watch_duration_sec + coalesce(p_watch, 0)),
      together_duration_sec = greatest(0, together_duration_sec + coalesce(p_together, 0)),
      session_count = greatest(0, session_count + coalesce(p_sessions, 0)),
      updated_at = p_at
    where id = p_id;
  else
    raise exception 'sp_scrapbook_bump_totals: unsupported table %', p_table using errcode = '22023';
  end if;
  return found;
end $$;

revoke all on public.scrapbook_locks from anon, authenticated;
grant all on public.scrapbook_locks to service_role;
revoke execute on function public.sp_scrapbook_bump_totals(text, text, bigint, bigint, integer, bigint) from public, anon, authenticated;
grant execute on function public.sp_scrapbook_bump_totals(text, text, bigint, bigint, integer, bigint) to service_role;

-- ---------------------------------------------------------------------------
-- 9.8 Database-authoritative Scrapbook v2 transitions (fencing tokens)
-- ---------------------------------------------------------------------------
-- The database is the final authority for every critical v2 transition. Each
-- function below runs as ONE transaction and re-validates its own
-- preconditions under row locks, so two server instances (or a paused worker
-- that resumes late) can never produce duplicate shared sittings,
-- conflicting decisions, double-applied saves or purge/restore races -
-- regardless of what the Node process believed when it called.
--
-- Fencing: acquiring a scrapbook_locks row returns a strictly increasing
-- fence number. Callers pass the fences they hold as
-- p_fences = [{"k": <lock key>, "f": <fence>}, ...]; each function first
-- locks those rows FOR UPDATE and raises SQLSTATE 'SPF01' (SP_FENCED) when
-- any of them is no longer held with that fence, i.e. when the lease expired
-- and another worker took it over. Because the lock row stays row-locked
-- until commit, a new owner cannot take the lease while a fenced commit is
-- in flight. p_fences = null skips the check (DB locks disabled); the
-- atomic validations below still apply.
--
-- Error codes: SPF01 fenced (stale lock owner), SPV01 invalid transition
-- (e.g. not the chapter's Story partner pair), SPC01 chapter closed /
-- Story not active, SPR01 removed or purged journey generation.
-- Everything is additive and idempotent to (re)apply. service_role only.

alter table public.scrapbook_locks add column if not exists fence bigint not null default 0;
create sequence if not exists public.scrapbook_lock_fence_seq;
revoke all on sequence public.scrapbook_lock_fence_seq from public, anon, authenticated;
drop function if exists public.sp_scrapbook_decide_pair(jsonb, jsonb, jsonb);

create or replace function public.sp_now_ms() returns bigint
language sql volatile set search_path = public as $$
  select (extract(epoch from clock_timestamp()) * 1000)::bigint
$$;

-- Acquire or take over an EXPIRED lease in one statement; returns the new
-- fence, or null when another holder's lease is still live.
create or replace function public.sp_scrapbook_lock_acquire(p_key text, p_holder text, p_ttl_ms bigint)
returns bigint
language plpgsql security definer set search_path = public as $$
declare v bigint; t bigint := public.sp_now_ms();
begin
  insert into public.scrapbook_locks as l (key, holder, until_at, fence)
  values (p_key, p_holder, t + greatest(p_ttl_ms, 1), nextval('public.scrapbook_lock_fence_seq'))
  on conflict (key) do update set holder = excluded.holder, until_at = excluded.until_at, fence = excluded.fence
  where l.until_at < t
  returning l.fence into v;
  return v;
end $$;

create or replace function public.sp_scrapbook_lock_renew(p_key text, p_holder text, p_fence bigint, p_ttl_ms bigint)
returns boolean
language plpgsql security definer set search_path = public as $$
begin
  update public.scrapbook_locks set until_at = public.sp_now_ms() + greatest(p_ttl_ms, 1)
  where key = p_key and holder = p_holder and fence = p_fence;
  return found;
end $$;

create or replace function public.sp_scrapbook_lock_release(p_key text, p_holder text, p_fence bigint)
returns boolean
language plpgsql security definer set search_path = public as $$
begin
  delete from public.scrapbook_locks where key = p_key and holder = p_holder and fence = p_fence;
  return found;
end $$;

create or replace function public.sp_scrapbook_check_fences(p_fences jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare f jsonb;
begin
  if p_fences is null or jsonb_typeof(p_fences) <> 'array' then return; end if;
  for f in select value from jsonb_array_elements(p_fences) loop
    perform 1 from public.scrapbook_locks where key = f->>'k' and fence = (f->>'f')::bigint for update;
    if not found then
      raise exception 'SP_FENCED: lock % is no longer held with fence %', f->>'k', f->>'f' using errcode = 'SPF01';
    end if;
  end loop;
end $$;

-- The two users of a chapter's Story. With p_require_open the chapter must be
-- open and its relation active. Row-locks both rows FOR SHARE, so a Story
-- cannot end / a chapter cannot close while the caller's transaction runs.
create or replace function public.sp_scrapbook_story_users(p_chapter_id text, p_require_open boolean)
returns text[]
language plpgsql security definer set search_path = public as $$
declare c public.story_chapters%rowtype; r public.relations%rowtype;
begin
  select * into c from public.story_chapters where id = p_chapter_id for share;
  if not found then raise exception 'SP_INVALID: chapter % not found', p_chapter_id using errcode = 'SPV01'; end if;
  select * into r from public.relations where id = c.relation_id for share;
  if not found then raise exception 'SP_INVALID: relation of chapter % not found', p_chapter_id using errcode = 'SPV01'; end if;
  if p_require_open and (c.ended_at is not null or r.accepted_at is null or r.archived_at is not null or r.ended_at is not null) then
    raise exception 'SP_CHAPTER_CLOSED: chapter % is not an active Story chapter', p_chapter_id using errcode = 'SPC01';
  end if;
  return array[r.user1_id, r.user2_id];
end $$;

-- Write-once sitting decision. SHARED is only accepted for a member of the
-- chapter's active Story, inside a co-sitting of that chapter and episode.
-- Returns the stored decision (the first one written wins forever).
create or replace function public.sp_scrapbook_write_decision(p_row jsonb, p_fences jsonb default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare t bigint := coalesce((p_row->>'decided_at')::bigint, public.sp_now_ms()); out jsonb;
begin
  perform public.sp_scrapbook_check_fences(p_fences);
  if coalesce(p_row->>'destination', '') not in ('PERSONAL', 'SHARED') or coalesce(p_row->>'sitting_id', '') = '' or coalesce(p_row->>'user_id', '') = '' then
    raise exception 'SP_INVALID: malformed decision' using errcode = 'SPV01';
  end if;
  perform 1 from public.sitting_intents where sitting_id = p_row->>'sitting_id' and user_id <> p_row->>'user_id';
  if found then raise exception 'SP_INVALID: sitting % belongs to another user', p_row->>'sitting_id' using errcode = 'SPV01'; end if;
  if p_row->>'destination' = 'SHARED' then
    if not ((p_row->>'user_id') = any(public.sp_scrapbook_story_users(p_row->>'chapter_id', true))) then
      raise exception 'SP_NOT_STORY_PARTNER: user is not part of chapter %', p_row->>'chapter_id' using errcode = 'SPV01';
    end if;
    perform 1 from public.co_sittings where id = p_row->>'co_sitting_id' and chapter_id = p_row->>'chapter_id' and source_key = p_row->>'source_key';
    if not found then raise exception 'SP_INVALID: co-sitting % does not belong to this chapter/episode', p_row->>'co_sitting_id' using errcode = 'SPV01'; end if;
  end if;
  insert into public.sitting_decisions (sitting_id, user_id, source_key, destination, chapter_id, co_sitting_id, reason, decided_at, last_active_at)
  values (p_row->>'sitting_id', p_row->>'user_id', p_row->>'source_key', p_row->>'destination',
          case when p_row->>'destination' = 'SHARED' then p_row->>'chapter_id' end,
          case when p_row->>'destination' = 'SHARED' then p_row->>'co_sitting_id' end,
          p_row->>'reason', t, coalesce((p_row->>'last_active_at')::bigint, t))
  on conflict (sitting_id) do nothing;
  select to_jsonb(d) into out from public.sitting_decisions d where d.sitting_id = p_row->>'sitting_id';
  return out;
end $$;

-- Both partners' SHARED decisions and their co-sitting in ONE transaction.
-- The two users must be exactly the two users of the chapter's ACTIVE Story
-- (never a third viewer of the same room), each sitting must be a recorded
-- intent of that user for that episode, and the chapter must be open.
-- A unique violation on either decision rolls the block back -> applied false.
create or replace function public.sp_scrapbook_decide_pair(p_co jsonb, p_first jsonb, p_second jsonb, p_fences jsonb default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare users text[]; v_x jsonb;
begin
  perform public.sp_scrapbook_check_fences(p_fences);
  if coalesce(p_first->>'destination', '') <> 'SHARED' or coalesce(p_second->>'destination', '') <> 'SHARED'
     or p_first->>'co_sitting_id' is distinct from p_co->>'id' or p_second->>'co_sitting_id' is distinct from p_co->>'id'
     or p_first->>'chapter_id' is distinct from p_co->>'chapter_id' or p_second->>'chapter_id' is distinct from p_co->>'chapter_id'
     or p_first->>'source_key' is distinct from p_co->>'source_key' or p_second->>'source_key' is distinct from p_co->>'source_key'
     or p_first->>'sitting_id' = p_second->>'sitting_id' then
    raise exception 'SP_INVALID: inconsistent pair' using errcode = 'SPV01';
  end if;
  users := public.sp_scrapbook_story_users(p_co->>'chapter_id', true);
  if p_first->>'user_id' = p_second->>'user_id' or not ((p_first->>'user_id') = any(users)) or not ((p_second->>'user_id') = any(users)) then
    raise exception 'SP_NOT_STORY_PAIR: the two sittings are not the Story partner pair of chapter %', p_co->>'chapter_id' using errcode = 'SPV01';
  end if;
  foreach v_x in array array[p_first, p_second] loop
    perform 1 from public.sitting_intents where sitting_id = v_x->>'sitting_id' and user_id = v_x->>'user_id' and source_key = v_x->>'source_key';
    if not found then raise exception 'SP_INVALID: sitting % is not a recorded intent of its user', v_x->>'sitting_id' using errcode = 'SPV01'; end if;
  end loop;
  begin
    insert into public.co_sittings (id, chapter_id, source_key, opened_at, last_active_at, applied_together_sec, memory_id)
    values (p_co->>'id', p_co->>'chapter_id', p_co->>'source_key', (p_co->>'opened_at')::bigint, (p_co->>'last_active_at')::bigint, 0, null)
    on conflict (id) do nothing;
    insert into public.sitting_decisions (sitting_id, user_id, source_key, destination, chapter_id, co_sitting_id, reason, decided_at, last_active_at)
    select x->>'sitting_id', x->>'user_id', x->>'source_key', 'SHARED', x->>'chapter_id', x->>'co_sitting_id',
           x->>'reason', (x->>'decided_at')::bigint, (x->>'last_active_at')::bigint
    from (values (p_first), (p_second)) as v(x);
    return jsonb_build_object('applied', true);
  exception when unique_violation then
    return jsonb_build_object('applied', false);
  end;
end $$;

-- Idempotent sitting save: (sitting, seq) with running totals. The decision,
-- owner, destination and target are verified from stored rows (never from
-- the caller), the closed-chapter grace window and journey removal are
-- enforced here, and the ledger row moves monotonically under FOR UPDATE.
-- p_row: sitting_id, user_id, target_id, watch_cum, together_cum,
--        journey_key + generation (My Scrapbook targets), max_age_ms.
-- Returns {"status": inserted|advanced|duplicate|chapter_closed|chapter_missing|removed|expired, "ledger": {...}}.
create or replace function public.sp_scrapbook_save_ledger(p_row jsonb, p_seq integer, p_now bigint, p_grace_ms bigint, p_fences jsonb default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  d public.sitting_decisions%rowtype;
  ch public.story_chapters%rowtype;
  l public.sitting_ledger%rowtype;
  has_l boolean;
  v_now bigint := greatest(coalesce(p_now, 0), public.sp_now_ms());
  v_target text := p_row->>'target_id';
  v_space text; v_jk text; v_gen integer; v_removed boolean;
  w bigint; tg bigint; v_status text;
  in_w bigint := greatest(0, coalesce((p_row->>'watch_cum')::bigint, 0));
  in_t bigint := greatest(0, coalesce((p_row->>'together_cum')::bigint, 0));
begin
  perform public.sp_scrapbook_check_fences(p_fences);
  select * into d from public.sitting_decisions where sitting_id = p_row->>'sitting_id';
  if not found or d.user_id <> p_row->>'user_id' then
    raise exception 'SP_INVALID: sitting % has no decision for this user', p_row->>'sitting_id' using errcode = 'SPV01';
  end if;
  if d.destination = 'SHARED' then
    select * into ch from public.story_chapters where id = d.chapter_id for share;
    if not found then return jsonb_build_object('status', 'chapter_missing'); end if;
    if ch.ended_at is not null and (d.decided_at > ch.ended_at or v_now > ch.ended_at + p_grace_ms) then
      return jsonb_build_object('status', 'chapter_closed');
    end if;
    select m.journey_key, m.journey_version into v_jk, v_gen from public.shared_memories m
      where m.id = v_target and m.chapter_id = d.chapter_id and m.source_key = d.source_key;
    if not found then raise exception 'SP_INVALID: target is not this sitting''s shared memory' using errcode = 'SPV01'; end if;
    v_space := 'c:' || d.chapter_id;
  else
    perform 1 from public.scrapbook_entries e where e.id = v_target and e.user_id = d.user_id and e.source_key = d.source_key;
    if not found then raise exception 'SP_INVALID: target is not this sitting''s scrapbook row' using errcode = 'SPV01'; end if;
    v_jk := p_row->>'journey_key';
    v_gen := coalesce((p_row->>'generation')::integer, 1);
    v_space := 'u:' || d.user_id;
  end if;
  select * into l from public.sitting_ledger where sitting_id = d.sitting_id for update;
  has_l := found;
  if has_l and p_seq <= l.last_seq then return jsonb_build_object('status', 'duplicate', 'ledger', to_jsonb(l)); end if;
  if has_l and l.target_id <> v_target then raise exception 'SP_INVALID: ledger target mismatch' using errcode = 'SPV01'; end if;
  -- FOR SHARE: a concurrent remove / restore of this generation serialises with this save.
  perform 1 from public.journey_state s where s.space = v_space and s.journey_key = v_jk and s.generation = v_gen for share;
  select exists (select 1 from public.journey_state s where s.space = v_space and s.journey_key = v_jk and s.removed_at is not null
                 and (s.generation = v_gen or s.removed_at >= d.decided_at)) into v_removed;
  if v_removed then return jsonb_build_object('status', 'removed'); end if;
  if not has_l then
    if p_row ? 'max_age_ms' and d.decided_at < v_now - (p_row->>'max_age_ms')::bigint then
      return jsonb_build_object('status', 'expired');
    end if;
    w := in_w; tg := least(in_t, w);
    insert into public.sitting_ledger (sitting_id, user_id, destination, target_id, co_sitting_id, last_seq, watch_sec_cum, together_sec_cum,
                                       interval_start, interval_end, applied_watch_sec, applied_together_sec, applied_sessions, updated_at)
    values (d.sitting_id, d.user_id, d.destination, v_target, d.co_sitting_id, p_seq, w, tg, p_now - w * 1000, p_now, 0, 0, 0, p_now)
    on conflict (sitting_id) do nothing
    returning * into l;
    if found then
      v_status := 'inserted';
    else
      select * into l from public.sitting_ledger where sitting_id = d.sitting_id for update;
      if p_seq <= l.last_seq then return jsonb_build_object('status', 'duplicate', 'ledger', to_jsonb(l)); end if;
    end if;
  end if;
  if v_status is null then
    w := greatest(l.watch_sec_cum, in_w);
    tg := greatest(l.together_sec_cum, least(in_t, w));
    update public.sitting_ledger set last_seq = p_seq, watch_sec_cum = w, together_sec_cum = tg,
      interval_start = least(l.interval_start, p_now - w * 1000), interval_end = greatest(l.interval_end, p_now), updated_at = p_now
    where sitting_id = d.sitting_id
    returning * into l;
    v_status := 'advanced';
  end if;
  update public.sitting_decisions set last_active_at = greatest(last_active_at, p_now) where sitting_id = d.sitting_id;
  return jsonb_build_object('status', v_status, 'ledger', to_jsonb(l));
end $$;

-- Credited amounts of one ledger row move by compare-and-set AND the totals
-- change by exactly that delta in the same transaction.
create or replace function public.sp_scrapbook_apply_ledger(p_sitting_id text, p_old jsonb, p_new jsonb, p_table text, p_bump_id text, p_at bigint, p_fences jsonb default null)
returns boolean
language plpgsql security definer set search_path = public as $$
declare l public.sitting_ledger%rowtype;
begin
  perform public.sp_scrapbook_check_fences(p_fences);
  update public.sitting_ledger set applied_watch_sec = (p_new->>'w')::bigint, applied_together_sec = (p_new->>'t')::bigint, applied_sessions = (p_new->>'s')::integer
  where sitting_id = p_sitting_id and applied_watch_sec = (p_old->>'w')::bigint and applied_together_sec = (p_old->>'t')::bigint and applied_sessions = (p_old->>'s')::integer
  returning * into l;
  if not found then return false; end if;
  if p_table = 'shared_memory_members' then
    perform 1 from public.shared_memory_members where id = p_bump_id and memory_id = l.target_id and user_id = l.user_id;
  elsif p_table = 'scrapbook_entries' then
    perform 1 from public.scrapbook_entries where id = p_bump_id and id = l.target_id and user_id = l.user_id;
  else
    raise exception 'SP_INVALID: unsupported table %', p_table using errcode = 'SPV01';
  end if;
  if not found then raise exception 'SP_INVALID: totals row does not belong to this ledger row' using errcode = 'SPV01'; end if;
  perform public.sp_scrapbook_bump_totals(p_table, p_bump_id, (p_new->>'w')::bigint - (p_old->>'w')::bigint,
    (p_new->>'t')::bigint - (p_old->>'t')::bigint, (p_new->>'s')::integer - (p_old->>'s')::integer, p_at);
  return true;
end $$;

-- together(co) moves by compare-and-set and the memory follows in the same transaction.
create or replace function public.sp_scrapbook_apply_co(p_co_id text, p_old bigint, p_new bigint, p_memory_id text, p_at bigint, p_fences jsonb default null)
returns boolean
language plpgsql security definer set search_path = public as $$
begin
  perform public.sp_scrapbook_check_fences(p_fences);
  update public.co_sittings set applied_together_sec = p_new, last_active_at = greatest(last_active_at, p_at)
  where id = p_co_id and applied_together_sec = p_old and memory_id = p_memory_id;
  if not found then return false; end if;
  perform public.sp_scrapbook_bump_totals('shared_memories', p_memory_id, 0, p_new - p_old, 0, p_at);
  return true;
end $$;

-- Links a co-sitting to its memory exactly once and counts its ONE session.
create or replace function public.sp_scrapbook_link_co(p_co_id text, p_memory_id text, p_at bigint, p_fences jsonb default null)
returns boolean
language plpgsql security definer set search_path = public as $$
begin
  perform public.sp_scrapbook_check_fences(p_fences);
  update public.co_sittings c set memory_id = p_memory_id, last_active_at = greatest(c.last_active_at, p_at)
  where c.id = p_co_id and c.memory_id is null
    and exists (select 1 from public.shared_memories m where m.id = p_memory_id and m.chapter_id = c.chapter_id and m.source_key = c.source_key);
  if not found then return false; end if;
  perform public.sp_scrapbook_bump_totals('shared_memories', p_memory_id, 0, 0, 1, p_at);
  return true;
end $$;

-- Conditional journey_state update: applied only when every column in
-- p_expect still holds the expected value (row locked FOR UPDATE), otherwise
-- returns null (the caller reports a conflict). purged_at and the row
-- identity can never be changed here. p_require_open: the chapter of a
-- 'c:' space must still be open (closed chapters are read-only).
create or replace function public.sp_scrapbook_journey_update(p_state_id text, p_expect jsonb, p_patch jsonb, p_require_open boolean default false, p_fences jsonb default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare s public.journey_state%rowtype; n public.journey_state%rowtype; cur jsonb; k text; v_ended bigint;
begin
  perform public.sp_scrapbook_check_fences(p_fences);
  select * into s from public.journey_state where id = p_state_id for update;
  if not found then return null; end if;
  if p_require_open and s.space like 'c:%' then
    select ended_at into v_ended from public.story_chapters where id = substr(s.space, 3) for share;
    if not found or v_ended is not null then
      raise exception 'SP_CHAPTER_CLOSED: chapter % is read-only', substr(s.space, 3) using errcode = 'SPC01';
    end if;
  end if;
  cur := to_jsonb(s);
  for k in select jsonb_object_keys(coalesce(p_expect, '{}'::jsonb)) loop
    if (cur->k) is distinct from (p_expect->k) then return null; end if;
  end loop;
  n := jsonb_populate_record(s, coalesce(p_patch, '{}'::jsonb) - 'id' - 'space' - 'journey_key' - 'generation' - 'purged_at');
  update public.journey_state set
    display_title = n.display_title, title_edited_by = n.title_edited_by, title_edited_at = n.title_edited_at,
    archived_at = n.archived_at, removed_at = n.removed_at, removed_by = n.removed_by, purge_after = n.purge_after,
    removal_state = n.removal_state, removal_requested_by = n.removal_requested_by, removal_requested_at = n.removal_requested_at,
    removal_blocked_until = n.removal_blocked_until, updated_at = n.updated_at
  where id = p_state_id
  returning * into n;
  return to_jsonb(n);
end $$;

-- Purges ONE removed generation past its restore window, atomically: re-check
-- under FOR UPDATE, delete its rows, mark purged, write the tombstone. A
-- concurrent restore (journey_update on the same row) either commits first
-- (then this finds removed_at null and does nothing) or waits and then fails
-- its expectation. p_entry_ids: My Scrapbook row ids of that generation.
create or replace function public.sp_scrapbook_purge_journey(p_state_id text, p_now bigint, p_entry_ids jsonb default '[]'::jsonb, p_fences jsonb default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare s public.journey_state%rowtype; v_keys jsonb := '[]'::jsonb; v_rows integer := 0; v_ids text[];
begin
  perform public.sp_scrapbook_check_fences(p_fences);
  select * into s from public.journey_state where id = p_state_id for update;
  if not found or s.removed_at is null or s.purged_at is not null or coalesce(s.purge_after, 0) > p_now then
    return jsonb_build_object('purged', false);
  end if;
  if s.space like 'c:%' then
    select coalesce(array_agg(id), '{}'), coalesce(jsonb_agg(source_key), '[]'::jsonb), count(*) into v_ids, v_keys, v_rows
    from public.shared_memories where chapter_id = substr(s.space, 3) and journey_key = s.journey_key and journey_version = s.generation;
    delete from public.shared_memory_members where memory_id = any(v_ids);
    delete from public.sitting_ledger where target_id = any(v_ids);
    delete from public.shared_memories where id = any(v_ids);
  else
    select coalesce(array_agg(id), '{}'), coalesce(jsonb_agg(source_key), '[]'::jsonb), count(*) into v_ids, v_keys, v_rows
    from public.scrapbook_entries
    where id in (select jsonb_array_elements_text(coalesce(p_entry_ids, '[]'::jsonb)))
      and user_id = substr(s.space, 3)
      and scope = case when s.generation > 1 then 'personal:v' || s.generation else 'personal' end;
    delete from public.sitting_ledger where target_id = any(v_ids);
    delete from public.scrapbook_entries where id = any(v_ids);
  end if;
  update public.journey_state set purged_at = p_now, updated_at = p_now where id = p_state_id;
  insert into public.memory_tombstones (id, space, journey_key, generation, source_keys, purged_at)
  values ('tomb_' || s.id, s.space, s.journey_key, s.generation, v_keys, p_now)
  on conflict (id) do nothing;
  return jsonb_build_object('purged', true, 'rows', v_rows, 'keys', v_keys);
end $$;

-- No resurrection at the database level: nothing can be inserted into a
-- removed generation, a purged generation can never be un-purged/restored,
-- and a removed generation cannot be restored once a newer one exists.
create or replace function public.sp_scrapbook_no_resurrect() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_chapter text; v_jk text; v_gen integer;
begin
  if tg_table_name = 'shared_memories' then
    v_chapter := new.chapter_id; v_jk := new.journey_key; v_gen := new.journey_version;
  else
    select chapter_id, journey_key, journey_version into v_chapter, v_jk, v_gen from public.shared_memories where id = new.memory_id;
  end if;
  if exists (select 1 from public.journey_state s where s.space = 'c:' || v_chapter and s.journey_key = v_jk and s.generation = v_gen and s.removed_at is not null) then
    raise exception 'SP_REMOVED: journey % v% of chapter % was removed', v_jk, v_gen, v_chapter using errcode = 'SPR01';
  end if;
  return new;
end $$;
drop trigger if exists shared_memories_no_resurrect_trg on public.shared_memories;
create trigger shared_memories_no_resurrect_trg before insert on public.shared_memories
  for each row execute function public.sp_scrapbook_no_resurrect();
drop trigger if exists shared_memory_members_no_resurrect_trg on public.shared_memory_members;
create trigger shared_memory_members_no_resurrect_trg before insert on public.shared_memory_members
  for each row execute function public.sp_scrapbook_no_resurrect();

create or replace function public.journey_state_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.space is distinct from old.space or new.journey_key is distinct from old.journey_key or new.generation is distinct from old.generation then
    raise exception 'SP_INVALID: journey state identity is immutable' using errcode = 'SPV01';
  end if;
  if old.purged_at is not null and (new.purged_at is null or new.removed_at is null) then
    raise exception 'SP_PURGED: purged journey generation % cannot be restored', old.id using errcode = 'SPR01';
  end if;
  if old.removed_at is not null and new.removed_at is null and exists (
    select 1 from public.journey_state s where s.space = old.space and s.journey_key = old.journey_key and s.generation > old.generation) then
    raise exception 'SP_REMOVED: a newer generation exists; % cannot be restored', old.id using errcode = 'SPR01';
  end if;
  return new;
end $$;
drop trigger if exists journey_state_guard_trg on public.journey_state;
create trigger journey_state_guard_trg before update on public.journey_state
  for each row execute function public.journey_state_guard();

revoke execute on function public.sp_now_ms() from public, anon, authenticated;
revoke execute on function public.sp_scrapbook_lock_acquire(text, text, bigint) from public, anon, authenticated;
revoke execute on function public.sp_scrapbook_lock_renew(text, text, bigint, bigint) from public, anon, authenticated;
revoke execute on function public.sp_scrapbook_lock_release(text, text, bigint) from public, anon, authenticated;
revoke execute on function public.sp_scrapbook_check_fences(jsonb) from public, anon, authenticated;
revoke execute on function public.sp_scrapbook_story_users(text, boolean) from public, anon, authenticated;
revoke execute on function public.sp_scrapbook_write_decision(jsonb, jsonb) from public, anon, authenticated;
revoke execute on function public.sp_scrapbook_decide_pair(jsonb, jsonb, jsonb, jsonb) from public, anon, authenticated;
revoke execute on function public.sp_scrapbook_save_ledger(jsonb, integer, bigint, bigint, jsonb) from public, anon, authenticated;
revoke execute on function public.sp_scrapbook_apply_ledger(text, jsonb, jsonb, text, text, bigint, jsonb) from public, anon, authenticated;
revoke execute on function public.sp_scrapbook_apply_co(text, bigint, bigint, text, bigint, jsonb) from public, anon, authenticated;
revoke execute on function public.sp_scrapbook_link_co(text, text, bigint, jsonb) from public, anon, authenticated;
revoke execute on function public.sp_scrapbook_journey_update(text, jsonb, jsonb, boolean, jsonb) from public, anon, authenticated;
revoke execute on function public.sp_scrapbook_purge_journey(text, bigint, jsonb, jsonb) from public, anon, authenticated;
revoke execute on function public.sp_scrapbook_no_resurrect() from public, anon, authenticated;
revoke execute on function public.journey_state_guard() from public, anon, authenticated;
grant execute on function public.sp_scrapbook_lock_acquire(text, text, bigint) to service_role;
grant execute on function public.sp_scrapbook_lock_renew(text, text, bigint, bigint) to service_role;
grant execute on function public.sp_scrapbook_lock_release(text, text, bigint) to service_role;
grant execute on function public.sp_scrapbook_write_decision(jsonb, jsonb) to service_role;
grant execute on function public.sp_scrapbook_decide_pair(jsonb, jsonb, jsonb, jsonb) to service_role;
grant execute on function public.sp_scrapbook_save_ledger(jsonb, integer, bigint, bigint, jsonb) to service_role;
grant execute on function public.sp_scrapbook_apply_ledger(text, jsonb, jsonb, text, text, bigint, jsonb) to service_role;
grant execute on function public.sp_scrapbook_apply_co(text, bigint, bigint, text, bigint, jsonb) to service_role;
grant execute on function public.sp_scrapbook_link_co(text, text, bigint, jsonb) to service_role;
grant execute on function public.sp_scrapbook_journey_update(text, jsonb, jsonb, boolean, jsonb) to service_role;
grant execute on function public.sp_scrapbook_purge_journey(text, bigint, jsonb, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 9.9 Scrapbook V2 is the only Scrapbook architecture (final cut-over).
-- The v1 per-partner shared copies (scope 'shared:<relation>') are no longer
-- written by any code path: Our Story lives only in story_chapters /
-- shared_memories / shared_memory_members. Existing legacy rows stay as inert,
-- migrated history (linked via migrated_to_shared_id by the backfill), so the
-- guard only rejects NEW v1 shared rows (insert, or re-scoping a row into
-- 'shared:%'); link/flag updates on existing legacy rows remain allowed.
create or replace function public.sp_scrapbook_entries_v2_only() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.scope like 'shared:%' and (tg_op = 'INSERT' or old.scope is distinct from new.scope) then
    raise exception 'SP_V1_SHARED_SCOPE: Scrapbook v1 shared copies are retired (scope %)', new.scope using errcode = 'SPV02';
  end if;
  return new;
end $$;
drop trigger if exists scrapbook_entries_v2_only_trg on public.scrapbook_entries;
create trigger scrapbook_entries_v2_only_trg before insert or update of scope on public.scrapbook_entries
  for each row execute function public.sp_scrapbook_entries_v2_only();
revoke execute on function public.sp_scrapbook_entries_v2_only() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 9.10 Account preferences (quick-reaction tray + Activity read state)
-- ---------------------------------------------------------------------------
-- Quick reactions live on the account row (one small array per user, latest
-- write wins, server-stamped). Activity "seen" state is one row per
-- (user, notification id): the primary key makes repeats a no-op and its
-- user_id prefix serves every query (per-user lists are capped at 400 rows).
alter table public.users add column if not exists quick_reactions jsonb;
alter table public.users add column if not exists quick_reactions_updated_at bigint;
alter table public.users drop constraint if exists users_quick_reactions_shape;
alter table public.users add constraint users_quick_reactions_shape
  check (quick_reactions is null or (jsonb_typeof(quick_reactions) = 'array' and jsonb_array_length(quick_reactions) <= 6));

create table if not exists public.notification_reads (
  user_id text not null references public.users(id) on delete cascade,
  notif_id text not null check (char_length(notif_id) between 1 and 200),
  read_at bigint not null,
  primary key (user_id, notif_id)
);
alter table public.notification_reads enable row level security;

-- Advisor fixes: listUserRelations filters on user2_id (user1_id is covered
-- by relations_pair_uidx); the partial lookup index duplicated that unique
-- index and was never used.
create index if not exists relations_user2_idx on public.relations (user2_id);
drop index if exists public.relations_active_lookup_idx;
