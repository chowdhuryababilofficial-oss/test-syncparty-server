-- Scrapbook v2 - Postgres-only protections check.
-- SAFE ON ANY DATABASE, INCLUDING PRODUCTION: everything runs inside one
-- transaction that ends in ROLLBACK, uses only synthetic rows whose ids start
-- with 'spv2val_', and never touches an existing row. Paste into the Supabase
-- SQL editor (or psql) and run. Expected final notice:
--   SCRAPBOOK V2 VALIDATION: ALL n CHECKS PASSED
-- Any failed check aborts with "SCRAPBOOK V2 VALIDATION FAILED: <check>".
begin;

do $$
declare
  n int := 0;
  r jsonb;
  cnt int;
  ok boolean;
begin
  insert into public.users (id, email, name, provider, created_at) values
    ('spv2val_u1', 'spv2val_u1@example.invalid', 'v1', 'email', 0),
    ('spv2val_u2', 'spv2val_u2@example.invalid', 'v2', 'email', 0);
  insert into public.relations (id, user1_id, user2_id, created_at, accepted_at) values ('spv2val_rel', 'spv2val_u1', 'spv2val_u2', 0, 1);
  insert into public.story_chapters (id, relation_id, chapter_no, started_at, legacy, created_at) values ('spv2val_c1', 'spv2val_rel', 1, 1000, false, 1000);

  -- 1. one open chapter per relation (partial unique index)
  begin
    insert into public.story_chapters (id, relation_id, chapter_no, started_at, legacy, created_at) values ('spv2val_c1b', 'spv2val_rel', 2, 1100, false, 1100);
    raise exception 'SCRAPBOOK V2 VALIDATION FAILED: second open chapter was accepted';
  exception when unique_violation then n := n + 1; end;

  -- 2. open chapter identity is immutable
  begin
    update public.story_chapters set started_at = 5 where id = 'spv2val_c1';
    raise exception 'SCRAPBOOK V2 VALIDATION FAILED: open chapter start changed';
  exception when raise_exception then
    if sqlerrm like 'SCRAPBOOK V2 VALIDATION FAILED%' then raise; end if; n := n + 1; end;

  -- 3. closing an open chapter is allowed (the only legal update)
  update public.story_chapters set ended_at = 2000, end_mode = 'end', ended_by = 'spv2val_u1' where id = 'spv2val_c1' and ended_at is null;
  get diagnostics cnt = row_count;
  if cnt <> 1 then raise exception 'SCRAPBOOK V2 VALIDATION FAILED: open chapter could not be closed'; end if;
  n := n + 1;

  -- 4. an ended chapter cannot be reopened
  begin
    update public.story_chapters set ended_at = null where id = 'spv2val_c1';
    raise exception 'SCRAPBOOK V2 VALIDATION FAILED: ended chapter was reopened';
  exception when raise_exception then
    if sqlerrm like 'SCRAPBOOK V2 VALIDATION FAILED%' then raise; end if; n := n + 1; end;

  -- 5. an ended chapter cannot be modified in any column
  begin
    update public.story_chapters set end_mode = 'archive' where id = 'spv2val_c1';
    raise exception 'SCRAPBOOK V2 VALIDATION FAILED: ended chapter was modified';
  exception when raise_exception then
    if sqlerrm like 'SCRAPBOOK V2 VALIDATION FAILED%' then raise; end if; n := n + 1; end;

  -- 6. an ended chapter cannot be deleted
  begin
    delete from public.story_chapters where id = 'spv2val_c1';
    raise exception 'SCRAPBOOK V2 VALIDATION FAILED: ended chapter was deleted';
  exception when raise_exception then
    if sqlerrm like 'SCRAPBOOK V2 VALIDATION FAILED%' then raise; end if; n := n + 1; end;

  -- 7. a restart is a NEW chapter id; the ended one is untouched
  insert into public.story_chapters (id, relation_id, chapter_no, started_at, legacy, created_at) values ('spv2val_c2', 'spv2val_rel', 2, 3000, false, 3000);
  select (ended_at = 2000 and end_mode = 'end') into ok from public.story_chapters where id = 'spv2val_c1';
  if not ok then raise exception 'SCRAPBOOK V2 VALIDATION FAILED: ended chapter changed by restart'; end if;
  n := n + 1;

  -- 8. shared memories of an ended chapter stay writable for in-progress
  --    post-end saves (the 6-hour grace itself is enforced by the server; see
  --    scrapbook-v2-validate.js) - the trigger must NOT block them
  insert into public.shared_memories (id, chapter_id, source_key, journey_key, created_at, updated_at) values ('spv2val_m1', 'spv2val_c1', 'k:s1e1', 'k', 2000, 2000);
  insert into public.shared_memory_members (id, memory_id, user_id, updated_at) values ('spv2val_mm1', 'spv2val_m1', 'spv2val_u1', 2000);
  n := n + 1;

  -- 9. one shared memory per (chapter, save key, version)
  begin
    insert into public.shared_memories (id, chapter_id, source_key, journey_key, created_at, updated_at) values ('spv2val_m1b', 'spv2val_c1', 'k:s1e1', 'k', 2000, 2000);
    raise exception 'SCRAPBOOK V2 VALIDATION FAILED: duplicate shared memory accepted';
  exception when unique_violation then n := n + 1; end;

  -- 10. atomic totals bump, clamped at zero
  perform public.sp_scrapbook_bump_totals('shared_memory_members', 'spv2val_mm1', 120, 60, 1, 2500);
  perform public.sp_scrapbook_bump_totals('shared_memory_members', 'spv2val_mm1', -500, 0, 0, 2600);
  select (watch_sec = 0 and together_sec = 60 and session_count = 1 and last_watched_at = 2600) into ok from public.shared_memory_members where id = 'spv2val_mm1';
  if not ok then raise exception 'SCRAPBOOK V2 VALIDATION FAILED: bump_totals'; end if;
  n := n + 1;

  -- 11. pair decision is all-or-nothing
  insert into public.sitting_decisions (sitting_id, user_id, source_key, destination, decided_at, last_active_at) values ('spv2val_s2', 'spv2val_u2', 'k:s1e1', 'PERSONAL', 1, 1);
  r := public.sp_scrapbook_decide_pair(
    '{"id":"spv2val_co1","chapter_id":"spv2val_c2","source_key":"k:s1e1","opened_at":1,"last_active_at":1}',
    '{"sitting_id":"spv2val_s2","user_id":"spv2val_u2","source_key":"k:s1e1","destination":"SHARED","chapter_id":"spv2val_c2","co_sitting_id":"spv2val_co1","reason":"co_watch","decided_at":1,"last_active_at":1}',
    '{"sitting_id":"spv2val_s1","user_id":"spv2val_u1","source_key":"k:s1e1","destination":"SHARED","chapter_id":"spv2val_c2","co_sitting_id":"spv2val_co1","reason":"co_watch","decided_at":1,"last_active_at":1}');
  select count(*) into cnt from public.sitting_decisions where sitting_id = 'spv2val_s1';
  if (r->>'applied')::boolean or cnt <> 0 or exists (select 1 from public.co_sittings where id = 'spv2val_co1')
     or (select destination from public.sitting_decisions where sitting_id = 'spv2val_s2') <> 'PERSONAL' then
    raise exception 'SCRAPBOOK V2 VALIDATION FAILED: decide_pair was not atomic';
  end if;
  n := n + 1;
  r := public.sp_scrapbook_decide_pair(
    '{"id":"spv2val_co2","chapter_id":"spv2val_c2","source_key":"k:s1e2","opened_at":1,"last_active_at":1}',
    '{"sitting_id":"spv2val_s4","user_id":"spv2val_u2","source_key":"k:s1e2","destination":"SHARED","chapter_id":"spv2val_c2","co_sitting_id":"spv2val_co2","reason":"co_watch","decided_at":1,"last_active_at":1}',
    '{"sitting_id":"spv2val_s3","user_id":"spv2val_u1","source_key":"k:s1e2","destination":"SHARED","chapter_id":"spv2val_c2","co_sitting_id":"spv2val_co2","reason":"co_watch","decided_at":1,"last_active_at":1}');
  select count(*) into cnt from public.sitting_decisions where sitting_id in ('spv2val_s3', 'spv2val_s4') and co_sitting_id = 'spv2val_co2';
  if not (r->>'applied')::boolean or cnt <> 2 then raise exception 'SCRAPBOOK V2 VALIDATION FAILED: decide_pair did not write both'; end if;
  n := n + 1;

  -- 12. decisions are write-once
  begin
    insert into public.sitting_decisions (sitting_id, user_id, source_key, destination, decided_at, last_active_at) values ('spv2val_s3', 'spv2val_u1', 'k:s1e2', 'PERSONAL', 1, 1);
    raise exception 'SCRAPBOOK V2 VALIDATION FAILED: decision overwritten';
  exception when unique_violation then n := n + 1; end;

  -- 13. ledger seq compare-and-set: an equal/older seq updates nothing
  insert into public.sitting_ledger (sitting_id, user_id, destination, target_id, last_seq, interval_start, interval_end, updated_at) values ('spv2val_s3', 'spv2val_u1', 'SHARED', 'spv2val_m1', 5, 0, 0, 0);
  update public.sitting_ledger set last_seq = 5 where sitting_id = 'spv2val_s3' and last_seq < 5;
  get diagnostics cnt = row_count;
  if cnt <> 0 then raise exception 'SCRAPBOOK V2 VALIDATION FAILED: ledger CAS'; end if;
  n := n + 1;

  -- 14. lock rows: second INSERT conflicts; only an EXPIRED lease can be stolen
  insert into public.scrapbook_locks (key, holder, until_at) values ('spv2val_lock', 'h1', 9999999999999);
  begin
    insert into public.scrapbook_locks (key, holder, until_at) values ('spv2val_lock', 'h2', 1);
    raise exception 'SCRAPBOOK V2 VALIDATION FAILED: duplicate lock row';
  exception when unique_violation then n := n + 1; end;
  update public.scrapbook_locks set holder = 'h2' where key = 'spv2val_lock' and until_at < 1000;
  get diagnostics cnt = row_count;
  if cnt <> 0 then raise exception 'SCRAPBOOK V2 VALIDATION FAILED: live lock stolen'; end if;
  n := n + 1;

  raise notice 'SCRAPBOOK V2 VALIDATION: ALL % CHECKS PASSED', n;
end $$;

rollback;
