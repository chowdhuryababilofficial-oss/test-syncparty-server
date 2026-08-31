const crypto = require('crypto');
const { now, id, token } = require('./scrapbook-store');

function normalizeEmail(email) { return String(email || '').trim().toLowerCase().slice(0, 160); }
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { hash, salt };
}
function verifyPassword(password, storedHash, salt) {
  try {
    const actual = crypto.scryptSync(String(password), salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(storedHash, 'hex'));
  } catch { return false; }
}
function createEmailUser(db, { email, password, name }) {
  email = normalizeEmail(email);
  const existing = db.users.find(u => u.email === email);
  if (existing) return { error: 'An account with that email already exists.' };
  const hp = hashPassword(password);
  const user = { id:id('user'), email, name:String(name || email.split('@')[0] || 'SyncParty user').slice(0,24), avatar:'🦊', color:'#54a0ff', provider:'email', passwordHash:hp.hash, passwordSalt:hp.salt, createdAt:now() };
  db.users.push(user); return { user };
}
function authenticateEmail(db, email, password) {
  email = normalizeEmail(email);
  const user = db.users.find(u => u.email === email && u.provider === 'email');
  if (!user || !verifyPassword(password, user.passwordHash, user.passwordSalt)) return null;
  return user;
}
function createSession(db, userId) {
  const value = token();
  db.sessions = db.sessions.filter(s => s.userId !== userId && s.expiresAt > now());
  db.sessions.push({ token:value, userId, createdAt:now(), expiresAt:now() + 30*24*60*60*1000 });
  return value;
}
function resolveSession(db, bearer) {
  const value = String(bearer || '').replace(/^Bearer\s+/i, '').trim();
  if (!value) return null;
  const s = db.sessions.find(x => x.token === value && x.expiresAt > now());
  return s ? db.users.find(u => u.id === s.userId) || null : null;
}
function revokeSession(db, bearer) {
  const value = String(bearer || '').replace(/^Bearer\s+/i, '').trim();
  db.sessions = db.sessions.filter(s => s.token !== value);
}
module.exports = { normalizeEmail, createEmailUser, authenticateEmail, createSession, resolveSession, revokeSession };
