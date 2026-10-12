begin;
do $$
declare uid text := 'spaudit_' || gen_random_uuid()::text; result jsonb; n integer; at1 bigint; rejected boolean;
begin
  insert into public.users(id,email,name,provider,created_at)
    values(uid,uid || '@example.invalid','Audit rollback','email',1);
  insert into public.notification_reads(user_id,notif_id,read_at)
    select uid, 'tie:' || lpad(g::text,3,'0'),1 from generate_series(1,450) g;
  result := public.sp_account_notifications_read(uid,'["newest","newest",""]'::jsonb);
  select count(*) into n from public.notification_reads where user_id=uid;
  if n <> 400 or (result->>'added')::integer <> 1 then raise exception 'retention failed: %, %',n,result; end if;
  select read_at into at1 from public.notification_reads where user_id=uid and notif_id='newest';
  result := public.sp_account_notifications_read(uid,'["newest"]'::jsonb);
  if (result->>'added')::integer <> 0 or at1 <> (select read_at from public.notification_reads where user_id=uid and notif_id='newest') then raise exception 'idempotency failed'; end if;
  rejected := false;
  begin update public.users set quick_reactions='["a","b","c","d","e","f","g"]'::jsonb where id=uid;
  exception when check_violation then rejected:=true; end;
  if not rejected then raise exception 'tray limit failed'; end if;
  rejected := false;
  begin insert into public.notification_reads values(uid,'newest',1);
  exception when unique_violation then rejected:=true; end;
  if not rejected then raise exception 'uniqueness failed'; end if;
  rejected := false;
  begin insert into public.notification_reads values(uid || '_absent','unknown',1);
  exception when foreign_key_violation then rejected:=true; end;
  if not rejected then raise exception 'foreign key failed'; end if;
  if not has_function_privilege('service_role','public.sp_account_notifications_read(text,jsonb)','EXECUTE')
    or has_function_privilege('anon','public.sp_account_notifications_read(text,jsonb)','EXECUTE')
    or has_function_privilege('authenticated','public.sp_account_notifications_read(text,jsonb)','EXECUTE') then raise exception 'RPC permissions failed'; end if;
  delete from public.users where id=uid;
  if exists(select 1 from public.notification_reads where user_id=uid) then raise exception 'cascade failed'; end if;
end $$;
set local role anon;
do $$ begin
  if exists(select 1 from public.notification_reads) then raise exception 'anon RLS exposure'; end if;
end $$;
reset role;
select 'PASS: exact retention, idempotency, tray limit, uniqueness, FK, cascade, service-only RPC and anonymous RLS; transaction rolled back' as audit;
rollback;
