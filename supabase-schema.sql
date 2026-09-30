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
create or replace function public.story_chapters_immutable() returns trigger language plpgsql as $$
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

-- Both partners' SHARED decisions and their co-sitting in ONE transaction:
-- all rows are written or none is (a unique violation on either decision
-- rolls the whole block back). Returns {"applied": true|false}.
create or replace function public.sp_scrapbook_decide_pair(p_co jsonb, p_first jsonb, p_second jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(p_first->>'destination', '') <> 'SHARED' or coalesce(p_second->>'destination', '') <> 'SHARED'
     or p_first->>'co_sitting_id' is distinct from p_co->>'id' or p_second->>'co_sitting_id' is distinct from p_co->>'id'
     or p_first->>'chapter_id' is distinct from p_co->>'chapter_id' or p_second->>'chapter_id' is distinct from p_co->>'chapter_id'
     or p_first->>'sitting_id' = p_second->>'sitting_id' then
    raise exception 'sp_scrapbook_decide_pair: inconsistent pair' using errcode = '22023';
  end if;
  begin
    insert into public.co_sittings (id, chapter_id, source_key, opened_at, last_active_at, applied_together_sec, memory_id)
    values (p_co->>'id', p_co->>'chapter_id', p_co->>'source_key', (p_co->>'opened_at')::bigint, (p_co->>'last_active_at')::bigint, 0, null)
    on conflict (id) do nothing;
    insert into public.sitting_decisions (sitting_id, user_id, source_key, destination, chapter_id, co_sitting_id, reason, decided_at, last_active_at)
    select x->>'sitting_id', x->>'user_id', x->>'source_key', x->>'destination', x->>'chapter_id', x->>'co_sitting_id',
           x->>'reason', (x->>'decided_at')::bigint, (x->>'last_active_at')::bigint
    from (values (p_first), (p_second)) as v(x);
    return jsonb_build_object('applied', true);
  exception when unique_violation then
    return jsonb_build_object('applied', false);
  end;
end $$;

revoke all on public.scrapbook_locks from anon, authenticated;
grant all on public.scrapbook_locks to service_role;
revoke execute on function public.sp_scrapbook_bump_totals(text, text, bigint, bigint, integer, bigint) from public, anon, authenticated;
revoke execute on function public.sp_scrapbook_decide_pair(jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.sp_scrapbook_bump_totals(text, text, bigint, bigint, integer, bigint) to service_role;
grant execute on function public.sp_scrapbook_decide_pair(jsonb, jsonb, jsonb) to service_role;
