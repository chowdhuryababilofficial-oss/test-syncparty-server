-- SyncParty Highlights storage migration. Safe to run repeatedly.
-- Run this on Supabase before deploying the server/extension changes.


-- ---------------------------------------------------------------------------
-- 9.12 Highlights: private scene/conversation records (separate from titles).
-- Backend-managed only. The service role enforces owner and Our Story access.
-- ---------------------------------------------------------------------------
create table if not exists public.scrapbook_highlights (
  id text primary key,
  user_id text not null references public.users(id) on delete cascade,
  scope text not null default 'personal' check (scope in ('personal','shared')),
  relation_id text references public.relations(id) on delete set null,
  request_id text not null,
  data jsonb not null check (jsonb_typeof(data) = 'object'),
  created_at bigint not null,
  updated_at bigint not null,
  deleted_at bigint,
  constraint scrapbook_highlights_request_nonempty check (char_length(request_id) between 8 and 100),
  constraint scrapbook_highlights_scope_relation check ((scope = 'personal' and relation_id is null) or (scope = 'shared' and relation_id is not null)),
  constraint scrapbook_highlights_data_shape check (
    jsonb_typeof(data->'media') = 'object' and
    jsonb_typeof(data->'segments') = 'array' and
    jsonb_array_length(data->'segments') between 1 and 24 and
    jsonb_typeof(data->'messages') = 'array' and
    jsonb_array_length(data->'messages') between 1 and 120
  )
);
create unique index if not exists scrapbook_highlights_user_request_uidx
  on public.scrapbook_highlights(user_id, request_id);
create index if not exists scrapbook_highlights_personal_recent_idx
  on public.scrapbook_highlights(user_id, created_at desc) where scope = 'personal' and deleted_at is null;
create index if not exists scrapbook_highlights_shared_recent_idx
  on public.scrapbook_highlights(relation_id, created_at desc) where scope = 'shared' and deleted_at is null;
alter table public.scrapbook_highlights enable row level security;
revoke all on table public.scrapbook_highlights from public, anon, authenticated;
grant all on table public.scrapbook_highlights to service_role;
