const crypto = require("crypto");
const { getSupabaseAdmin } = require("./supabase");

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase().slice(0, 160);
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return { hash, salt };
}

function verifyPassword(password, storedHash, salt) {
  try {
    const actual = crypto.scryptSync(String(password), salt, 64).toString("hex");
    return crypto.timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(storedHash, "hex"));
  } catch {
    return false;
  }
}

function id(prefix = "id") {
  return `${prefix}_${crypto.randomBytes(9).toString("hex")}`;
}

function token() {
  return crypto.randomBytes(32).toString("base64url");
}

function tokenHash(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function now() {
  return Date.now();
}

// Party Identity sanitizers. Party Name/PFP/color are the *social* identity
// shown to other SyncParty users and are NEVER derived from Google/OAuth data.
function sanitizePartyName(name) {
  return String(name || "").trim().slice(0, 24);
}
function sanitizePartyAvatar(avatar) {
  const a = String(avatar || "").trim();
  return a ? a.slice(0, 8) : "";
}
function sanitizePartyColor(color) {
  const c = String(color || "").trim();
  return /^#[0-9a-fA-F]{3,8}$/.test(c) ? c : "";
}

// publicUser is the only user shape that ever leaves the server, and it is
// consumed by party-facing surfaces (peers, invitations, Our Story) as well as
// the Account panel. So:
//   - name/avatar/color are ALWAYS the Party Identity (legacy field names kept
//     so existing consumers keep working without any change),
//   - Google/OAuth identity is exposed separately as googleName/googleEmail and
//     must only be rendered inside Account settings.
function publicUser(user) {
  if (!user) return null;
  const partyName = sanitizePartyName(user.partyName) || sanitizePartyName(user.name) || "SyncParty user";
  const partyAvatar = sanitizePartyAvatar(user.partyAvatar) || sanitizePartyAvatar(user.avatar) || "🦊";
  const partyColor = sanitizePartyColor(user.partyColor) || sanitizePartyColor(user.color) || "#54a0ff";
  return {
    id: user.id,
    name: partyName,
    email: user.email || null,
    avatar: partyAvatar,
    color: partyColor,
    partyName,
    partyAvatar,
    partyColor,
    hasPartyIdentity: !!sanitizePartyName(user.partyName),
    googleName: user.name || null,
    googleEmail: user.email || null,
    provider: user.provider || "email"
  };
}

function rowToUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    avatar: row.avatar,
    color: row.color,
    partyName: row.party_name || null,
    partyAvatar: row.party_avatar || null,
    partyColor: row.party_color || null,
    provider: row.provider,
    passwordHash: row.password_hash,
    passwordSalt: row.password_salt,
    googleSub: row.google_sub,
    createdAt: Number(row.created_at) || now()
  };
}

async function createEmailUser({ email, password, name, partyIdentity }) {
  const sb = getSupabaseAdmin();
  email = normalizeEmail(email);
  const hp = hashPassword(password);
  const claimed = normalizePartyIdentity(partyIdentity);
  const user = {
    id: id("user"),
    email,
    name: String(name || email.split("@")[0] || "SyncParty user").slice(0, 24),
    avatar: "🦊",
    color: "#54a0ff",
    party_name: claimed.party_name,
    party_avatar: claimed.party_avatar,
    party_color: claimed.party_color,
    provider: "email",
    password_hash: hp.hash,
    password_salt: hp.salt,
    google_sub: null,
    created_at: now()
  };

  const { data, error } = await sb.from("users").insert(user).select("*").maybeSingle();
  if (error) {
    if (error.code === "23505") return { error: "An account with that email already exists." };
    throw error;
  }
  return { user: rowToUser(data) };
}

async function authenticateEmail(email, password) {
  const sb = getSupabaseAdmin();
  email = normalizeEmail(email);
  const { data, error } = await sb.from("users")
    .select("*")
    .eq("email", email)
    .eq("provider", "email")
    .maybeSingle();
  if (error) throw error;
  const user = rowToUser(data);
  if (!user || !verifyPassword(password, user.passwordHash, user.passwordSalt)) return null;
  return user;
}

async function getUserById(userId) {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb.from("users").select("*").eq("id", String(userId)).maybeSingle();
  if (error) throw error;
  return rowToUser(data);
}

async function getGoogleUser(googleSub) {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb.from("users").select("*").eq("google_sub", String(googleSub)).maybeSingle();
  if (error) throw error;
  return rowToUser(data);
}

async function createGoogleUser({ sub, email, name, partyIdentity }) {
  const sb = getSupabaseAdmin();
  const claimed = normalizePartyIdentity(partyIdentity);
  const user = {
    id: id("user"),
    email: normalizeEmail(email),
    name: String(name || email?.split("@")[0] || "SyncParty user").slice(0, 24),
    avatar: "🦊",
    color: "#54a0ff",
    party_name: claimed.party_name,
    party_avatar: claimed.party_avatar,
    party_color: claimed.party_color,
    provider: "google",
    password_hash: null,
    password_salt: null,
    google_sub: String(sub || "").slice(0, 200),
    created_at: now()
  };
  const { data, error } = await sb.from("users").insert(user).select("*").maybeSingle();
  if (error) {
    if (error.code === "23505") {
      const existing = await getGoogleUser(sub);
      return { user: existing };
    }
    throw error;
  }
  return { user: rowToUser(data) };
}

// Refreshes ONLY the Google/OAuth identity columns. party_name/party_avatar/
// party_color are deliberately absent from this patch: a Google profile change
// must never overwrite the Party Identity.
async function updateGoogleUser(userId, { email, name }) {
  const sb = getSupabaseAdmin();
  const patch = {
    email: normalizeEmail(email),
    name: String(name || "SyncParty user").slice(0, 24)
  };
  const { data, error } = await sb.from("users").update(patch).eq("id", userId).select("*").maybeSingle();
  if (error) throw error;
  return rowToUser(data);
}

function normalizePartyIdentity(identity) {
  return {
    party_name: sanitizePartyName(identity?.partyName ?? identity?.name) || null,
    party_avatar: sanitizePartyAvatar(identity?.partyAvatar ?? identity?.avatar) || null,
    party_color: sanitizePartyColor(identity?.partyColor ?? identity?.color) || null
  };
}

/**
 * Writes the Party Identity for an account.
 *
 * claimOnly=true implements the "brand-new signed-in account" rule: the guest
 * Party Identity is adopted only when the account has no saved Party Name yet.
 * For an account that already has one, the stored server identity stays the
 * source of truth across devices and the call is a no-op.
 */
async function setPartyIdentity(userId, identity, { claimOnly = false } = {}) {
  const existing = await getUserById(userId);
  if (!existing) return null;
  if (claimOnly && sanitizePartyName(existing.partyName)) return existing;

  const next = normalizePartyIdentity(identity);
  const patch = {};
  if (next.party_name) patch.party_name = next.party_name;
  if (next.party_avatar) patch.party_avatar = next.party_avatar;
  if (next.party_color) patch.party_color = next.party_color;
  if (!Object.keys(patch).length) return existing;

  const sb = getSupabaseAdmin();
  const { data, error } = await sb.from("users").update(patch).eq("id", userId).select("*").maybeSingle();
  if (error) throw error;
  return rowToUser(data) || existing;
}

async function createSession(userId) {
  const sb = getSupabaseAdmin();
  const value = token();
  const t = now();
  const { error: delError } = await sb.from("sessions").delete().eq("user_id", userId);
  if (delError) throw delError;
  const { error } = await sb.from("sessions").insert({
    token_hash: tokenHash(value),
    user_id: userId,
    created_at: t,
    expires_at: t + 30 * 24 * 60 * 60 * 1000
  });
  if (error) throw error;
  return value;
}

async function resolveSession(bearer) {
  const value = String(bearer || "").replace(/^Bearer\s+/i, "").trim();
  if (!value) return null;
  const sb = getSupabaseAdmin();
  const { data, error } = await sb.from("sessions")
    .select("user_id, expires_at")
    .eq("token_hash", tokenHash(value))
    .gt("expires_at", now())
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return getUserById(data.user_id);
}

async function revokeSession(bearer) {
  const value = String(bearer || "").replace(/^Bearer\s+/i, "").trim();
  if (!value) return;
  const sb = getSupabaseAdmin();
  const { error } = await sb.from("sessions").delete().eq("token_hash", tokenHash(value));
  if (error) throw error;
}

module.exports = {
  normalizeEmail,
  createEmailUser,
  authenticateEmail,
  getUserById,
  getGoogleUser,
  createGoogleUser,
  updateGoogleUser,
  setPartyIdentity,
  normalizePartyIdentity,
  createSession,
  resolveSession,
  revokeSession,
  publicUser,
  id,
  token,
  now
};
