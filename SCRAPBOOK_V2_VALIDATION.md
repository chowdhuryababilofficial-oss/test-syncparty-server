# Scrapbook V2 – Postgres validation and deployment procedure

V2 stays **OFF** (`SCRAPBOOK_SHARED_V2` unset / `0`). Nothing here enables it.

## 1. Schema (required before deploying this build, even with V2 OFF)
Story chapters are opened/closed on Story start/end regardless of the flag, so
apply `supabase-schema.sql` sections **9.1–9.8** first (idempotent; re-running
is safe; applied twice in a row on PostgreSQL 17 without error).
* 9.7 – `scrapbook_locks`, `sp_scrapbook_bump_totals`.
* 9.8 – database-authoritative transitions:
  * leases with **fencing tokens** (`scrapbook_locks.fence`,
    `sp_scrapbook_lock_acquire / _renew / _release`); every critical write
    carries the caller's fences and is rejected with SQLSTATE `SPF01`
    (`SP_FENCED`) if the lease moved to another worker;
  * atomic, self-validating functions: `sp_scrapbook_write_decision`,
    `sp_scrapbook_decide_pair` (the two users must be exactly the chapter's
    active Story pair, each sitting must be that user's recorded intent),
    `sp_scrapbook_save_ledger` (owner/target/closed-chapter 6 h grace/removal
    checked in the DB, monotonic seq + totals), `sp_scrapbook_apply_ledger`,
    `sp_scrapbook_apply_co`, `sp_scrapbook_link_co`,
    `sp_scrapbook_journey_update` (compare-and-set), `sp_scrapbook_purge_journey`;
  * triggers: nothing can be inserted into a removed generation
    (`SPR01`), a purged generation can never be restored, a removed generation
    cannot be restored once a newer one exists;
  * the old 3-argument `sp_scrapbook_decide_pair` is dropped (it was only ever
    used with V2 ON, which never shipped);
  * execute granted to `service_role` only (revoked from public/anon/authenticated).

With V2 ON the server **fails closed** (HTTP 503, `SP_SCHEMA_MISSING`) if any
9.7/9.8 function is missing – there is no unguarded fallback path any more.

## 2. Database protections – safe on production
Paste `scripts/scrapbook-v2-validate.sql` into the Supabase SQL editor (or
`psql -f`). One transaction ending in `ROLLBACK`, synthetic `spv2val_` rows
only, never touches existing data.
Expected: `SCRAPBOOK V2 VALIDATION: ALL 31 CHECKS PASSED`.

## 3. Application rules – staging / Supabase branch ONLY
```
SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=... \
node scripts/scrapbook-v2-validate.js --confirm-staging=<ref>
```
Refuses to run without a matching `--confirm-staging` (or `--local-stack` on
localhost) or with `NODE_ENV=production`. 20 checks: ended chapter immutable
(reopen/modify/delete refused by the DB), in-grace post-end save applied to the
same chapter, save after 6 h ignored with totals unchanged, restart = new
chapter, old chapter read-only, removed journey cannot be resurrected (app and
direct DB insert), decline on an already-removed journey creates no state row.
Prints cleanup SQL for the closed chapter rows the trigger will not delete.

## 4. Multi-server concurrency – staging / Supabase branch ONLY
```
SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=... \
node scripts/scrapbook-v2-concurrency.js --confirm-staging=<ref> --workers=4 --trials=10 \
  [--db-url=postgresql://postgres:<pw>@db.<ref>.supabase.co:5432/postgres]
```
Forks N Node processes, each a full server instance (real scrapbook-store.js +
real supabase-js), firing at the same instant: pair race (+ duplicate decides +
an unrelated 3rd viewer), concurrent first saves, duplicate/out-of-order saves,
confirm vs decline, expiry vs confirm, purge vs restore, fencing (stale lease
owner rejected). Every scenario runs with DB locks ON and OFF. `--db-url`
adds a 16-connection direct SQL phase. Writes synthetic `spv2conc-<run>` rows.

## 5. Local reproduction (no Supabase needed)
`tests/scrapbook-v2-concurrency-pg.test.js` creates a fresh database on a real
PostgreSQL server, emulates the Supabase roles (`anon`, `authenticated`,
`service_role` BYPASSRLS, `authenticator`) and default privileges, applies the
schema, starts a real PostgREST behind a `/rest/v1` proxy and runs sections 2–4
against it, then drops the database.
```
SP_PG_ADMIN_URL=postgres://postgres@127.0.0.1:5432/postgres SP_POSTGREST_BIN=$(which postgrest) \
NODE_PATH=<dir with pg, @supabase/supabase-js> node tests/scrapbook-v2-concurrency-pg.test.js
```

## 6. Deployment order
1. Apply `supabase-schema.sql` (9.1–9.8) to the Supabase project.
2. Run `scripts/scrapbook-v2-validate.sql` there (rollback-only) – must report ALL 31 CHECKS PASSED.
3. Deploy this server build with `SCRAPBOOK_SHARED_V2` unset (V2 OFF).
4. On a staging project/branch with the same schema: `scrapbook-v2-validate.js`
   and `scrapbook-v2-concurrency.js` (sections 3–4), all green.
5. Ship the extension build.
6. Only later, as a separate decision: enable `SCRAPBOOK_SHARED_V2=1`, then
   run `node scripts/scrapbook-v2-backfill.js` (dry run) and
   `node scripts/scrapbook-v2-backfill.js --apply` once, to fold v1 shared
   copies written while V2 was OFF into their chapter memories.

## 7. Kill switch (V2 OFF, and an ON -> OFF flip)
With `SCRAPBOOK_SHARED_V2` unset/0 the v2-only routes
(`/api/scrapbook/sittings/*`, `/journeys/action`, `/chapters`, `/moments`,
`/moments/seen`) answer `503 {ok:false, code:"SCRAPBOOK_V2_DISABLED",
sharedV2:false}` before any storage access, and the same guard sits inside the
store functions. A backed-up sitting sent to `/entries/bulk` is refused, never
re-saved as a v1 personal entry. A client caught mid-sitting by an ON -> OFF
flip keeps its envelope in its separate v2 backup (503 = retryable) and it
lands exactly once if V2 is turned back ON. V1 save/list/remove/highlights use
the v1 table only. Chapter rows are still maintained on Story start/end while
OFF (boundary bookkeeping only); chapters opened while OFF are flagged
`legacy`, so their v1 shared copies stay readable after V2 is turned ON.
Regression: `tests/scrapbook-v2-killswitch.test.js` (in-memory, or a real DB
with `SP_TEST_REAL=1`).

## What has and has not been verified
* Verified on **real PostgreSQL 17.10 + PostgREST 12.2.3 + @supabase/supabase-js**
  (local, Supabase roles/privileges emulated): schema applies twice; validation
  SQL 31/31 and fully rolled back; negative controls (resurrection trigger
  dropped, fence check disabled, Story-pair check disabled) each make it fail;
  validate.js 20/20; multi-process concurrency 42/42 (4 processes, locks ON and
  OFF, plus 16-connection SQL phase); anon cannot execute the functions and
  sees no rows (RLS).
* Verified on the **real Supabase dev project** (PostgreSQL 17.6, via the
  Supavisor pooler + PostgREST 12.2.3 with the service role): schema 9.1–9.8
  applied; validation SQL 31/31 (rolled back); validate.js 20/20;
  multi-process concurrency harness; kill switch 39/39; end-to-end scenarios
  `tests/scrapbook-v2-real-e2e.test.js` 45/45.
* Lock wait: `SCRAPBOOK_LOCK_WAIT_MS` (default 10000) must exceed the time a
  save holds its lock. At ~350 ms per database round trip (far client) four
  simultaneous saves of one sitting can exceed 10 s and get a retryable 503;
  keep the server in the database's region or raise the wait.
