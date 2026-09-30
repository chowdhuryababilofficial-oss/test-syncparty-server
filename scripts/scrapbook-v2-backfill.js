#!/usr/bin/env node
// Scrapbook v2 backfill. Dry-run by default: prints the report and writes
// nothing. Pass --apply to perform it. Idempotent: re-running finds nothing.
// Never deletes or rewrites legacy scrapbook rows (only link/flag columns).
//   node scripts/scrapbook-v2-backfill.js            # report only
//   node scripts/scrapbook-v2-backfill.js --apply    # apply
const path = require("path");
const store = require(path.join(__dirname, "..", "scrapbook-store.js"));

(async () => {
  const apply = process.argv.includes("--apply");
  const report = await store.runBackfill({ apply });
  console.log(JSON.stringify(report, null, 2));
  if (!apply) console.log("\nDry run only. Re-run with --apply to write these changes.");
})().catch(e => { console.error(e?.stack || e); process.exit(1); });
