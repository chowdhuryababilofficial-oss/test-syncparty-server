// In-memory stand-in for @supabase/supabase-js, good enough for the exact
// query shapes auth-store.js and scrapbook-store.js use. Injected into
// require.cache in place of the server's supabase.js so the REAL server code
// runs end-to-end in tests without any network or database.
const tables = {
  users: [],
  sessions: [],
  relations: [],
  invites: [],
  scrapbook_entries: [],
  scrapbook_highlights: []
};

const UNIQUE = {
  users: [['email', 'provider']],
  relations: [['user1_id', 'user2_id']],
  scrapbook_entries: [['user_id', 'scope', 'source_key']],
  scrapbook_highlights: [['user_id', 'request_id']],
  // Scrapbook v2 keys, mirroring supabase-schema.sql section 9.
  story_chapters: [['id'], ['relation_id', 'chapter_no']],
  shared_memories: [['id'], ['chapter_id', 'source_key', 'journey_version']],
  shared_memory_members: [['id'], ['memory_id', 'user_id']],
  journey_state: [['id'], ['space', 'journey_key', 'generation']],
  journey_member_prefs: [['id'], ['space', 'journey_key', 'user_id']],
  sitting_intents: [['sitting_id']],
  co_sittings: [['id']],
  sitting_decisions: [['sitting_id']],
  sitting_ledger: [['sitting_id']],
  moment_seen: [['user_id', 'moment_id']],
  notification_reads: [['user_id', 'notif_id']],
  maintenance_lease: [['name']],
  scrapbook_locks: [['key']]
};

// Test knobs. latency(): per-statement delay in ms so concurrent requests
// interleave at statement boundaries like separate server instances hitting
// one Postgres. rpcEnabled=false simulates a database without the 9.7
// functions (the store must then fall back to its locked path).
const knobs = { latency: null, rpcEnabled: true };
function delay() {
  const ms = knobs.latency ? Math.max(0, Number(knobs.latency()) || 0) : 0;
  return ms ? new Promise(r => setTimeout(r, ms)) : Promise.resolve();
}
// Partial unique index: one OPEN chapter per relation.
function violatesPartial(table, row) {
  if (table !== 'story_chapters' || row.ended_at != null) return false;
  return (tables.story_chapters || []).some(c => c.relation_id === row.relation_id && c.ended_at == null);
}

function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }

function matchesUnique(table, a, b) {
  return (UNIQUE[table] || []).some(cols => cols.every(c => a[c] != null && String(a[c]) === String(b[c])));
}

// PostgREST JSONB equality accepts a JSON-encoded filter, ignores object key
// order, and preserves array order. String(object) silently broke JSON CAS.
function equalValue(actual, expected) {
  if(actual !== null && typeof actual === 'object') {
    if(typeof expected === 'string') {try{expected=JSON.parse(expected);}catch{return false;}}
    const canonical=v=>Array.isArray(v)?v.map(canonical):v && typeof v==='object'?
      Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
    return JSON.stringify(canonical(actual))===JSON.stringify(canonical(expected));
  }
  return String(actual ?? '')===String(expected);
}

class Query {
  constructor(table) {
    this.table = table;
    this.filters = [];
    this.op = 'select';
    this.payload = null;
    this.orderBy = null;
    this.ascending = true;
    this._limit = null;
  }
  select() { if (this.op === 'select') this.op = 'select'; return this; }
  eq(col, val) { this.filters.push(r => equalValue(r[col],val)); return this; }
  neq(col, val) { this.filters.push(r => !equalValue(r[col],val)); return this; }
  gt(col, val) { this.filters.push(r => String(r[col] ?? '') > String(val)); return this; }
  lt(col, val) { this.filters.push(r => r[col] != null && Number(r[col]) < Number(val)); return this; }
  lte(col, val) { this.filters.push(r => r[col] != null && Number(r[col]) <= Number(val)); return this; }
  gte(col, val) { this.filters.push(r => r[col] != null && Number(r[col]) >= Number(val)); return this; }
  is(col, val) { this.filters.push(r => (val === null ? r[col] == null : r[col] === val)); return this; }
  like(col, pattern) {
    const re = new RegExp('^' + String(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*') + '$');
    this.filters.push(r => re.test(String(r[col] ?? '')));
    return this;
  }
  in(col, values) { const set = new Set((values || []).map(String)); this.filters.push(r => set.has(String(r[col] ?? ''))); return this; }
  or(expr) {
    const parts = String(expr).split(',').map(p => p.trim()).filter(Boolean).map(p => {
      const [col, op, ...rest] = p.split('.');
      return { col, op, val: rest.join('.') };
    });
    this.filters.push(r => parts.some(p => (p.op === 'eq' ? String(r[p.col] ?? '') === String(p.val) : p.op === 'is' ? (p.val === 'null' ? r[p.col] == null : r[p.col] === p.val) : false)));
    return this;
  }
  order(col, opts) { this.orderBy = col; this.ascending = !opts || opts.ascending !== false; return this; }
  limit(n) { this._limit = n; return this; }
  insert(payload) { this.op = 'insert'; this.payload = payload; return this; }
  update(payload) { this.op = 'update'; this.payload = payload; return this; }
  delete() { this.op = 'delete'; return this; }

  rows() {
    let rows = tables[this.table] || [];
    for (const f of this.filters) rows = rows.filter(f);
    if (this.orderBy) {
      const col = this.orderBy, asc = this.ascending;
      rows = [...rows].sort((a, b) => {
        const x = a[col] ?? '', y = b[col] ?? '';
        if (x === y) return 0;
        return (x > y ? 1 : -1) * (asc ? 1 : -1);
      });
    }
    if (this._limit != null) rows = rows.slice(0, this._limit);
    return rows;
  }

  run() {
    if (!tables[this.table]) tables[this.table] = [];
    if (this.op === 'insert') {
      const incoming = Array.isArray(this.payload) ? this.payload : [this.payload];
      const inserted = [];
      for (const row of incoming) {
        const noResurrect = this.table === 'shared_memories' ? removedGen(row.chapter_id, row.journey_key, row.journey_version)
          : this.table === 'shared_memory_members' ? (m => !!m && removedGen(m.chapter_id, m.journey_key, m.journey_version))(T('shared_memories').find(x => x.id === row.memory_id)) : false;
        if (noResurrect) return { data: null, error: { code: 'SPR01', message: 'SP_REMOVED' } };
        if (violatesPartial(this.table, row) || (tables[this.table] || []).some(existing => matchesUnique(this.table, row, existing))) {
          return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
        }
        const stored = clone(row);
        tables[this.table].push(stored);
        inserted.push(stored);
      }
      return { data: clone(inserted.length === 1 ? inserted[0] : inserted), error: null };
    }
    if (this.op === 'update') {
      const rows = this.rows();
      if (this.table === 'journey_state') {
        try { for (const row of rows) guardState(row, { ...row, ...this.payload }); }
        catch (e) { return { data: null, error: { code: e.code, message: e.message } }; }
      }
      for (const row of rows) Object.assign(row, clone(this.payload));
      return { data: clone(rows.length === 1 ? rows[0] : rows), error: null };
    }
    if (this.op === 'delete') {
      const rows = new Set(this.rows());
      tables[this.table] = tables[this.table].filter(r => !rows.has(r));
      return { data: null, error: null };
    }
    return { data: clone(this.rows()), error: null };
  }

  maybeSingle() {
    return delay().then(() => {
      const res = this.run();
      if (res.error) return res;
      const data = Array.isArray(res.data) ? (res.data[0] ?? null) : (res.data ?? null);
      return { data, error: null };
    });
  }
  single() { return this.maybeSingle(); }
  then(onOk, onErr) {
    return delay().then(() => {
      const res = this.run();
      const out = { data: Array.isArray(res.data) ? res.data : res.data == null ? [] : [res.data], error: res.error };
      if (this.op === 'select') out.data = Array.isArray(res.data) ? res.data : (res.data ? [res.data] : []);
      return out;
    }).then(onOk, onErr);
  }
}

// JS mirrors of the supabase-schema.sql 9.7 / 9.8 functions. Each runs as
// one synchronous step, i.e. atomically, exactly like a single SQL
// transaction, and applies the same validations / error codes.
const E = (code, message) => ({ data: null, error: { code, message } });
class RpcError extends Error { constructor(code, message) { super(message); this.code = code; } }
const T = name => tables[name] || (tables[name] = []);
let fenceSeq = 0;
function checkFences(fences) {
  if (!Array.isArray(fences)) return;
  for (const f of fences) {
    if (!T('scrapbook_locks').some(l => l.key === f.k && Number(l.fence) === Number(f.f))) throw new RpcError('SPF01', `SP_FENCED: lock ${f.k} is no longer held with fence ${f.f}`);
  }
}
function storyUsers(chapterId, requireOpen) {
  const c = T('story_chapters').find(x => x.id === chapterId);
  if (!c) throw new RpcError('SPV01', 'SP_INVALID: chapter not found');
  const r = T('relations').find(x => x.id === c.relation_id);
  if (!r) throw new RpcError('SPV01', 'SP_INVALID: relation not found');
  if (requireOpen && (c.ended_at != null || !r.accepted_at || r.archived_at != null || r.ended_at != null)) throw new RpcError('SPC01', 'SP_CHAPTER_CLOSED');
  return [String(r.user1_id), String(r.user2_id)];
}
function bump(p_table, p_id, w, tg, se, at) {
  const cols = { shared_memory_members: ['watch_sec', 'together_sec', 'session_count'], shared_memories: [null, 'together_sec', 'session_count'], scrapbook_entries: ['watch_duration_sec', 'together_duration_sec', 'session_count'] }[p_table];
  if (!cols) throw new RpcError('22023', 'unsupported table');
  const row = T(p_table).find(r => String(r.id) === String(p_id));
  if (!row) return false;
  [w, tg, se].forEach((v, i) => { if (cols[i]) row[cols[i]] = Math.max(0, Number(row[cols[i]] || 0) + Number(v || 0)); });
  row.updated_at = at;
  if (p_table !== 'scrapbook_entries') row.last_watched_at = Math.max(Number(row.last_watched_at || 0), Number(at));
  return true;
}
function removedGen(chapterId, jk, gen) {
  return T('journey_state').some(s => s.space === 'c:' + chapterId && s.journey_key === jk && Number(s.generation) === Number(gen) && s.removed_at != null);
}
const STATE_MUTABLE = ['display_title', 'title_edited_by', 'title_edited_at', 'archived_at', 'removed_at', 'removed_by', 'purge_after', 'removal_state', 'removal_requested_by', 'removal_requested_at', 'removal_blocked_until', 'updated_at'];
function guardState(old, next) {
  if (old.purged_at != null && (next.purged_at == null || next.removed_at == null)) throw new RpcError('SPR01', 'SP_PURGED');
  if (old.removed_at != null && next.removed_at == null && T('journey_state').some(s => s.space === old.space && s.journey_key === old.journey_key && Number(s.generation) > Number(old.generation))) throw new RpcError('SPR01', 'SP_REMOVED: newer generation');
}
const same = (a, b) => (a == null && b == null) || (a != null && b != null && (typeof a === 'number' || typeof b === 'number' ? Number(a) === Number(b) : String(a) === String(b)));
const RPC = {
  sp_account_notifications_read: ({ p_user_id, p_ids }) => {
    if (!T('users').some(u => u.id === p_user_id)) throw new RpcError('23503', 'Account not found');
    const at = Date.now(); let added = 0;
    for (const id of [...new Set(p_ids.filter(x => typeof x === 'string').map(x => x.trim()))].sort().slice(0, 100)) {
      if (!id || id.length > 200 || T('notification_reads').some(r => r.user_id === p_user_id && r.notif_id === id)) continue;
      T('notification_reads').push({ user_id: p_user_id, notif_id: id, read_at: at }); added++;
    }
    const own = T('notification_reads').filter(r => r.user_id === p_user_id)
      .sort((a,b) => b.read_at - a.read_at || a.notif_id.localeCompare(b.notif_id));
    const keep = new Set(own.slice(0,400));
    tables.notification_reads = T('notification_reads').filter(r => r.user_id !== p_user_id || keep.has(r));
    return { added };
  },
  sp_scrapbook_bump_totals({ p_table, p_id, p_watch = 0, p_together = 0, p_sessions = 0, p_at }) {
    return bump(p_table, p_id, p_watch, p_together, p_sessions, p_at);
  },
  sp_scrapbook_lock_acquire({ p_key, p_holder, p_ttl_ms }) {
    const t = Date.now(), locks = T('scrapbook_locks');
    const cur = locks.find(l => l.key === p_key);
    if (cur && Number(cur.until_at) >= t) return null;
    const fence = ++fenceSeq;
    if (cur) Object.assign(cur, { holder: p_holder, until_at: t + Number(p_ttl_ms), fence });
    else locks.push({ key: p_key, holder: p_holder, until_at: t + Number(p_ttl_ms), fence });
    return fence;
  },
  sp_scrapbook_lock_renew({ p_key, p_holder, p_fence, p_ttl_ms }) {
    const cur = T('scrapbook_locks').find(l => l.key === p_key && l.holder === p_holder && Number(l.fence) === Number(p_fence));
    if (!cur) return false;
    cur.until_at = Date.now() + Number(p_ttl_ms);
    return true;
  },
  sp_scrapbook_lock_release({ p_key, p_holder, p_fence }) {
    const before = T('scrapbook_locks').length;
    tables.scrapbook_locks = T('scrapbook_locks').filter(l => !(l.key === p_key && l.holder === p_holder && Number(l.fence) === Number(p_fence)));
    return tables.scrapbook_locks.length !== before;
  },
  sp_scrapbook_write_decision({ p_row, p_fences }) {
    checkFences(p_fences);
    const r = p_row || {};
    if (!['PERSONAL', 'SHARED'].includes(r.destination) || !r.sitting_id || !r.user_id) throw new RpcError('SPV01', 'SP_INVALID: malformed decision');
    if (T('sitting_intents').some(i => i.sitting_id === r.sitting_id && String(i.user_id) !== String(r.user_id))) throw new RpcError('SPV01', 'SP_INVALID: sitting belongs to another user');
    if (r.destination === 'SHARED') {
      if (!storyUsers(r.chapter_id, true).includes(String(r.user_id))) throw new RpcError('SPV01', 'SP_NOT_STORY_PARTNER');
      if (!T('co_sittings').some(c => c.id === r.co_sitting_id && c.chapter_id === r.chapter_id && c.source_key === r.source_key)) throw new RpcError('SPV01', 'SP_INVALID: co-sitting');
    }
    const dec = T('sitting_decisions');
    if (!dec.some(d => d.sitting_id === r.sitting_id)) {
      const t = r.decided_at ?? Date.now();
      dec.push(clone({ sitting_id: r.sitting_id, user_id: r.user_id, source_key: r.source_key, destination: r.destination, chapter_id: r.destination === 'SHARED' ? r.chapter_id : null, co_sitting_id: r.destination === 'SHARED' ? r.co_sitting_id : null, reason: r.reason ?? null, decided_at: t, last_active_at: r.last_active_at ?? t }));
    }
    return clone(dec.find(d => d.sitting_id === r.sitting_id));
  },
  sp_scrapbook_decide_pair({ p_co, p_first, p_second, p_fences }) {
    checkFences(p_fences);
    const bad = [p_first, p_second].some(x => x.destination !== 'SHARED' || x.co_sitting_id !== p_co.id || x.chapter_id !== p_co.chapter_id || x.source_key !== p_co.source_key) || p_first.sitting_id === p_second.sitting_id;
    if (bad) throw new RpcError('SPV01', 'SP_INVALID: inconsistent pair');
    const users = storyUsers(p_co.chapter_id, true);
    if (String(p_first.user_id) === String(p_second.user_id) || !users.includes(String(p_first.user_id)) || !users.includes(String(p_second.user_id))) throw new RpcError('SPV01', 'SP_NOT_STORY_PAIR');
    for (const x of [p_first, p_second]) {
      if (!T('sitting_intents').some(i => i.sitting_id === x.sitting_id && String(i.user_id) === String(x.user_id) && i.source_key === x.source_key)) throw new RpcError('SPV01', 'SP_INVALID: not a recorded intent');
    }
    const dec = T('sitting_decisions');
    if (dec.some(d => d.sitting_id === p_first.sitting_id || d.sitting_id === p_second.sitting_id)) return { applied: false };
    const cos = T('co_sittings');
    if (!cos.some(c => c.id === p_co.id)) cos.push(clone({ ...p_co, applied_together_sec: 0, memory_id: null }));
    for (const r of [p_first, p_second]) dec.push(clone({ chapter_id: null, co_sitting_id: null, ...r, destination: 'SHARED' }));
    return { applied: true };
  },
  sp_scrapbook_save_ledger({ p_row, p_seq, p_now, p_grace_ms, p_fences }) {
    checkFences(p_fences);
    const d = T('sitting_decisions').find(x => x.sitting_id === p_row.sitting_id);
    if (!d || String(d.user_id) !== String(p_row.user_id)) throw new RpcError('SPV01', 'SP_INVALID: no decision');
    const vNow = Math.max(Number(p_now) || 0, Date.now());
    let space, jk, gen;
    if (d.destination === 'SHARED') {
      const ch = T('story_chapters').find(c => c.id === d.chapter_id);
      if (!ch) return { status: 'chapter_missing' };
      if (ch.ended_at != null && (Number(d.decided_at) > Number(ch.ended_at) || vNow > Number(ch.ended_at) + Number(p_grace_ms))) return { status: 'chapter_closed' };
      const m = T('shared_memories').find(x => x.id === p_row.target_id && x.chapter_id === d.chapter_id && x.source_key === d.source_key);
      if (!m) throw new RpcError('SPV01', 'SP_INVALID: target');
      space = 'c:' + d.chapter_id; jk = m.journey_key; gen = Number(m.journey_version);
    } else {
      if (!T('scrapbook_entries').some(e => e.id === p_row.target_id && String(e.user_id) === String(d.user_id) && e.source_key === d.source_key)) throw new RpcError('SPV01', 'SP_INVALID: target');
      space = 'u:' + d.user_id; jk = p_row.journey_key; gen = Number(p_row.generation || 1);
    }
    const led = T('sitting_ledger');
    let l = led.find(x => x.sitting_id === d.sitting_id);
    if (l && p_seq <= Number(l.last_seq)) return { status: 'duplicate', ledger: clone(l) };
    if (l && l.target_id !== p_row.target_id) throw new RpcError('SPV01', 'SP_INVALID: ledger target mismatch');
    if (T('journey_state').some(s => s.space === space && s.journey_key === jk && s.removed_at != null && (Number(s.generation) === gen || Number(s.removed_at) >= Number(d.decided_at)))) return { status: 'removed' };
    const inW = Math.max(0, Number(p_row.watch_cum) || 0), inT = Math.max(0, Number(p_row.together_cum) || 0);
    let status;
    if (!l) {
      if (p_row.max_age_ms != null && Number(d.decided_at) < vNow - Number(p_row.max_age_ms)) return { status: 'expired' };
      const w = inW, tg = Math.min(inT, w);
      l = { sitting_id: d.sitting_id, user_id: d.user_id, destination: d.destination, target_id: p_row.target_id, co_sitting_id: d.co_sitting_id || null, last_seq: p_seq, watch_sec_cum: w, together_sec_cum: tg, interval_start: p_now - w * 1000, interval_end: p_now, applied_watch_sec: 0, applied_together_sec: 0, applied_sessions: 0, updated_at: p_now };
      led.push(l); status = 'inserted';
    } else {
      const w = Math.max(Number(l.watch_sec_cum), inW), tg = Math.max(Number(l.together_sec_cum), Math.min(inT, w));
      Object.assign(l, { last_seq: p_seq, watch_sec_cum: w, together_sec_cum: tg, interval_start: Math.min(Number(l.interval_start), p_now - w * 1000), interval_end: Math.max(Number(l.interval_end), p_now), updated_at: p_now });
      status = 'advanced';
    }
    d.last_active_at = Math.max(Number(d.last_active_at || 0), p_now);
    return { status, ledger: clone(l) };
  },
  sp_scrapbook_apply_ledger({ p_sitting_id, p_old, p_new, p_table, p_bump_id, p_at, p_fences }) {
    checkFences(p_fences);
    const l = T('sitting_ledger').find(x => x.sitting_id === p_sitting_id && Number(x.applied_watch_sec) === Number(p_old.w) && Number(x.applied_together_sec) === Number(p_old.t) && Number(x.applied_sessions) === Number(p_old.s));
    if (!l) return false;
    const okRow = p_table === 'shared_memory_members' ? T('shared_memory_members').some(m => m.id === p_bump_id && m.memory_id === l.target_id && String(m.user_id) === String(l.user_id))
      : p_table === 'scrapbook_entries' ? T('scrapbook_entries').some(e => e.id === p_bump_id && e.id === l.target_id && String(e.user_id) === String(l.user_id)) : false;
    if (!okRow) throw new RpcError('SPV01', 'SP_INVALID: totals row');
    Object.assign(l, { applied_watch_sec: p_new.w, applied_together_sec: p_new.t, applied_sessions: p_new.s });
    bump(p_table, p_bump_id, p_new.w - p_old.w, p_new.t - p_old.t, p_new.s - p_old.s, p_at);
    return true;
  },
  sp_scrapbook_apply_co({ p_co_id, p_old, p_new, p_memory_id, p_at, p_fences }) {
    checkFences(p_fences);
    const c = T('co_sittings').find(x => x.id === p_co_id && Number(x.applied_together_sec || 0) === Number(p_old) && x.memory_id === p_memory_id);
    if (!c) return false;
    c.applied_together_sec = p_new; c.last_active_at = Math.max(Number(c.last_active_at || 0), Number(p_at));
    bump('shared_memories', p_memory_id, 0, p_new - p_old, 0, p_at);
    return true;
  },
  sp_scrapbook_link_co({ p_co_id, p_memory_id, p_at, p_fences }) {
    checkFences(p_fences);
    const c = T('co_sittings').find(x => x.id === p_co_id && x.memory_id == null);
    if (!c || !T('shared_memories').some(m => m.id === p_memory_id && m.chapter_id === c.chapter_id && m.source_key === c.source_key)) return false;
    c.memory_id = p_memory_id; c.last_active_at = Math.max(Number(c.last_active_at || 0), Number(p_at));
    bump('shared_memories', p_memory_id, 0, 0, 1, p_at);
    return true;
  },
  sp_scrapbook_journey_update({ p_state_id, p_expect, p_patch, p_require_open, p_fences }) {
    checkFences(p_fences);
    const s = T('journey_state').find(x => x.id === p_state_id);
    if (!s) return null;
    if (p_require_open && s.space.startsWith('c:')) {
      const ch = T('story_chapters').find(c => c.id === s.space.slice(2));
      if (!ch || ch.ended_at != null) throw new RpcError('SPC01', 'SP_CHAPTER_CLOSED');
    }
    for (const [k, v] of Object.entries(p_expect || {})) if (!same(s[k], v)) return null;
    const next = { ...s };
    for (const k of STATE_MUTABLE) if (p_patch && Object.prototype.hasOwnProperty.call(p_patch, k)) next[k] = p_patch[k];
    guardState(s, next);
    Object.assign(s, next);
    return clone(s);
  },
  sp_scrapbook_purge_journey({ p_state_id, p_now, p_entry_ids = [], p_fences }) {
    checkFences(p_fences);
    const s = T('journey_state').find(x => x.id === p_state_id);
    if (!s || s.removed_at == null || s.purged_at != null || Number(s.purge_after || 0) > Number(p_now)) return { purged: false };
    let victims;
    if (s.space.startsWith('c:')) {
      victims = T('shared_memories').filter(m => m.chapter_id === s.space.slice(2) && m.journey_key === s.journey_key && Number(m.journey_version) === Number(s.generation));
      const ids = new Set(victims.map(m => m.id));
      tables.shared_memory_members = T('shared_memory_members').filter(m => !ids.has(m.memory_id));
      tables.sitting_ledger = T('sitting_ledger').filter(l => !ids.has(l.target_id));
      tables.shared_memories = T('shared_memories').filter(m => !ids.has(m.id));
    } else {
      const want = new Set((p_entry_ids || []).map(String));
      const scope = Number(s.generation) > 1 ? `personal:v${s.generation}` : 'personal';
      victims = T('scrapbook_entries').filter(e => want.has(String(e.id)) && String(e.user_id) === s.space.slice(2) && e.scope === scope);
      const ids = new Set(victims.map(e => e.id));
      tables.sitting_ledger = T('sitting_ledger').filter(l => !ids.has(l.target_id));
      tables.scrapbook_entries = T('scrapbook_entries').filter(e => !ids.has(e.id));
    }
    s.purged_at = p_now; s.updated_at = p_now;
    if (!T('memory_tombstones').some(x => x.id === 'tomb_' + s.id)) T('memory_tombstones').push({ id: 'tomb_' + s.id, space: s.space, journey_key: s.journey_key, generation: Number(s.generation), source_keys: victims.map(v => v.source_key), purged_at: p_now });
    return { purged: true, rows: victims.length, keys: victims.map(v => v.source_key) };
  }
};
const client = {
  from: table => new Query(table),
  rpc: (name, params) => delay().then(() => {
    if (!knobs.rpcEnabled || !RPC[name]) return { data: null, error: { code: 'PGRST202', message: 'Could not find the function ' + name } };
    try { return { data: RPC[name](params || {}) ?? null, error: null }; }
    catch (e) { if (e instanceof RpcError) return E(e.code, e.message); throw e; }
  })
};

function reset() {
  for (const key of Object.keys(tables)) tables[key] = [];
}

module.exports = {
  knobs,
  getSupabaseAdmin: () => client,
  isSupabaseConfigured: () => true,
  tables,
  reset
};
