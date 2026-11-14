-- SyncParty Scrapbook episode identity + media-position snapshots.
-- Additive only: existing viewing history/totals are not rewritten.
-- Apply separately after backing up the database. Do NOT run automatically.
begin;

alter table public.scrapbook_entries
  add column if not exists episode_metadata_provider text not null default '',
  add column if not exists episode_metadata_id text not null default '',
  add column if not exists episode_numbering_system text not null default '',
  add column if not exists absolute_episode_number integer,
  add column if not exists media_position_sec bigint,
  add column if not exists media_duration_sec bigint;

commit;
