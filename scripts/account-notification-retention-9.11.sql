-- 9.11: serialize per-account notification inserts and prune deterministically.
-- Backward-compatible with 9.10 servers; no user data is changed at migration time.
create or replace function public.sp_account_notifications_read(p_user_id text, p_ids jsonb)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare v_added integer; v_at bigint;
begin
  if p_user_id is null or p_ids is null or jsonb_typeof(p_ids) <> 'array' then
    raise exception 'Invalid notification read payload' using errcode = '22023';
  end if;
  -- One lock per user. Unlike a server-process mutex, this covers all devices
  -- and relay instances. Other accounts are not blocked.
  perform pg_advisory_xact_lock(hashtextextended('notification_reads:' || p_user_id, 0));
  if not exists (select 1 from public.users where id = p_user_id) then
    raise exception 'Account not found' using errcode = '23503';
  end if;
  v_at := (extract(epoch from clock_timestamp()) * 1000)::bigint;
  insert into public.notification_reads (user_id, notif_id, read_at)
    select p_user_id, notif_id, v_at
    from (select distinct btrim(value #>> '{}') as notif_id
          from jsonb_array_elements(p_ids) where jsonb_typeof(value) = 'string') ids
    where char_length(notif_id) between 1 and 200
    order by notif_id limit 100
    on conflict (user_id, notif_id) do nothing;
  get diagnostics v_added = row_count;
  -- A stable tie-breaker makes the limit exact even when a whole batch (or
  -- concurrent batches) shares a millisecond. Do not rewrite existing rows.
  delete from public.notification_reads n
    where n.user_id = p_user_id and n.notif_id in (
      select notif_id from public.notification_reads where user_id = p_user_id
      order by read_at desc, notif_id asc offset 400
    );
  return jsonb_build_object('added', v_added);
end $$;
revoke execute on function public.sp_account_notifications_read(text, jsonb) from public, anon, authenticated;
grant execute on function public.sp_account_notifications_read(text, jsonb) to service_role;
