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
  t0 bigint;
  f1 bigint;
  f2 bigint;
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

  insert into public.users (id, email, name, provider, created_at) values ('spv2val_u3', 'spv2val_u3@example.invalid', 'v3', 'email', 0);
  insert into public.sitting_intents (sitting_id, user_id, source_key, room_id, playing, first_seen_at, last_seen_at) values
    ('spv2val_s1', 'spv2val_u1', 'k:s1e1', 'R', true, 1, 1), ('spv2val_s2', 'spv2val_u2', 'k:s1e1', 'R', true, 1, 1),
    ('spv2val_s3', 'spv2val_u1', 'k:s1e2', 'R', true, 1, 1), ('spv2val_s4', 'spv2val_u2', 'k:s1e2', 'R', true, 1, 1),
    ('spv2val_s9', 'spv2val_u3', 'k:s1e2', 'R', true, 1, 1);

  -- 11. pair decision is all-or-nothing
  insert into public.sitting_decisions (sitting_id, user_id, source_key, destination, decided_at, last_active_at) values ('spv2val_s2', 'spv2val_u2', 'k:s1e1', 'PERSONAL', 1, 1);
  r := public.sp_scrapbook_decide_pair(
    '{"id":"spv2val_co1","chapter_id":"spv2val_c2","source_key":"k:s1e1","opened_at":1,"last_active_at":1}',
    '{"sitting_id":"spv2val_s2","user_id":"spv2val_u2","source_key":"k:s1e1","destination":"SHARED","chapter_id":"spv2val_c2","co_sitting_id":"spv2val_co1","reason":"co_watch","decided_at":1,"last_active_at":1}',
    '{"sitting_id":"spv2val_s1","user_id":"spv2val_u1","source_key":"k:s1e1","destination":"SHARED","chapter_id":"spv2val_c2","co_sitting_id":"spv2val_co1","reason":"co_watch","decided_at":1,"last_active_at":1}', null);
  select count(*) into cnt from public.sitting_decisions where sitting_id = 'spv2val_s1';
  if (r->>'applied')::boolean or cnt <> 0 or exists (select 1 from public.co_sittings where id = 'spv2val_co1')
     or (select destination from public.sitting_decisions where sitting_id = 'spv2val_s2') <> 'PERSONAL' then
    raise exception 'SCRAPBOOK V2 VALIDATION FAILED: decide_pair was not atomic';
  end if;
  n := n + 1;

  -- 12. 3+ viewers: a third account (not the chapter's Story pair) can never be paired
  begin
    r := public.sp_scrapbook_decide_pair(
      '{"id":"spv2val_co9","chapter_id":"spv2val_c2","source_key":"k:s1e2","opened_at":1,"last_active_at":1}',
      '{"sitting_id":"spv2val_s9","user_id":"spv2val_u3","source_key":"k:s1e2","destination":"SHARED","chapter_id":"spv2val_c2","co_sitting_id":"spv2val_co9","reason":"co_watch","decided_at":1,"last_active_at":1}',
      '{"sitting_id":"spv2val_s3","user_id":"spv2val_u1","source_key":"k:s1e2","destination":"SHARED","chapter_id":"spv2val_c2","co_sitting_id":"spv2val_co9","reason":"co_watch","decided_at":1,"last_active_at":1}', null);
    raise exception 'SCRAPBOOK V2 VALIDATION FAILED: non-partner viewer was paired';
  exception when sqlstate 'SPV01' then n := n + 1; end;

  -- 13. a pair claim with a sitting that is not that user's recorded intent is refused
  begin
    r := public.sp_scrapbook_decide_pair(
      '{"id":"spv2val_co8","chapter_id":"spv2val_c2","source_key":"k:s1e2","opened_at":1,"last_active_at":1}',
      '{"sitting_id":"spv2val_s9","user_id":"spv2val_u2","source_key":"k:s1e2","destination":"SHARED","chapter_id":"spv2val_c2","co_sitting_id":"spv2val_co8","reason":"co_watch","decided_at":1,"last_active_at":1}',
      '{"sitting_id":"spv2val_s3","user_id":"spv2val_u1","source_key":"k:s1e2","destination":"SHARED","chapter_id":"spv2val_c2","co_sitting_id":"spv2val_co8","reason":"co_watch","decided_at":1,"last_active_at":1}', null);
    raise exception 'SCRAPBOOK V2 VALIDATION FAILED: foreign sitting was paired';
  exception when sqlstate 'SPV01' then n := n + 1; end;

  -- 14. the real pair is written together
  r := public.sp_scrapbook_decide_pair(
    '{"id":"spv2val_co2","chapter_id":"spv2val_c2","source_key":"k:s1e2","opened_at":1,"last_active_at":1}',
    '{"sitting_id":"spv2val_s4","user_id":"spv2val_u2","source_key":"k:s1e2","destination":"SHARED","chapter_id":"spv2val_c2","co_sitting_id":"spv2val_co2","reason":"co_watch","decided_at":1,"last_active_at":1}',
    '{"sitting_id":"spv2val_s3","user_id":"spv2val_u1","source_key":"k:s1e2","destination":"SHARED","chapter_id":"spv2val_c2","co_sitting_id":"spv2val_co2","reason":"co_watch","decided_at":1,"last_active_at":1}', null);
  select count(*) into cnt from public.sitting_decisions where sitting_id in ('spv2val_s3', 'spv2val_s4') and co_sitting_id = 'spv2val_co2';
  if not (r->>'applied')::boolean or cnt <> 2 then raise exception 'SCRAPBOOK V2 VALIDATION FAILED: decide_pair did not write both'; end if;
  n := n + 1;

  -- 15. decisions are write-once (direct insert and via the function)
  begin
    insert into public.sitting_decisions (sitting_id, user_id, source_key, destination, decided_at, last_active_at) values ('spv2val_s3', 'spv2val_u1', 'k:s1e2', 'PERSONAL', 1, 1);
    raise exception 'SCRAPBOOK V2 VALIDATION FAILED: decision overwritten';
  exception when unique_violation then n := n + 1; end;
  r := public.sp_scrapbook_write_decision('{"sitting_id":"spv2val_s3","user_id":"spv2val_u1","source_key":"k:s1e2","destination":"PERSONAL","reason":"x"}', null);
  if r->>'destination' <> 'SHARED' then raise exception 'SCRAPBOOK V2 VALIDATION FAILED: write_decision overwrote'; end if;
  n := n + 1;

  -- 16. SHARED decisions only for the Story's members and only in an open chapter
  begin
    perform public.sp_scrapbook_write_decision('{"sitting_id":"spv2val_s9","user_id":"spv2val_u3","source_key":"k:s1e2","destination":"SHARED","chapter_id":"spv2val_c2","co_sitting_id":"spv2val_co2","reason":"x"}', null);
    raise exception 'SCRAPBOOK V2 VALIDATION FAILED: non-member SHARED decision';
  exception when sqlstate 'SPV01' then n := n + 1; end;
  begin
    perform public.sp_scrapbook_write_decision('{"sitting_id":"spv2val_s5","user_id":"spv2val_u1","source_key":"k:s1e1","destination":"SHARED","chapter_id":"spv2val_c1","co_sitting_id":"spv2val_co2","reason":"x"}', null);
    raise exception 'SCRAPBOOK V2 VALIDATION FAILED: SHARED decision in an ended chapter';
  exception when sqlstate 'SPC01' then n := n + 1; end;

  -- 17. ledger: insert, duplicate / older seq ignored, totals monotonic, applied once
  insert into public.shared_memories (id, chapter_id, source_key, journey_key, created_at, updated_at) values ('spv2val_m2', 'spv2val_c2', 'k:s1e2', 'k', 3000, 3000);
  insert into public.shared_memory_members (id, memory_id, user_id, updated_at) values ('spv2val_mm2', 'spv2val_m2', 'spv2val_u1', 3000);
  t0 := public.sp_now_ms();
  r := public.sp_scrapbook_save_ledger('{"sitting_id":"spv2val_s3","user_id":"spv2val_u1","target_id":"spv2val_m2","watch_cum":300,"together_cum":200}', 2, t0, 21600000, null);
  if r->>'status' <> 'inserted' then raise exception 'SCRAPBOOK V2 VALIDATION FAILED: ledger insert (%)', r; end if;
  r := public.sp_scrapbook_save_ledger('{"sitting_id":"spv2val_s3","user_id":"spv2val_u1","target_id":"spv2val_m2","watch_cum":900,"together_cum":900}', 2, t0, 21600000, null);
  if r->>'status' <> 'duplicate' then raise exception 'SCRAPBOOK V2 VALIDATION FAILED: duplicate seq applied'; end if;
  r := public.sp_scrapbook_save_ledger('{"sitting_id":"spv2val_s3","user_id":"spv2val_u1","target_id":"spv2val_m2","watch_cum":100,"together_cum":50}', 3, t0, 21600000, null);
  if r->>'status' <> 'advanced' or (r->'ledger'->>'watch_sec_cum')::bigint <> 300 or (r->'ledger'->>'together_sec_cum')::bigint <> 200 then
    raise exception 'SCRAPBOOK V2 VALIDATION FAILED: ledger totals moved backwards (%)', r; end if;
  ok := public.sp_scrapbook_apply_ledger('spv2val_s3', '{"w":0,"t":0,"s":0}', '{"w":300,"t":200,"s":1}', 'shared_memory_members', 'spv2val_mm2', t0, null);
  ok := ok and not public.sp_scrapbook_apply_ledger('spv2val_s3', '{"w":0,"t":0,"s":0}', '{"w":300,"t":200,"s":1}', 'shared_memory_members', 'spv2val_mm2', t0, null);
  if not ok then raise exception 'SCRAPBOOK V2 VALIDATION FAILED: apply_ledger CAS'; end if;
  select (watch_sec = 300 and together_sec = 200 and session_count = 1) into ok from public.shared_memory_members where id = 'spv2val_mm2';
  if not ok then raise exception 'SCRAPBOOK V2 VALIDATION FAILED: ledger delta applied twice'; end if;
  n := n + 1;

  -- 18. a co-sitting is linked (and its session counted) exactly once
  ok := public.sp_scrapbook_link_co('spv2val_co2', 'spv2val_m2', t0, null);
  ok := ok and not public.sp_scrapbook_link_co('spv2val_co2', 'spv2val_m2', t0, null);
  if not ok or (select session_count from public.shared_memories where id = 'spv2val_m2') <> 1 then
    raise exception 'SCRAPBOOK V2 VALIDATION FAILED: link_co'; end if;
  n := n + 1;

  -- 19/20. closed-chapter grace: in-progress sitting saves within 6 h of the end, not after
  insert into public.relations (id, user1_id, user2_id, created_at, accepted_at) values ('spv2val_rel2', 'spv2val_u1', 'spv2val_u3', 0, 1);
  insert into public.story_chapters (id, relation_id, chapter_no, started_at, legacy, created_at) values ('spv2val_g1', 'spv2val_rel2', 1, t0 - 30000000, false, 0);
  insert into public.shared_memories (id, chapter_id, source_key, journey_key, created_at, updated_at) values ('spv2val_gm1', 'spv2val_g1', 'g:1', 'g', 0, 0);
  update public.story_chapters set ended_at = t0 - 25200000, end_mode = 'end' where id = 'spv2val_g1';  -- ended 7 h ago
  insert into public.story_chapters (id, relation_id, chapter_no, started_at, legacy, created_at) values ('spv2val_g2', 'spv2val_rel2', 2, t0 - 3000000, false, 0);
  insert into public.sitting_decisions (sitting_id, user_id, source_key, destination, chapter_id, decided_at, last_active_at) values
    ('spv2val_g1s', 'spv2val_u1', 'g:1', 'SHARED', 'spv2val_g1', t0 - 26000000, t0 - 26000000),
    ('spv2val_g2s', 'spv2val_u1', 'g:2', 'SHARED', 'spv2val_g2', t0 - 2000000, t0 - 2000000),
    ('spv2val_g3s', 'spv2val_u1', 'g:2', 'SHARED', 'spv2val_g2', t0 - 100000, t0 - 100000);
  insert into public.shared_memories (id, chapter_id, source_key, journey_key, created_at, updated_at) values ('spv2val_gm2', 'spv2val_g2', 'g:2', 'g2', 0, 0);
  update public.story_chapters set ended_at = t0 - 1000000, end_mode = 'end' where id = 'spv2val_g2';  -- ended ~17 min ago
  r := public.sp_scrapbook_save_ledger('{"sitting_id":"spv2val_g2s","user_id":"spv2val_u1","target_id":"spv2val_gm2","watch_cum":60,"together_cum":0}', 1, t0, 21600000, null);
  if r->>'status' <> 'inserted' then raise exception 'SCRAPBOOK V2 VALIDATION FAILED: in-grace post-end save refused (%)', r; end if;
  n := n + 1;
  r := public.sp_scrapbook_save_ledger('{"sitting_id":"spv2val_g1s","user_id":"spv2val_u1","target_id":"spv2val_gm1","watch_cum":60,"together_cum":0}', 1, t0, 21600000, null);
  if r->>'status' <> 'chapter_closed' then raise exception 'SCRAPBOOK V2 VALIDATION FAILED: >6 h post-end save accepted (%)', r; end if;
  r := public.sp_scrapbook_save_ledger('{"sitting_id":"spv2val_g1s","user_id":"spv2val_u1","target_id":"spv2val_gm1","watch_cum":60,"together_cum":0}', 2, t0 - 99999999, 21600000, null);
  if r->>'status' <> 'chapter_closed' then raise exception 'SCRAPBOOK V2 VALIDATION FAILED: a lagging server clock re-opened the grace window'; end if;
  r := public.sp_scrapbook_save_ledger('{"sitting_id":"spv2val_g3s","user_id":"spv2val_u1","target_id":"spv2val_gm2","watch_cum":60,"together_cum":0}', 1, t0, 21600000, null);
  if r->>'status' <> 'chapter_closed' then raise exception 'SCRAPBOOK V2 VALIDATION FAILED: sitting decided after the end was saved'; end if;
  n := n + 1;

  -- 21. removed generation: no save, no new memory / member (no resurrection)
  insert into public.journey_state (id, space, journey_key, generation, removed_at, removed_by, purge_after, updated_at)
    values ('spv2val_js1', 'c:spv2val_c2', 'k', 1, t0, 'spv2val_u2', t0 - 1, t0);
  r := public.sp_scrapbook_save_ledger('{"sitting_id":"spv2val_s3","user_id":"spv2val_u1","target_id":"spv2val_m2","watch_cum":999,"together_cum":0}', 9, t0, 21600000, null);
  if r->>'status' <> 'removed' then raise exception 'SCRAPBOOK V2 VALIDATION FAILED: save into removed generation (%)', r; end if;
  begin
    insert into public.shared_memories (id, chapter_id, source_key, journey_key, created_at, updated_at) values ('spv2val_m3', 'spv2val_c2', 'k:s1e3', 'k', 1, 1);
    raise exception 'SCRAPBOOK V2 VALIDATION FAILED: memory created in removed generation';
  exception when sqlstate 'SPR01' then null; end;
  begin
    insert into public.shared_memory_members (id, memory_id, user_id, updated_at) values ('spv2val_mm3', 'spv2val_m2', 'spv2val_u2', 1);
    raise exception 'SCRAPBOOK V2 VALIDATION FAILED: member added to removed generation';
  exception when sqlstate 'SPR01' then null; end;
  n := n + 1;

  -- 22. journey compare-and-set: a stale expectation changes nothing
  r := public.sp_scrapbook_journey_update('spv2val_js1', '{"removal_state":"requested"}', '{"display_title":"x"}', false, null);
  if r is not null or (select display_title from public.journey_state where id = 'spv2val_js1') is not null then
    raise exception 'SCRAPBOOK V2 VALIDATION FAILED: journey CAS ignored its expectation'; end if;
  n := n + 1;

  -- 23. purge is atomic and a purged generation can never be restored
  r := public.sp_scrapbook_purge_journey('spv2val_js1', t0, '[]', null);
  if not (r->>'purged')::boolean or exists (select 1 from public.shared_memories where id = 'spv2val_m2')
     or not exists (select 1 from public.memory_tombstones where id = 'tomb_spv2val_js1') then
    raise exception 'SCRAPBOOK V2 VALIDATION FAILED: purge (%)', r; end if;
  r := public.sp_scrapbook_purge_journey('spv2val_js1', t0, '[]', null);
  if (r->>'purged')::boolean then raise exception 'SCRAPBOOK V2 VALIDATION FAILED: purged twice'; end if;
  begin
    perform public.sp_scrapbook_journey_update('spv2val_js1', '{}', '{"removed_at":null,"removed_by":null,"purge_after":null}', false, null);
    raise exception 'SCRAPBOOK V2 VALIDATION FAILED: purged generation restored';
  exception when sqlstate 'SPR01' then null; end;
  n := n + 1;

  -- 24. a removed generation cannot be restored once a newer one exists
  insert into public.journey_state (id, space, journey_key, generation, removed_at, purge_after, updated_at) values
    ('spv2val_js2', 'c:spv2val_c2', 'q', 1, t0, t0 + 1000000, t0), ('spv2val_js3', 'c:spv2val_c2', 'q', 2, null, null, t0);
  begin
    update public.journey_state set removed_at = null where id = 'spv2val_js2';
    raise exception 'SCRAPBOOK V2 VALIDATION FAILED: restore over a newer generation';
  exception when sqlstate 'SPR01' then n := n + 1; end;

  -- 25. closed chapters' journeys are read-only for removal actions
  insert into public.journey_state (id, space, journey_key, generation, updated_at) values ('spv2val_js4', 'c:spv2val_c1', 'k', 1, 1);
  begin
    perform public.sp_scrapbook_journey_update('spv2val_js4', '{}', '{"removal_state":"requested"}', true, null);
    raise exception 'SCRAPBOOK V2 VALIDATION FAILED: closed chapter journey changed';
  exception when sqlstate 'SPC01' then n := n + 1; end;

  -- 26. fencing: a live lease cannot be taken; an expired one moves to a new, larger fence
  f1 := public.sp_scrapbook_lock_acquire('spv2val_lock', 'h1', 60000);
  f2 := public.sp_scrapbook_lock_acquire('spv2val_lock', 'h2', 60000);
  if f1 is null or f2 is not null then
    raise exception 'SCRAPBOOK V2 VALIDATION FAILED: live lease taken over'; end if;
  update public.scrapbook_locks set until_at = 0 where key = 'spv2val_lock';
  f2 := public.sp_scrapbook_lock_acquire('spv2val_lock', 'h2', 60000);
  ok := public.sp_scrapbook_lock_renew('spv2val_lock', 'h1', f1, 60000);
  if f2 is null or f2 <= f1 or ok then
    raise exception 'SCRAPBOOK V2 VALIDATION FAILED: fence did not advance'; end if;
  n := n + 1;

  -- 27. fencing: the old owner's write is rejected and changes nothing; the new owner's succeeds
  begin
    perform public.sp_scrapbook_write_decision('{"sitting_id":"spv2val_s7","user_id":"spv2val_u1","source_key":"k:s1e7","destination":"PERSONAL","reason":"stale"}',
      jsonb_build_array(jsonb_build_object('k', 'spv2val_lock', 'f', f1)));
    raise exception 'SCRAPBOOK V2 VALIDATION FAILED: stale fence accepted';
  exception when sqlstate 'SPF01' then null; end;
  if exists (select 1 from public.sitting_decisions where sitting_id = 'spv2val_s7') then raise exception 'SCRAPBOOK V2 VALIDATION FAILED: stale write persisted'; end if;
  r := public.sp_scrapbook_write_decision('{"sitting_id":"spv2val_s7","user_id":"spv2val_u1","source_key":"k:s1e7","destination":"PERSONAL","reason":"fresh"}',
      jsonb_build_array(jsonb_build_object('k', 'spv2val_lock', 'f', f2)));
  ok := not public.sp_scrapbook_lock_release('spv2val_lock', 'h1', f1);
  ok := ok and public.sp_scrapbook_lock_release('spv2val_lock', 'h2', f2);
  if r->>'reason' <> 'fresh' or not ok then
    raise exception 'SCRAPBOOK V2 VALIDATION FAILED: current owner write/release'; end if;
  n := n + 1;

  -- 28. only service_role may call the functions (Supabase roles)
  if exists (select 1 from pg_roles where rolname = 'anon') then
    select bool_and(not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('authenticated', p.oid, 'execute'))
      into ok from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace where ns.nspname = 'public' and p.proname like 'sp\_scrapbook\_%';
    if not ok then raise exception 'SCRAPBOOK V2 VALIDATION FAILED: anon/authenticated can execute a scrapbook function'; end if;
    select bool_and(has_function_privilege('service_role', ('public.' || x)::regprocedure, 'execute')) into ok from unnest(array[
      'sp_scrapbook_lock_acquire(text,text,bigint)', 'sp_scrapbook_write_decision(jsonb,jsonb)', 'sp_scrapbook_decide_pair(jsonb,jsonb,jsonb,jsonb)',
      'sp_scrapbook_save_ledger(jsonb,integer,bigint,bigint,jsonb)', 'sp_scrapbook_journey_update(text,jsonb,jsonb,boolean,jsonb)',
      'sp_scrapbook_purge_journey(text,bigint,jsonb,jsonb)']) as x;
    if not ok then raise exception 'SCRAPBOOK V2 VALIDATION FAILED: service_role cannot execute'; end if;
  end if;
  n := n + 1;

  -- 29. row level security on every v2 table
  select bool_and(c.relrowsecurity) into ok from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
    where ns.nspname = 'public' and c.relname in ('story_chapters','shared_memories','shared_memory_members','journey_state','journey_member_prefs',
      'sitting_intents','co_sittings','sitting_decisions','sitting_ledger','memory_tombstones','memory_events','moment_seen','maintenance_runs','maintenance_lease','scrapbook_locks');
  if not ok then raise exception 'SCRAPBOOK V2 VALIDATION FAILED: RLS disabled on a v2 table'; end if;
  n := n + 1;

  raise notice 'SCRAPBOOK V2 VALIDATION: ALL % CHECKS PASSED', n;
end $$;

rollback;
