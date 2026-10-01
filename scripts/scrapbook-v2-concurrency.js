#!/usr/bin/env node
// Scrapbook v2 - REAL multi-server concurrency check.
//
// Forks several independent Node worker processes. Each one loads the REAL
// scrapbook-store.js with the REAL @supabase/supabase-js client (= one server
// instance with its own in-process lock map and its own HTTP connections)
// and all of them hit the same Supabase / PostgREST + PostgreSQL at the same
// instant (wall-clock barrier). Scenarios:
//   pair       simultaneous pair decisions (+ duplicate decides, + an
//              unrelated 3rd viewer in the same room) -> one co-sitting,
//              one destination, the 3rd viewer never paired
//   saves      duplicate + out-of-order saves of one sitting spread over all
//              workers -> applied exactly once, monotonic totals
//   firstsave  both partners' first saves at once -> ONE memory, ONE session
//   removal    confirm vs decline at the same instant -> exactly one wins
//   expiry     removal-request expiry vs confirm -> exactly one wins
//   purge      purge vs restore at the same instant -> exactly one wins,
//              restored content is never deleted
//   fencing    a worker whose lease expired (renewal stopped) resumes after
//              another worker took the lease -> its write is rejected
// Each scenario runs with DB locks ON and OFF (SCRAPBOOK_DB_LOCKS=0), the
// latter proving the database functions alone keep the invariants.
//
// Optional --db-url=postgres://... adds a direct multi-connection SQL phase
// (node-postgres pool, concurrent calls of the 9.8 functions).
//
// Targets:
//   --local-stack                      SUPABASE_URL must be localhost
//   --confirm-staging=<project-ref>    must match SUPABASE_URL's host
// It WRITES synthetic rows tagged 'spv2conc-<run>'; never run it against
// production. Exit code 0 = every invariant held.
const path = require("path");
const crypto = require("crypto");
const { fork } = require("child_process");

const SRV = path.join(__dirname, "..");
const argv = process.argv.slice(2);
const flag = n => argv.find(a => a === n || a.startsWith(n + "="));
const val = n => { const a = flag(n); return a && a.includes("=") ? a.slice(n.length + 1) : null; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- worker
if (process.env.SPV2_CONC_WORKER === "1") {
  const store = require(path.join(SRV, "scrapbook-store.js"));
  let pause = null;
  const pending = [];
  store.__testHooks.beforeRpc = async (name, params) => {
    if (pause && pause.rpc === name && (!pause.sittingId || (params.p_row && params.p_row.sitting_id === pause.sittingId))) {
      const p = pause; pause = null;
      process.send({ event: "paused", rpc: name });
      await new Promise(r => pending.push(r));
      void p;
    }
  };
  process.on("message", async m => {
    if (m.cmd === "env") { Object.assign(process.env, m.env); return process.send({ id: m.id, ok: true }); }
    if (m.cmd === "pause") { pause = m.pause; store.__testHooks.renew = m.renew !== false; return process.send({ id: m.id, ok: true }); }
    if (m.cmd === "release") { store.__testHooks.renew = true; while (pending.length) pending.shift()(); return process.send({ id: m.id, ok: true }); }
    if (m.cmd === "exit") process.exit(0);
    if (m.cmd === "call") {
      if (m.at) await sleep(Math.max(0, m.at - Date.now()));
      try {
        const v = await store[m.fn](...m.args);
        process.send({ id: m.id, ok: true, v });
      } catch (e) {
        process.send({ id: m.id, ok: false, e: { message: e.message, code: e.code, status: e.status } });
      }
    }
  });
  process.send({ event: "ready" });
  return;
}

// ------------------------------------------------------------ coordinator
async function main() {
  const url = process.env.SUPABASE_URL || "";
  let host = ""; try { host = new URL(url).hostname; } catch {}
  const staging = val("--confirm-staging");
  const local = !!flag("--local-stack");
  if (local && !["127.0.0.1", "localhost", "::1"].includes(host)) { console.error("--local-stack requires SUPABASE_URL on localhost."); process.exit(2); }
  if (!local && !(staging && new URL(url).host.startsWith(staging + "."))) {
    console.error("Refusing to run. Pass --local-stack (localhost) or --confirm-staging=<project-ref> matching SUPABASE_URL of a STAGING project.");
    process.exit(2);
  }
  if (process.env.NODE_ENV === "production") { console.error("Refusing to run with NODE_ENV=production."); process.exit(2); }
  process.env.SCRAPBOOK_SHARED_V2 = "1"; // this process and its workers only
  process.env.SP_DISABLE_SCRAPBOOK_MAINTENANCE = "1";
  const WORKERS = Math.max(2, Number(val("--workers")) || 4);
  const TRIALS = Math.max(1, Number(val("--trials")) || 6);
  const only = (val("--only") || "").split(",").filter(Boolean);
  const run = crypto.randomBytes(3).toString("hex");
  const store = require(path.join(SRV, "scrapbook-store.js"));
  const auth = require(path.join(SRV, "auth-store.js"));
  const sb = require(path.join(SRV, "supabase.js")).getSupabaseAdmin();

  let pass = 0, fail = 0;
  const ok = (name, cond, got) => { if (cond) { pass++; console.log("PASS " + name); } else { fail++; console.log("FAIL " + name + (got === undefined ? "" : " -> " + JSON.stringify(got).slice(0, 700))); } };
  const rows = async (table, where = {}) => {
    let q = sb.from(table).select("*");
    for (const [k, v] of Object.entries(where)) q = q.eq(k, v);
    const { data, error } = await q; if (error) throw error; return data || [];
  };

  // Workers
  const workers = [];
  let msgId = 0;
  const waiting = new Map();
  for (let i = 0; i < WORKERS; i++) {
    const w = fork(__filename, argv, { env: { ...process.env, SPV2_CONC_WORKER: "1", SCRAPBOOK_LOCK_TTL_MS: process.env.SCRAPBOOK_LOCK_TTL_MS || "1500" }, stdio: ["ignore", "inherit", "inherit", "ipc"] });
    w.events = [];
    await new Promise((res, rej) => {
      w.once("error", rej);
      w.on("message", m => {
        if (m.event === "ready") return res();
        if (m.event) { w.events.push(m); return; }
        const cb = waiting.get(m.id); if (cb) { waiting.delete(m.id); cb(m); }
      });
    });
    workers.push(w);
  }
  const send = (w, msg) => new Promise(res => { const id = ++msgId; waiting.set(id, res); w.send({ ...msg, id }); });
  const call = (wi, fn, args, at) => send(workers[wi % WORKERS], { cmd: "call", fn, args, at });
  const allEnv = env => Promise.all(workers.map(w => send(w, { cmd: "env", env })));
  const at = (ms = 150) => Date.now() + ms;
  const waitEvent = async (wi, ev, timeout = 8000) => {
    const w = workers[wi % WORKERS]; const end = Date.now() + timeout;
    while (Date.now() < end) { const i = w.events.findIndex(e => e.event === ev); if (i >= 0) return w.events.splice(i, 1)[0]; await sleep(10); }
    throw new Error(`worker ${wi} never reached ${ev}`);
  };

  // Synthetic users / Stories
  let un = 0;
  const created = { users: [], relations: [] };
  const mkUser = async who => {
    const r = await auth.createEmailUser({ email: `spv2conc-${run}-${who}-${++un}@example.invalid`, password: crypto.randomBytes(12).toString("hex"), name: `spv2conc ${who}` });
    const u = r.user || r; if (!u || !u.id) throw new Error("user create failed " + JSON.stringify(r));
    created.users.push(u.id); return u.id;
  };
  const mkStory = async () => {
    const a = await mkUser("a"), b = await mkUser("b");
    const inv = await store.createInvite(a, b);
    const r = await store.respondInvite((inv.invite || inv).id, b, true);
    created.relations.push(r.relation.id);
    const chapter = (await store.activeChapterForUser(a)).chapter.id;
    return { a, b, chapter };
  };
  const entry = (key, title, extra = {}) => ({ sourceKey: key, title, canonicalTitle: title, contentType: "series", kind: "series", season: 1, episode: 1, episodeTitle: "Concurrency", progress: 0.4, ...extra });
  const sid = t => `spv2conc_${run}_${t}_${crypto.randomBytes(4).toString("hex")}`;
  const want = s => !only.length || only.includes(s);
  const eve = await mkUser("eve");

  console.log(`--- ${WORKERS} worker processes, run ${run}, target ${local ? "local stack" : "staging " + staging} ---`);
  for (const locks of ["1", "0"]) {
    await allEnv({ SCRAPBOOK_DB_LOCKS: locks });
    process.env.SCRAPBOOK_DB_LOCKS = locks;
    const L = locks === "1" ? "locks ON" : "locks OFF";

    if (want("pair")) {
      let conv = 0, oneCo = 0, frozen = 0, eveOk = 0; const bad = [];
      for (let i = 0; i < TRIALS; i++) {
        const p = await mkStory();
        const key = `spv2conc-${run}:pair${locks}${i}`, room = `spv2conc-${run}-${i}`;
        const sa = sid("a"), sbb = sid("b"), se = sid("e");
        await Promise.all([store.recordIntent(p.a, { sittingId: sa, sourceKey: key, roomId: room, playing: true }), store.recordIntent(p.b, { sittingId: sbb, sourceKey: key, roomId: room, playing: true }), store.recordIntent(eve, { sittingId: se, sourceKey: key, roomId: room, playing: true })]);
        const t0 = at();
        const res = await Promise.all([
          call(0, "decideSitting", [p.a, { sittingId: sa, sourceKey: key, roomId: room }], t0),
          call(1, "decideSitting", [p.b, { sittingId: sbb, sourceKey: key, roomId: room }], t0),
          call(2, "decideSitting", [p.a, { sittingId: sa, sourceKey: key, roomId: room }], t0),
          call(3, "decideSitting", [eve, { sittingId: se, sourceKey: key, roomId: room }], t0)
        ]);
        const [da, db, da2, de] = res.map(r => r.ok ? r.v.decision : { err: r.e });
        if (da && db && da.destination === db.destination && (da.destination === "PERSONAL" || (da.coSittingId && da.coSittingId === db.coSittingId))) conv++; else bad.push([da, db]);
        if (da2 && da2.destination === da.destination && da2.decidedAt === da.decidedAt) frozen++;
        if (de && de.destination === "PERSONAL") eveOk++;
        const cos = await rows("co_sittings", { chapter_id: p.chapter, source_key: key });
        const decs = await rows("sitting_decisions", { source_key: key });
        if (cos.length <= 1 && decs.filter(d => d.co_sitting_id).every(d => [p.a, p.b].includes(d.user_id))) oneCo++;
      }
      ok(`[${L}] pair: partners on different servers always converge (${conv}/${TRIALS})`, conv === TRIALS, bad.slice(0, 2));
      ok(`[${L}] pair: never more than one co-sitting, never a non-partner in it (${oneCo}/${TRIALS})`, oneCo === TRIALS);
      ok(`[${L}] pair: a concurrent duplicate decide returns the SAME frozen decision (${frozen}/${TRIALS})`, frozen === TRIALS);
      ok(`[${L}] pair: the unrelated 3rd viewer in the room is always PERSONAL (${eveOk}/${TRIALS})`, eveOk === TRIALS);
    }

    if (want("saves") || want("firstsave")) {
      const p = await mkStory();
      const key = `spv2conc-${run}:saves${locks}`, room = `spv2conc-${run}-s${locks}`, E = entry(key, `SPV2CONC ${run} saves${locks}`);
      const sa = sid("a"), sbb = sid("b");
      await store.recordIntent(p.b, { sittingId: sbb, sourceKey: key, roomId: room, playing: true });
      const d = await store.decideSitting(p.a, { sittingId: sa, sourceKey: key, roomId: room });
      ok(`[${L}] saves setup: co-watch decided SHARED`, d.decision && d.decision.destination === "SHARED", d);
      await sleep(1200); // some real wall time so the sitting interval covers the watch time
      // Both partners' FIRST saves at the same instant on different servers.
      const t0 = at();
      const firsts = await Promise.all([
        call(0, "saveSitting", [p.a, { sittingId: sa, seq: 1, watchSecCum: 1, togetherSecCum: 1, entry: E }], t0),
        call(1, "saveSitting", [p.b, { sittingId: sbb, seq: 1, watchSecCum: 1, togetherSecCum: 1, entry: E }], t0),
        call(2, "saveSitting", [p.a, { sittingId: sa, seq: 1, watchSecCum: 1, togetherSecCum: 1, entry: E }], t0),
        call(3, "saveSitting", [p.b, { sittingId: sbb, seq: 1, watchSecCum: 1, togetherSecCum: 1, entry: E }], t0)
      ]);
      const mems = await rows("shared_memories", { chapter_id: p.chapter, source_key: key });
      ok(`[${L}] firstsave: all concurrent first saves succeeded`, firsts.every(r => r.ok && r.v.ok), firsts.filter(r => !r.ok || !r.v.ok));
      ok(`[${L}] firstsave: exactly ONE shared memory with ONE session`, mems.length === 1 && Number(mems[0].session_count) === 1, mems.map(m => [m.id, m.session_count]));
      const members = mems.length ? await rows("shared_memory_members", { memory_id: mems[0].id }) : [];
      ok(`[${L}] firstsave: one member row per partner, one session each`, members.length === 2 && members.every(m => Number(m.session_count) === 1), members.map(m => [m.user_id, m.session_count]));
      // Duplicate + out-of-order saves of A's sitting spread over all workers.
      const N = 12, calls = [];
      const seqs = Array.from({ length: N }, (_, i) => i + 2).sort(() => Math.random() - 0.5);
      const t1 = at(200);
      seqs.forEach((seq, i) => {
        for (let k = 0; k < 2; k++) calls.push(call(i + k, "saveSitting", [p.a, { sittingId: sa, seq, watchSecCum: seq, togetherSecCum: seq, entry: E }], t1 + (i % 3) * 5));
      });
      const outs = await Promise.all(calls);
      const errs = outs.filter(r => !r.ok);
      const led = (await rows("sitting_ledger", { sitting_id: sa }))[0];
      ok(`[${L}] saves: ${calls.length} concurrent duplicate/out-of-order saves, no errors except retryable 503`, errs.every(r => r.e.status === 503), errs.slice(0, 3));
      const maxSeq = Math.max(...outs.map((r, i) => r.ok && !r.v.duplicate && !r.v.ignored ? seqs[Math.floor(i / 2)] : 0));
      ok(`[${L}] saves: ledger at the highest applied seq with monotonic running totals`, led && Number(led.last_seq) === maxSeq && Number(led.watch_sec_cum) === maxSeq, { led, maxSeq });
      const mm = (await rows("shared_memory_members", { memory_id: mems[0].id })).find(m => m.user_id === p.a);
      ok(`[${L}] saves: member totals equal the ledger's credited amounts exactly (no double apply)`, mm && Number(mm.watch_sec) === Number(led.applied_watch_sec) && Number(mm.session_count) === 1 && Number(led.applied_sessions) === 1, { mm, led });
      const mem = (await rows("shared_memories", { id: mems[0].id }))[0];
      const co = (await rows("co_sittings", { id: d.decision.coSittingId }))[0];
      ok(`[${L}] saves: memory still ONE session; together follows the co-sitting exactly`, Number(mem.session_count) === 1 && Number(mem.together_sec) === Number(co.applied_together_sec), { mem: [mem.session_count, mem.together_sec], co: co.applied_together_sec });
    }

    if (want("removal")) {
      let one = 0, consistent = 0; const bad = [];
      for (let i = 0; i < TRIALS; i++) {
        const p = await mkStory();
        const key = `spv2conc-${run}:rm${locks}${i}`, title = `SPV2CONC ${run} rm${locks}${i}`, room = `r-${run}-${locks}-${i}`;
        const sa = sid("a");
        await store.recordIntent(p.b, { sittingId: sid("b"), sourceKey: key, roomId: room, playing: true });
        await store.decideSitting(p.a, { sittingId: sa, sourceKey: key, roomId: room });
        await store.saveSitting(p.a, { sittingId: sa, seq: 1, watchSecCum: 1, togetherSecCum: 1, entry: entry(key, title) });
        const JK = store.journeyKeyOf({ canonicalTitle: title });
        await store.journeyAction(p.a, { space: "chapter", chapterId: p.chapter, journeyKey: JK, action: "request-removal" });
        const t0 = at();
        const [c, dcl] = await Promise.all([
          call(0, "journeyAction", [p.b, { space: "chapter", chapterId: p.chapter, journeyKey: JK, action: "confirm-removal" }], t0),
          call(1, "journeyAction", [p.b, { space: "chapter", chapterId: p.chapter, journeyKey: JK, action: "decline-removal" }], t0)
        ]);
        const okC = c.ok && c.v.ok, okD = dcl.ok && dcl.v.ok;
        if (okC !== okD) one++; else bad.push([c, dcl]);
        const st = (await rows("journey_state", { space: `c:${p.chapter}` })).filter(r => r.journey_key === JK);
        const s0 = st[0];
        if (st.length === 1 && ((okC && s0.removed_at != null && s0.removal_blocked_until == null) || (okD && s0.removed_at == null && s0.removal_blocked_until != null)) && s0.removal_state === "none") consistent++;
      }
      ok(`[${L}] removal: confirm vs decline at the same instant -> exactly one wins (${one}/${TRIALS})`, one === TRIALS, bad.slice(0, 2));
      ok(`[${L}] removal: final state matches the winner, no mixed state, no extra rows (${consistent}/${TRIALS})`, consistent === TRIALS);
    }

    if (want("expiry")) {
      let one = 0; const bad = [];
      for (let i = 0; i < TRIALS; i++) {
        const p = await mkStory();
        const key = `spv2conc-${run}:ex${locks}${i}`, title = `SPV2CONC ${run} ex${locks}${i}`, room = `e-${run}-${locks}-${i}`;
        const sa = sid("a");
        await store.recordIntent(p.b, { sittingId: sid("b"), sourceKey: key, roomId: room, playing: true });
        await store.decideSitting(p.a, { sittingId: sa, sourceKey: key, roomId: room });
        await store.saveSitting(p.a, { sittingId: sa, seq: 1, watchSecCum: 1, togetherSecCum: 1, entry: entry(key, title) });
        const JK = store.journeyKeyOf({ canonicalTitle: title });
        await store.journeyAction(p.a, { space: "chapter", chapterId: p.chapter, journeyKey: JK, action: "request-removal" });
        // The request expires 1.5 s from now: the confirm (real clock) is still
        // inside the window, maintenance runs with a clock 3 s ahead.
        const st0 = (await rows("journey_state", { space: `c:${p.chapter}` })).find(r => r.journey_key === JK);
        const expireAt = Date.now() + 1500;
        await sb.from("journey_state").update({ removal_requested_at: expireAt - store.V2.REMOVAL_REQUEST_TTL_MS }).eq("id", st0.id);
        const t0 = at();
        const [c, m] = await Promise.all([
          call(0, "journeyAction", [p.b, { space: "chapter", chapterId: p.chapter, journeyKey: JK, action: "confirm-removal" }], t0),
          call(1, "runMaintenance", [expireAt + 1500], t0)
        ]);
        const s1 = (await rows("journey_state", { id: st0.id }))[0];
        const confirmed = c.ok && c.v.ok;
        const good = s1.removal_state === "none" && (confirmed ? (s1.removed_at != null && s1.removal_blocked_until == null) : (s1.removed_at == null && s1.removal_blocked_until != null));
        if (good && m.ok) one++; else bad.push({ c, m, s1 });
      }
      ok(`[${L}] expiry: expiry vs confirm -> exactly one applied, never both (${one}/${TRIALS})`, one === TRIALS, bad.slice(0, 2));
    }

    if (want("purge")) {
      let one = 0; const bad = [];
      for (let i = 0; i < TRIALS; i++) {
        const u = await mkUser("p");
        const key = `spv2conc-${run}:pu${locks}${i}`, title = `SPV2CONC ${run} pu${locks}${i}`;
        const s = sid("p");
        await store.decideSitting(u, { sittingId: s, sourceKey: key, roomId: null });
        await store.saveSitting(u, { sittingId: s, seq: 1, watchSecCum: 1, togetherSecCum: 0, entry: entry(key, title) });
        const JK = store.journeyKeyOf({ canonicalTitle: title });
        await store.journeyAction(u, { space: "personal", journeyKey: JK, action: "remove" });
        const st0 = (await rows("journey_state", { space: `u:${u}` })).find(r => r.journey_key === JK);
        // Restore window ends 1.5 s from now; the restore (real clock) is
        // inside it, maintenance runs with a clock 3 s ahead.
        const end = Date.now() + 1500;
        await sb.from("journey_state").update({ purge_after: end }).eq("id", st0.id);
        const t0 = at();
        const [r, m] = await Promise.all([
          call(0, "journeyAction", [u, { space: "personal", journeyKey: JK, action: "restore" }], t0),
          call(1, "runMaintenance", [end + 1500], t0)
        ]);
        const s1 = (await rows("journey_state", { id: st0.id }))[0];
        const content = await rows("scrapbook_entries", { user_id: u, source_key: key });
        const restored = r.ok && r.v.ok;
        const good = restored ? (s1.removed_at == null && s1.purged_at == null && content.length === 1) : (s1.purged_at != null && content.length === 0);
        if (good) one++; else bad.push({ r, m, s1, content: content.length });
      }
      ok(`[${L}] purge: purge vs restore -> exactly one wins; restored content never deleted (${one}/${TRIALS})`, one === TRIALS, bad.slice(0, 2));
    }

    if (want("fencing") && locks === "1") {
      const p = await mkStory();
      const key = `spv2conc-${run}:fence`, room = `f-${run}`, E = entry(key, `SPV2CONC ${run} fence`);
      const sa = sid("a");
      await store.recordIntent(p.b, { sittingId: sid("b"), sourceKey: key, roomId: room, playing: true });
      await store.decideSitting(p.a, { sittingId: sa, sourceKey: key, roomId: room });
      await sleep(400);
      await store.saveSitting(p.a, { sittingId: sa, seq: 1, watchSecCum: 1, togetherSecCum: 1, entry: E });
      await send(workers[0], { cmd: "pause", pause: { rpc: "sp_scrapbook_save_ledger", sittingId: sa }, renew: false });
      const aRun = call(0, "saveSitting", [p.a, { sittingId: sa, seq: 2, watchSecCum: 2, togetherSecCum: 2, entry: E }]);
      await waitEvent(0, "paused");
      await sleep(Number(process.env.SCRAPBOOK_LOCK_TTL_MS || 1500) + 600); // lease expires on the DB clock
      await send(workers[1], { cmd: "pause", pause: { rpc: "sp_scrapbook_save_ledger", sittingId: sa }, renew: true });
      const bRun = call(1, "saveSitting", [p.a, { sittingId: sa, seq: 3, watchSecCum: 3, togetherSecCum: 3, entry: E }]);
      await waitEvent(1, "paused");
      const mid = (await rows("sitting_ledger", { sitting_id: sa }))[0];
      await send(workers[0], { cmd: "release" });
      const ar = await aRun;
      const afterA = (await rows("sitting_ledger", { sitting_id: sa }))[0];
      ok("fencing: a worker whose lease moved to another server is rejected (SP_FENCED, 503)", !ar.ok && ar.e.code === "SP_FENCED" && ar.e.status === 503, ar);
      ok("fencing: the stale worker wrote nothing", JSON.stringify(mid) === JSON.stringify(afterA) && Number(afterA.last_seq) === 1, afterA);
      await send(workers[1], { cmd: "release" });
      const br = await bRun;
      const fin = (await rows("sitting_ledger", { sitting_id: sa }))[0];
      ok("fencing: the current lease owner commits", br.ok && br.v.ok && Number(fin.last_seq) === 3, { br, fin });
    }
  }

  // ------------------------------------------------ direct SQL, many connections
  const dbUrl = val("--db-url");
  if (dbUrl && want("sql")) {
    let pg; try { pg = require("pg"); } catch { console.log("SKIP sql phase: node-postgres (pg) not installed"); }
    if (pg) await sqlPhase(pg, dbUrl, { ok, run, created, mkStory, store });
  }

  for (const w of workers) w.send({ cmd: "exit" });
  console.log(`\n${pass} passed, ${fail} failed (run ${run}; synthetic users: ${created.users.length}, relations: ${created.relations.length})`);
  if (!local) console.log(`Synthetic rows are tagged 'spv2conc-${run}' / 'spv2conc_${run}_'; remove them from the staging project when done.`);
  process.exit(fail ? 1 : 0);
}

// Concurrent calls of the 9.8 functions over N separate PostgreSQL
// connections (real row locks, real transactions, no Node lock at all).
async function sqlPhase(pg, dbUrl, { ok, run, mkStory, store }) {
  const CONNS = 16;
  const pool = new pg.Pool({ connectionString: dbUrl, max: CONNS });
  const q = (sql, params) => pool.query(sql, params);
  const one = async (sql, params) => (await q(sql, params)).rows[0];
  const settle = p => p.then(v => ({ ok: true, v }), e => ({ ok: false, e }));
  try {
    // 1. lease: 64 concurrent acquires of one free key -> exactly one fence.
    const key = `spv2conc_${run}_lock`;
    const acq = await Promise.all(Array.from({ length: 64 }, (_, i) => one("select public.sp_scrapbook_lock_acquire($1, $2, 60000) as f", [key, "h" + i])));
    const got = acq.filter(r => r.f != null);
    ok(`sql: 64 concurrent lease acquires on ${CONNS} connections -> exactly one owner`, got.length === 1, acq.map(r => r.f));
    // take-over after expiry: 32 concurrent -> exactly one new, larger fence
    await q("update public.scrapbook_locks set until_at = 0 where key = $1", [key]);
    const acq2 = await Promise.all(Array.from({ length: 32 }, (_, i) => one("select public.sp_scrapbook_lock_acquire($1, $2, 60000) as f", [key, "t" + i])));
    const got2 = acq2.filter(r => r.f != null);
    ok("sql: 32 concurrent take-overs of an expired lease -> exactly one, with a larger fence", got2.length === 1 && Number(got2[0].f) > Number(got[0].f), acq2.map(r => r.f));
    const stale = await settle(q("select public.sp_scrapbook_check_fences($1::jsonb)", [JSON.stringify([{ k: key, f: Number(got[0].f) }])]));
    ok("sql: the previous owner's fence is rejected (SPF01)", !stale.ok && stale.e.code === "SPF01", stale.ok ? stale.v.rows : stale.e.code);
    await q("delete from public.scrapbook_locks where key = $1", [key]);

    // 2. pair vs PERSONAL decision races over separate connections.
    let pairOk = 0; const T = 10;
    for (let i = 0; i < T; i++) {
      const p = await mkStory();
      const sk = `spv2conc-${run}:sql${i}`, sa = `spv2conc_${run}_sa${i}`, sbb = `spv2conc_${run}_sb${i}`, t = Date.now();
      await q("insert into public.sitting_intents (sitting_id, user_id, source_key, room_id, playing, first_seen_at, last_seen_at) values ($1,$2,$3,'R',true,$4,$4), ($5,$6,$3,'R',true,$4,$4)", [sa, p.a, sk, t, sbb, p.b]);
      const co = { id: `cos_${run}_${i}`, chapter_id: p.chapter, source_key: sk, opened_at: t, last_active_at: t };
      const base = { source_key: sk, destination: "SHARED", reason: "co_watch", chapter_id: p.chapter, co_sitting_id: co.id, decided_at: t, last_active_at: t };
      const calls = [];
      for (let k = 0; k < 4; k++) {
        calls.push(settle(one("select public.sp_scrapbook_decide_pair($1::jsonb, $2::jsonb, $3::jsonb, null) as r", [JSON.stringify(co), JSON.stringify({ ...base, sitting_id: sbb, user_id: p.b }), JSON.stringify({ ...base, sitting_id: sa, user_id: p.a })])));
        calls.push(settle(one("select public.sp_scrapbook_write_decision($1::jsonb, null) as r", [JSON.stringify({ sitting_id: k % 2 ? sa : sbb, user_id: k % 2 ? p.a : p.b, source_key: sk, destination: "PERSONAL", reason: "alone", decided_at: t, last_active_at: t })])));
      }
      const res = await Promise.all(calls);
      const decs = (await q("select * from public.sitting_decisions where sitting_id in ($1, $2)", [sa, sbb])).rows;
      const applied = res.filter(r => r.ok && r.v.r && r.v.r.applied === true).length;
      const allShared = decs.length === 2 && decs.every(d => d.destination === "SHARED" && d.co_sitting_id === co.id);
      const noShared = decs.every(d => d.destination === "PERSONAL");
      if (res.every(r => r.ok) && decs.length === 2 && ((applied === 1 && allShared) || (applied === 0 && noShared))) pairOk++;
    }
    ok(`sql: pair vs PERSONAL decisions on ${CONNS} connections -> all-or-nothing, never a half pair (${pairOk}/${T})`, pairOk === T);

    // 3. ledger: 48 concurrent saves (duplicates, out of order) + applies.
    const p = await mkStory();
    const sk = `spv2conc-${run}:sqlled`, s1 = `spv2conc_${run}_led`, t = Date.now() - 120000;
    await q("insert into public.sitting_intents (sitting_id, user_id, source_key, room_id, playing, first_seen_at, last_seen_at) values ($1,$2,$3,null,true,$4,$4)", [s1, p.a, sk, t]);
    await one("select public.sp_scrapbook_write_decision($1::jsonb, null) as r", [JSON.stringify({ sitting_id: s1, user_id: p.a, source_key: sk, destination: "PERSONAL", reason: "alone", decided_at: t, last_active_at: t })]);
    const eid = `spv2conc_${run}_entry`;
    await q("insert into public.scrapbook_entries (id, user_id, scope, source_key, title, kind, watch_duration_sec, together_duration_sec, session_count, created_at, updated_at, first_watched_at, last_watched_at) values ($1,$2,'personal',$3,'SQL','series',0,0,0,$4,$4,$4,$4)", [eid, p.a, sk, t]).catch(async () => {
      await q("insert into public.scrapbook_entries (id, user_id, scope, source_key, title, kind, created_at, updated_at) values ($1,$2,'personal',$3,'SQL','series',$4,$4)", [eid, p.a, sk, t]);
    });
    const seqs = Array.from({ length: 24 }, (_, i) => i + 1);
    const saves = await Promise.all([...seqs, ...seqs].sort(() => Math.random() - 0.5).map(seq => one("select public.sp_scrapbook_save_ledger($1::jsonb, $2, $3, 21600000, null) as r",
      [JSON.stringify({ sitting_id: s1, user_id: p.a, target_id: eid, watch_cum: seq * 10, together_cum: 0, journey_key: "sql", generation: 1 }), seq, Date.now()])));
    const led = await one("select * from public.sitting_ledger where sitting_id = $1", [s1]);
    const inserted = saves.filter(r => r.r.status === "inserted").length;
    ok("sql: 48 concurrent duplicate/out-of-order saves -> one insert, ledger at max seq with max totals", inserted === 1 && Number(led.last_seq) === 24 && Number(led.watch_sec_cum) === 240, { inserted, led });
    const cas = await Promise.all(Array.from({ length: 20 }, () => one("select public.sp_scrapbook_apply_ledger($1, $2::jsonb, $3::jsonb, 'scrapbook_entries', $4, $5, null) as r", [s1, JSON.stringify({ w: 0, t: 0, s: 0 }), JSON.stringify({ w: 240, t: 0, s: 1 }), eid, Date.now()])));
    const row = await one("select watch_duration_sec, session_count from public.scrapbook_entries where id = $1", [eid]);
    ok("sql: 20 concurrent identical applies -> exactly one CAS wins, totals added once", cas.filter(r => r.r === true).length === 1 && Number(row.watch_duration_sec) === 240 && Number(row.session_count) === 1, { wins: cas.filter(r => r.r === true).length, row });

    // 4. purge vs restore over separate connections.
    let pr = 0; const T2 = 10;
    for (let i = 0; i < T2; i++) {
      const sid2 = `spv2conc_${run}_js${i}`, tt = Date.now();
      await q("insert into public.journey_state (id, space, journey_key, generation, removed_at, removed_by, purge_after, removal_state, updated_at) values ($1, $2, 'sqlpurge', $3, $4, 'x', $4, 'none', $4)", [sid2, `u:${p.a}`, 100 + i, tt]);
      const st = await one("select * from public.journey_state where id = $1", [sid2]);
      const expect = {}; for (const c of ["removed_at", "purged_at", "updated_at"]) expect[c] = st[c] == null ? null : Number(st[c]);
      const [a, b] = await Promise.all([
        settle(one("select public.sp_scrapbook_purge_journey($1, $2, '[]'::jsonb, null) as r", [sid2, tt + 1])),
        settle(one("select public.sp_scrapbook_journey_update($1, $2::jsonb, $3::jsonb, false, null) as r", [sid2, JSON.stringify(expect), JSON.stringify({ removed_at: null, removed_by: null, purge_after: null, updated_at: tt + 1 })]))
      ]);
      const fin = await one("select * from public.journey_state where id = $1", [sid2]);
      const purged = a.ok && a.v.r && a.v.r.purged === true, restored = b.ok && b.v.r != null;
      if (purged !== restored && (purged ? fin.purged_at != null && fin.removed_at != null : fin.removed_at == null && fin.purged_at == null)) pr++;
      await q("delete from public.journey_state where id = $1", [sid2]);
      await q("delete from public.memory_tombstones where id = $1", ["tomb_" + sid2]);
    }
    ok(`sql: purge vs restore on separate connections -> exactly one wins (${pr}/${T2})`, pr === T2);
    void store;
  } finally { await pool.end(); }
}

main().catch(e => { console.error("concurrency run aborted:", e && e.stack || e); process.exit(1); });
