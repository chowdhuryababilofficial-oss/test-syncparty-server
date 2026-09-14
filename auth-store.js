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

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    email: user.email || null,
    avatar: user.avatar || "🦊",
    color: user.color || "#54a0ff",
    partyName: user.partyName || user.name || "SyncParty user",
    partyAvatar: user.partyAvatar || user.avatar || "🦊",
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
    partyName: row.party_name || row.name,
    partyAvatar: row.party_avatar || row.avatar,
    provider: row.provider,
    passwordHash: row.password_hash,
    passwordSalt: row.password_salt,
    googleSub: row.google_sub,
    createdAt: Number(row.created_at) || now()
  };
}

async function createEmailUser({ email, password, name }) {
  const sb = getSupabaseAdmin();
  email = normalizeEmail(email);
  const hp = hashPassword(password);
  const user = {
    id: id("user"),
    email,
    name: String(name || email.split("@")[0] || "SyncParty user").slice(0, 24),
    avatar: "🦊",
    color: "#54a0ff",
    party_name: String(name || email.split("@")[0] || "SyncParty user").slice(0, 24),
    party_avatar: "🦊",
    provider: "email",
    password_hash: hp.hash,
    password_salt: hp.salt,
    google_sub: null,
    created_at: now()
  };

  let { data, error } = await sb.from("users").insert(user).select("*").maybeSingle();
  if (error && /column .*?(party_name|party_avatar).*?(does not exist|unknown)/i.test(String(error.message || ""))) {
    const legacy = { ...user }; delete legacy.party_name; delete legacy.party_avatar;
    const retry = await sb.from("users").insert(legacy).select("*").maybeSingle(); data=retry.data; error=retry.error;
  }
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

async function createGoogleUser({ sub, email, name }) {
  const sb = getSupabaseAdmin();
  const user = {
    id: id("user"),
    email: normalizeEmail(email),
    name: String(name || email?.split("@")[0] || "SyncParty user").slice(0, 24),
    avatar: "🦊",
    color: "#54a0ff",
    party_name: String(name || email?.split("@")[0] || "SyncParty user").slice(0, 24),
    party_avatar: "🦊",
    provider: "google",
    password_hash: null,
    password_salt: null,
    google_sub: String(sub || "").slice(0, 200),
    created_at: now()
  };
  let { data, error } = await sb.from("users").insert(user).select("*").maybeSingle();
  if (error && /column .*?(party_name|party_avatar).*?(does not exist|unknown)/i.test(String(error.message || ""))) {
    const legacy = { ...user }; delete legacy.party_name; delete legacy.party_avatar;
    const retry = await sb.from("users").insert(legacy).select("*").maybeSingle(); data=retry.data; error=retry.error;
  }
  if (error) {
    if (error.code === "23505") {
      const existing = await getGoogleUser(sub);
      return { user: existing };
    }
    throw error;
  }
  return { user: rowToUser(data) };
}

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

async function updatePartyIdentity(userId, { partyName, partyAvatar }) {
  const sb = getSupabaseAdmin();
  const name = String(partyName || "SyncParty user").trim().slice(0, 24) || "SyncParty user";
  const allowed = new Set(["🦊","🐼","🐸","🐨","🦁","🐯","🐵","🐧","🦄","🐙","🦋","🐝","🐢","🐳","🦖","🐰"]);
  const avatar = allowed.has(String(partyAvatar || "")) ? String(partyAvatar) : "🦊";
  const patch = { party_name: name, party_avatar: avatar };
  const { data, error } = await sb.from("users").update(patch).eq("id", userId).select("*").maybeSingle();
  if (error) {
    if (/column .*?(party_name|party_avatar).*?(does not exist|unknown)/i.test(String(error.message || ""))) return { error: "Party Identity needs the latest SyncParty database migration." };
    throw error;
  }
  return { user: rowToUser(data) };
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
  updatePartyIdentity,
  createSession,
  resolveSession,
  revokeSession,
  publicUser,
  id,
  token,
  now
};
