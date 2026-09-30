# Scrapbook V2 – Postgres validation procedure

V2 stays **OFF** (`SCRAPBOOK_SHARED_V2` unset / `0`). Nothing here enables it.

## 1. Schema (required before deploying this build, even with V2 OFF)
Story chapters are opened/closed on Story start/end regardless of the flag, so
apply `supabase-schema.sql` sections **9.1–9.7** first (idempotent; re-running
is safe). 9.7 adds `scrapbook_locks`, `sp_scrapbook_bump_totals` and
`sp_scrapbook_decide_pair`.

## 2. Database protections – safe on production
Paste `scripts/scrapbook-v2-validate.sql` into the Supabase SQL editor (or
`psql -f`). It runs in one transaction that ends in `ROLLBACK`, uses only
synthetic `spv2val_` rows and never touches existing data.
Expected: `SCRAPBOOK V2 VALIDATION: ALL 16 CHECKS PASSED`.

## 3. Application rules – staging / Supabase branch ONLY
```
SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=... \
node scripts/scrapbook-v2-validate.js --confirm-staging=<ref>
```
Refuses to run without a matching `--confirm-staging` or with
`NODE_ENV=production`. Checks: ended chapter immutable, in-grace save of a
sitting decided before the end is applied, a save after the 6 h grace is
ignored, restart opens a new chapter, the old one stays read-only. It prints the
cleanup SQL for the closed chapter rows the trigger (by design) will not delete.

## What has and has not been verified
* Verified locally against real PostgreSQL 18 (PGlite): schema applies twice,
  validation SQL passes and leaves no rows, the negative control (trigger
  dropped) fails, app checks pass, race suite passes (`SP_TEST_DB=pg`).
* **Not yet verified:** a real Supabase project (PostgREST, RLS, grants),
  and true multi-connection concurrency (PGlite is single-connection).
