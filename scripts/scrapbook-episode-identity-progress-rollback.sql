-- Rollback for scrapbook-episode-identity-progress-migration.sql.
-- WARNING: this drops the six additive columns and therefore discards episode
-- provider ids/numbering metadata and media-position snapshots collected after
-- the migration. It does NOT change progress, watch-duration, Together Time,
-- session counts, timestamps, or any existing history row.
begin;

alter table public.scrapbook_entries
  drop column if exists episode_metadata_provider,
  drop column if exists episode_metadata_id,
  drop column if exists episode_numbering_system,
  drop column if exists absolute_episode_number,
  drop column if exists media_position_sec,
  drop column if exists media_duration_sec;

commit;
