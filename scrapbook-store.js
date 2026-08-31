const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dataDir = process.env.SYNCPARTY_DATA_DIR || path.join(__dirname, 'data');
const filePath = process.env.SYNCPARTY_DB_FILE || path.join(dataDir, 'scrapbook.json');

function ensureStore() {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, JSON.stringify({ users: [], sessions: [], relations: [], invites: [], entries: [] }, null, 2));
}
function load() {
  ensureStore();
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return {
      users: Array.isArray(raw.users) ? raw.users : [],
      sessions: Array.isArray(raw.sessions) ? raw.sessions : [],
      relations: Array.isArray(raw.relations) ? raw.relations : [],
      invites: Array.isArray(raw.invites) ? raw.invites : [],
      entries: Array.isArray(raw.entries) ? raw.entries : []
    };
  } catch {
    return { users: [], sessions: [], relations: [], invites: [], entries: [] };
  }
}
function save(db) {
  ensureStore();
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, filePath);
}
function id(prefix = 'id') { return `${prefix}_${crypto.randomBytes(9).toString('hex')}`; }
function token() { return crypto.randomBytes(32).toString('base64url'); }
function now() { return Date.now(); }
function getUser(db, userId) { return db.users.find(u => u.id === userId) || null; }
function publicUser(user) {
  if (!user) return null;
  return { id:user.id, name:user.name, email:user.email || null, avatar:user.avatar || '🦊', color:user.color || '#54a0ff', provider:user.provider || 'email' };
}
function getRelation(db, a, b) {
  const ids = [String(a), String(b)].sort();
  return db.relations.find(r => r.userIds?.[0] === ids[0] && r.userIds?.[1] === ids[1]) || null;
}
function relationView(db, r) {
  if (!r) return null;
  return { id:r.id, users:r.userIds.map(uid => publicUser(getUser(db, uid))), createdAt:r.createdAt, acceptedAt:r.acceptedAt || null };
}

function upsertEntry(db, userId, entry, sharedRelationId = null) {
  const sourceKey = String(entry.sourceKey || '').slice(0, 180);
  if (!sourceKey) return null;
  const scope = sharedRelationId ? `shared:${sharedRelationId}` : 'personal';
  const existing = db.entries.find(e => e.userId === userId && e.scope === scope && e.sourceKey === sourceKey);
  const t = now();
  if (existing) {
    existing.title = String(entry.title || existing.title).slice(0, 240);
    existing.kind = entry.kind === 'series' ? 'series' : 'movie';
    existing.thumbnail = entry.thumbnail ? String(entry.thumbnail).slice(0, 2000) : existing.thumbnail || null;
    existing.platform = String(entry.platform || existing.platform || '').slice(0, 80);
    existing.season = Number.isFinite(Number(entry.season)) ? Number(entry.season) : existing.season ?? null;
    existing.episode = Number.isFinite(Number(entry.episode)) ? Number(entry.episode) : existing.episode ?? null;
    existing.progress = Math.max(0, Math.min(1, Number(entry.progress) || existing.progress || 0));
    existing.status = ['completed','watching','paused'].includes(entry.status) ? entry.status : existing.status || 'watching';
    existing.watchDurationSec = Math.max(existing.watchDurationSec || 0, Number(entry.watchDurationSec) || 0);
    existing.lastWatchedAt = Math.max(existing.lastWatchedAt || 0, Number(entry.lastWatchedAt) || t);
    existing.updatedAt = t;
    save(db);
    return existing;
  }
  const created = {
    id:id('entry'), userId, scope, relationId:sharedRelationId,
    sourceKey, title:String(entry.title || 'Untitled').slice(0,240),
    kind:entry.kind === 'series' ? 'series' : 'movie',
    thumbnail:entry.thumbnail ? String(entry.thumbnail).slice(0,2000) : null,
    platform:String(entry.platform || '').slice(0,80),
    season:Number.isFinite(Number(entry.season)) ? Number(entry.season) : null,
    episode:Number.isFinite(Number(entry.episode)) ? Number(entry.episode) : null,
    progress:Math.max(0, Math.min(1, Number(entry.progress) || 0)),
    status:['completed','watching','paused'].includes(entry.status) ? entry.status : 'watching',
    watchDurationSec:Math.max(0, Number(entry.watchDurationSec) || 0),
    firstWatchedAt:Number(entry.firstWatchedAt) || t,
    lastWatchedAt:Number(entry.lastWatchedAt) || t,
    createdAt:t, updatedAt:t
  };
  db.entries.push(created); save(db); return created;
}

module.exports = { load, save, id, token, now, getUser, publicUser, getRelation, relationView, upsertEntry, filePath };
