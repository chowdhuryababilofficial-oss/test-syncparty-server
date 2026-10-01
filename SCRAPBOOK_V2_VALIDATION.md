# Scrapbook V2 – Postgres validation and deployment procedure

Scrapbook V2 is the **single, authoritative Scrapbook architecture**. There is
no feature flag any more (`SCRAPBOOK_SHARED_V2` is ignored if still set) and
no v1 save/read path: Our Story = one shared memory per chapter journey
(`story_chapters` / `shared_memories` / `shared_memory_members`), My Scrapbook
= the caller's personal rows (`scrapbook_entries`, scope `personal` /
`personal:vN` generations), and every lifecycle change goes through journey
state (rename / archive / remove + 30-day restore / removal requests / purge).

## 1. Schema (required before deploying this build)
Apply `supabase-schema.sql` sections **9.1–9.9** (idempotent; re-running is
safe).
* 9.9 – final cut-over guard: trigger `scrapbook_entries_v2_only_trg` rejects
  any NEW v1 per-partner shared copy (insert, or re-scoping a row into
  `shared:%`) with SQLSTATE `SPV02`; existing legacy rows stay as inert,
  migrated history and may still get their link/flag columns updated. Also
  pins `search_path` on `story_chapters_immutable()` (advisor warning).
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

The server **fails closed** (HTTP 503, `SP_SCHEMA_MISSING`) if any
9.7/9.8 function is missing – there is no unguarded fallback path any more.

## 2. Database protections – safe on production
Paste `scripts/scrapbook-v2-validate.sql` into the Supabase SQL editor (or
`psql -f`). One transaction ending in `ROLLBACK`, synthetic `spv2val_` rows
only, never touches existing data.
Expected: `SCRAPBOOK V2 VALIDATION: ALL 33 CHECKS PASSED` (checks 30–31: the
9.9 guard).

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

## 6. Deployment order (final architecture)
1. Apply `supabase-schema.sql` (9.1–9.9) to the Supabase project.
2. Run `scripts/scrapbook-v2-validate.sql` there (rollback-only) – must report
   ALL 33 CHECKS PASSED.
3. Migrate existing v1 data once: `node scripts/scrapbook-v2-backfill.js`
   (dry run, prints the plan) then `node scripts/scrapbook-v2-backfill.js
   --apply`. It creates one legacy chapter per pre-chapter Story, folds each
   episode's per-partner v1 shared copies into ONE chapter memory (per-member
   watch preserved, together/sessions = max, not summed), links every v1 row
   (`migrated_to_shared_id`), flags pure personal twins and folds whole-journey
   archive flags. Never deletes or rewrites row content. A re-run must report
   0 rows. (Safety net: an Our Story read of a legacy chapter migrates any
   straggler v1 rows of that Story the same way, under a lock.)
4. Deploy this server build (no Scrapbook env flag needed).
5. Ship the extension build.

## 7. Single architecture – what replaced the v1 paths
* `GET /api/scrapbook` reads V2 only (`listSharedV2` / `listPersonalV2`).
* `POST /api/scrapbook/entries` scope `shared` (manual /keep "Our Story", and
  extensions installed before the sitting client) is folded into the chapter's
  one shared memory for the CALLER only (`directSharedSave`) – never a copy
  per partner, never a personal twin. Scope `personal` writes the current
  journey generation (a removed/purged generation is never resurrected).
* `/entries/bulk`: backed-up sitting envelopes always go through `saveSitting`;
  device-only (signed-out) memories land in V2 My Scrapbook.
* `/entries/remove` = V2 soft remove (30-day restore, tombstoned purge) –
  no hard delete.
* Highlights, reconcile and Moments read V2 storage.
* `GET /api/scrapbook/capabilities` stays as a compatibility handshake for
  installed extensions and always answers `sharedV2:true`.
* Extension: signed in, every automatic save is ONE sitting save (server
  decides My Scrapbook vs Our Story); player iframes relay check-ins so the top
  frame sends intents, decides and accrues Together Time for embedded players;
  /keep saves to exactly one place; signed out = device-only, uploaded on
  sign-in.
Regression: `tests/scrapbook-v2-final.test.js` (in-memory, or a real DB with
`SP_TEST_REAL=1`).

## What has and has not been verified
* Verified on **real PostgreSQL 17.10 + PostgREST 12.2.3 + @supabase/supabase-js**
  (local, Supabase roles/privileges emulated): schema applies twice; validation
  SQL fully rolled back; negative controls (resurrection trigger
  dropped, fence check disabled, Story-pair check disabled) each make it fail;
  validate.js 20/20; multi-process concurrency 42/42 (4 processes, locks ON and
  OFF, plus 16-connection SQL phase); anon cannot execute the functions and
  sees no rows (RLS).
* Verified on the **real Supabase dev project** (PostgreSQL 17.6, via the
  Supavisor pooler + PostgREST 12.2.3 with the service role): schema 9.1–9.9
  applied (9.9 as migration `syncparty_scrapbook_v2_9_9_single_architecture`);
  validation SQL 33/33 (rolled back); security advisors: no warnings (only the
  by-design INFO "RLS enabled, no policies" on backend-only tables); backfill
  dry-run → apply → re-run 0 on the real data (4 relations, 4 legacy
  chapters, 6 v1 shared rows → 3 memories / 6 members, 1 twin flagged; row
  content hash unchanged; member watch = v1 watch, together = max);
  validate.js 20/20; final-architecture suite 18/18; end-to-end scenarios
  `tests/scrapbook-v2-real-e2e.test.js` 52/52; multi-process concurrency 35/35
  (4 workers, 5 trials); real client smoke `tests/scrapbook-v2-real-client.test.js`
  10/10 (top-frame solo, cross-origin iframe co-watch with Together Time,
  /keep). All synthetic test users removed afterwards.
* Lock wait: `SCRAPBOOK_LOCK_WAIT_MS` (default 10000) must exceed the time a
  save holds its lock. At ~350 ms per database round trip (far client) four
  simultaneous saves of one sitting can exceed 10 s and get a retryable 503;
  keep the server in the database's region or raise the wait.
