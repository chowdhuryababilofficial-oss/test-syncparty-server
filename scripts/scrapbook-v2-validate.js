#!/usr/bin/env node
// Scrapbook v2 - application-level validation of the ended-chapter rules
// against a REAL Supabase/Postgres, through the real scrapbook-store.js:
//   * an ended chapter cannot be modified / reopened / deleted (DB trigger)
//   * an in-progress sitting decided BEFORE the end may still save within
//     the 6-hour grace, into the same chapter
//   * saves after the 6-hour grace are ignored (totals unchanged)
//   * a restart creates a NEW chapter; the old one stays readable/read-only
//
// It WRITES synthetic rows (users 'spv2val-<run>-*@example.invalid', one
// relation, chapters, memories). Run it ONLY against a staging project or a
// Supabase branch - never production. For production use the rollback-only
// scripts/scrapbook-v2-validate.sql instead.
//
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//   node scripts/scrapbook-v2-validate.js --confirm-staging=<project-ref>
//
// <project-ref> must match the host of SUPABASE_URL. Rows it creates are
// deleted afterwards except the closed chapter rows (the trigger forbids
// deleting them, by design); the exact cleanup SQL is printed.
const crypto = require("crypto");

async function runChecks(store, auth, sb, { tag = crypto.randomBytes(4).toString("hex"), log = console.log } = {}) {
  const results = [];
  const created = { users: [], relations: [], chapters: [] };
  const check = (name, pass, detail) => { results.push({ name, pass: !!pass, detail }); log(`${pass ? "PASS" : "FAIL"} ${name}${pass || detail === undefined ? "" : " -> " + JSON.stringify(detail).slice(0, 400)}`); };
  const realNow = Date.now; let skew = 0; Date.now = () => realNow() + skew;
  try {
    const mk = async who => {
      const r = await auth.createEmailUser({ email: `spv2val-${tag}-${who}@example.invalid`, password: crypto.randomBytes(12).toString("hex"), name: `spv2val ${who}` });
      const u = r.user || r; if (!u || !u.id) throw new Error("could not create validation user: " + JSON.stringify(r));
      created.users.push(u.id); return u;
    };
    const a = await mk("a"), b = await mk("b");
    const inv = await store.createInvite(a.id, b.id);
    const acc = await store.respondInvite((inv.invite || inv).id, b.id, true);
    const relationId = acc.relation.id; created.relations.push(relationId);
    const ctx = await store.activeChapterForUser(a.id);
    const ch1 = ctx.chapter.id; created.chapters.push(ch1);
    check("story start opens a chapter", !!ch1 && ctx.chapter.ended_at == null);

    const key = `spv2val-${tag}:s1e1`, entry = { sourceKey: key, title: `SPV2VAL ${tag}`, canonicalTitle: `SPV2VAL ${tag}`, contentType: "series", kind: "series", season: 1, episode: 1, episodeTitle: "Validation", progress: 0.3 };
    const sa = `spv2val_${tag}_a`, sbid = `spv2val_${tag}_b`;
    await store.recordIntent(b.id, { sittingId: sbid, sourceKey: key, roomId: `spv2val-${tag}`, playing: true });
    const d = await store.decideSitting(a.id, { sittingId: sa, sourceKey: key, roomId: `spv2val-${tag}` });
    check("co-watch decided SHARED in chapter 1", d.decision && d.decision.destination === "SHARED" && d.decision.chapterId === ch1, d);
    const s1 = await store.saveSitting(a.id, { sittingId: sa, seq: 1, watchSecCum: 600, togetherSecCum: 500, entry });
    const memId = s1.target && s1.target.id;
    check("save before the end lands in the chapter's shared memory", s1.ok && !s1.ignored && !!memId, s1);

    await store.closeRelation(relationId, a.id, "end");
    const { data: ch1Row } = await sb.from("story_chapters").select("*").eq("id", ch1).maybeSingle();
    check("ending the story closes chapter 1", ch1Row && ch1Row.ended_at != null, ch1Row);

    const reopen = await sb.from("story_chapters").update({ ended_at: null }).eq("id", ch1);
    check("DB refuses to reopen an ended chapter", !!reopen.error, reopen.error);
    const modify = await sb.from("story_chapters").update({ end_mode: "archive" }).eq("id", ch1);
    check("DB refuses to modify an ended chapter", !!modify.error, modify.error);
    const del = await sb.from("story_chapters").delete().eq("id", ch1);
    check("DB refuses to delete an ended chapter", !!del.error, del.error);

    const memberOf = async () => (await sb.from("shared_memory_members").select("*").eq("memory_id", memId).eq("user_id", a.id).maybeSingle()).data;
    const before = await memberOf();
    skew = 60 * 60 * 1000; // +1 h: inside the 6 h grace
    const s2 = await store.saveSitting(a.id, { sittingId: sa, seq: 2, watchSecCum: 900, togetherSecCum: 700, entry });
    const mid = await memberOf();
    check("in-progress post-end save within 6 h is applied to the SAME chapter", s2.ok && !s2.ignored && s2.target && s2.target.id === memId && Number(mid.watch_sec) > Number(before.watch_sec), { s2, before: before && before.watch_sec, after: mid && mid.watch_sec });

    skew = 6 * 60 * 60 * 1000 + 60 * 1000; // 6 h 1 min after the end
    const s3 = await store.saveSitting(a.id, { sittingId: sa, seq: 3, watchSecCum: 1500, togetherSecCum: 1200, entry });
    const late = await memberOf();
    check("save after the 6 h limit is ignored (chapter_closed)", s3.ok && s3.ignored === "chapter_closed", s3);
    check("totals unchanged by the late save", Number(late.watch_sec) === Number(mid.watch_sec), [mid.watch_sec, late.watch_sec]);
    skew = 0;

    const inv2 = await store.createInvite(a.id, b.id);
    await store.respondInvite((inv2.invite || inv2).id, b.id, true);
    const ctx2 = await store.activeChapterForUser(a.id);
    created.chapters.push(ctx2.chapter.id);
    const { data: ch1After } = await sb.from("story_chapters").select("*").eq("id", ch1).maybeSingle();
    check("restart creates a NEW chapter id", ctx2.chapter.id !== ch1 && ctx2.chapter.ended_at == null, ctx2.chapter.id);
    check("old chapter row unchanged by the restart", JSON.stringify(ch1After) === JSON.stringify(ch1Row), [ch1Row, ch1After]);
    const old = await store.listSharedV2(a.id, { chapterId: ch1 });
    check("old chapter still readable, read-only", old.chapter && old.chapter.readOnly === true && old.entries.some(e => e.sourceKey === key && e.readOnly), old.chapter);
    const rename = await store.journeyAction(a.id, { space: "chapter", chapterId: ch1, journeyKey: store.journeyKeyOf(entry), action: "rename", displayTitle: "x" });
    check("old chapter refuses edits (rename -> 409)", rename.status === 409 && rename.readOnly, rename);
    const fresh = await store.listSharedV2(a.id, { chapterId: ctx2.chapter.id });
    check("new chapter does not inherit the old chapter's memory", !fresh.entries.some(e => e.sourceKey === key), fresh.entries.length);

    // Removal in the new chapter: tombstoned content cannot be resurrected and
    // answering an already-removed journey creates no empty state row.
    const ch2 = ctx2.chapter.id;
    const key2 = `spv2val-${tag}:s1e2`, entry2 = { ...entry, sourceKey: key2, episode: 2 };
    const sc = `spv2val_${tag}_c`, sd = `spv2val_${tag}_d`;
    await store.recordIntent(b.id, { sittingId: sd, sourceKey: key2, roomId: `spv2val-${tag}-2`, playing: true });
    const d2 = await store.decideSitting(a.id, { sittingId: sc, sourceKey: key2, roomId: `spv2val-${tag}-2` });
    const s4 = await store.saveSitting(a.id, { sittingId: sc, seq: 1, watchSecCum: 300, togetherSecCum: 300, entry: entry2 });
    check("co-watch in the new chapter saves SHARED", d2.decision && d2.decision.destination === "SHARED" && s4.ok && !s4.ignored, { d2, s4 });
    const JK = store.journeyKeyOf(entry2);
    const rq = await store.journeyAction(a.id, { space: "chapter", chapterId: ch2, journeyKey: JK, action: "request-removal" });
    const cf = await store.journeyAction(b.id, { space: "chapter", chapterId: ch2, journeyKey: JK, action: "confirm-removal" });
    check("removal request + partner confirm removes the journey", rq.ok && cf.ok && cf.state && cf.state.removedAt != null, { rq, cf });
    const late2 = await store.saveSitting(a.id, { sittingId: sc, seq: 2, watchSecCum: 900, togetherSecCum: 900, entry: entry2 });
    check("a later save of the removed sitting is ignored (no resurrection)", late2.ok && late2.ignored === "removed", late2);
    const statesBefore = ((await sb.from("journey_state").select("*").eq("space", `c:${ch2}`)).data || []).length;
    const dec = await store.journeyAction(b.id, { space: "chapter", chapterId: ch2, journeyKey: JK, action: "decline-removal" });
    const statesAfter = ((await sb.from("journey_state").select("*").eq("space", `c:${ch2}`)).data || []).length;
    check("declining on the already-removed journey is refused and creates no state row", dec.status === 409 && statesAfter === statesBefore, { dec, statesBefore, statesAfter });
    const { data: memRows } = await sb.from("shared_memories").select("*").eq("chapter_id", ch2).eq("source_key", key2);
    const direct = await sb.from("shared_memory_members").insert({ id: `spv2val_${tag}_mm`, memory_id: memRows[0].id, user_id: b.id, updated_at: Date.now() });
    check("DB refuses a direct insert into the removed generation (SPR01)", direct.error && direct.error.code === "SPR01", direct.error);
  } finally {
    Date.now = realNow;
  }
  return { results, created, tag };
}

async function cleanup(sb, created) {
  const ids = created.users;
  const del = async (t, col, vals) => { if (vals.length) await sb.from(t).delete().in(col, vals); };
  const mems = created.chapters.length ? ((await sb.from("shared_memories").select("id").in("chapter_id", created.chapters)).data || []).map(m => m.id) : [];
  await del("shared_memory_members", "memory_id", mems);
  await del("sitting_ledger", "user_id", ids);
  await del("sitting_decisions", "user_id", ids);
  await del("sitting_intents", "user_id", ids);
  await del("co_sittings", "chapter_id", created.chapters);
  await del("shared_memories", "id", mems);
  for (const c of created.chapters) {
    await sb.from("journey_state").delete().eq("space", `c:${c}`);
    await sb.from("journey_member_prefs").delete().eq("space", `c:${c}`);
    await sb.from("memory_events").delete().eq("space", `c:${c}`);
  }
  await sb.from("story_chapters").delete().in("id", created.chapters).is("ended_at", null);
  return [
    "-- Remaining validation rows (closed chapters are protected by the trigger).",
    "-- Run in the SQL editor of the SAME staging project to remove them:",
    "begin;",
    "alter table public.story_chapters disable trigger story_chapters_immutable_trg;",
    `delete from public.story_chapters where id in (${created.chapters.map(c => `'${c}'`).join(", ")});`,
    "alter table public.story_chapters enable trigger story_chapters_immutable_trg;",
    `delete from public.invites where from_user_id in (${ids.map(i => `'${i}'`).join(", ")}) or to_user_id in (${ids.map(i => `'${i}'`).join(", ")});`,
    `delete from public.relations where id in (${created.relations.map(i => `'${i}'`).join(", ")});`,
    `delete from public.users where id in (${ids.map(i => `'${i}'`).join(", ")});`,
    "commit;"
  ].join("\n");
}

module.exports = { runChecks, cleanup };

if (require.main === module) {
  (async () => {
    const arg = (process.argv.find(a => a.startsWith("--confirm-staging=")) || "").split("=")[1] || "";
    const url = process.env.SUPABASE_URL || "";
    let host = "", hostname = ""; try { host = new URL(url).host; hostname = new URL(url).hostname; } catch {}
    // --local-stack: a local PostgreSQL + PostgREST (tests/pg-local-stack.js) on localhost only.
    const localStack = process.argv.includes("--local-stack") && ["127.0.0.1", "localhost", "::1"].includes(hostname);
    if (!localStack && (!arg || !host.startsWith(arg + "."))) {
      console.error("Refusing to run. This script writes synthetic rows. Pass --confirm-staging=<project-ref> matching SUPABASE_URL of a STAGING project or branch (or --local-stack for a localhost PostgREST).\nFor production use scripts/scrapbook-v2-validate.sql (rollback-only).");
      process.exit(2);
    }
    if (process.env.NODE_ENV === "production") { console.error("Refusing to run with NODE_ENV=production."); process.exit(2); }
    const path = require("path");
    const store = require(path.join(__dirname, "..", "scrapbook-store.js"));
    const auth = require(path.join(__dirname, "..", "auth-store.js"));
    const sb = require(path.join(__dirname, "..", "supabase.js")).getSupabaseAdmin();
    let out;
    try { out = await runChecks(store, auth, sb); }
    catch (e) { console.error("Validation aborted:", e && e.message || e); process.exit(1); }
    const sql = await cleanup(sb, out.created).catch(e => `-- cleanup failed: ${e.message}`);
    const failed = out.results.filter(r => !r.pass).length;
    console.log(`\n${out.results.length - failed} passed, ${failed} failed (run ${out.tag})\n\n${sql}`);
    process.exit(failed ? 1 : 0);
  })();
}
