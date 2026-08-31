const crypto = require("crypto");
const { getSupabaseAdmin } = require("./supabase");
const { publicUser } = require("./auth-store");

function id(prefix = "id") {
  return `${prefix}_${crypto.randomBytes(9).toString("hex")}`;
}

function now() { return Date.now(); }

function rowToEntry(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    scope: row.scope,
    relationId: row.relation_id,
    sourceKey: row.source_key,
    title: row.title,
    kind: row.kind,
    thumbnail: row.thumbnail,
    platform: row.platform,
    season: row.season == null ? null : Number(row.season),
    episode: row.episode == null ? null : Number(row.episode),
    progress: Number(row.progress || 0),
    status: row.status,
    watchDurationSec: Number(row.watch_duration_sec || 0),
    firstWatchedAt: Number(row.first_watched_at || 0),
    lastWatchedAt: Number(row.last_watched_at || 0),
    createdAt: Number(row.created_at || 0),
    updatedAt: Number(row.updated_at || 0)
  };
}

function normalizeEntry(entry, existing = null) {
  const t = now();
  return {
    source_key: String(entry.sourceKey || existing?.source_key || "").slice(0, 180),
    title: String(entry.title || existing?.title || "Untitled").slice(0, 240),
    kind: entry.kind === "series" ? "series" : "movie",
    thumbnail: entry.thumbnail ? String(entry.thumbnail).slice(0, 2000) : (existing?.thumbnail || null),
    platform: String(entry.platform || existing?.platform || "").slice(0, 80),
    season: Number.isFinite(Number(entry.season)) ? Number(entry.season) : (existing?.season ?? null),
    episode: Number.isFinite(Number(entry.episode)) ? Number(entry.episode) : (existing?.episode ?? null),
    progress: Math.max(0, Math.min(1, Number(entry.progress) || Number(existing?.progress || 0))),
    status: ["completed", "watching", "paused"].includes(entry.status) ? entry.status : (existing?.status || "watching"),
    watch_duration_sec: Math.max(Number(existing?.watch_duration_sec || 0), Number(entry.watchDurationSec) || 0),
    first_watched_at: Math.min(Number(existing?.first_watched_at || 0) || Number(entry.firstWatchedAt) || t, Number(entry.firstWatchedAt) || t),
    last_watched_at: Math.max(Number(existing?.last_watched_at || 0), Number(entry.lastWatchedAt) || t),
    updated_at: t
  };
}

async function getUser(userId) {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb.from("users").select("id,name,email,avatar,color,provider").eq("id", userId).maybeSingle();
  if (error) throw error;
  return data ? {
    id: data.id, name: data.name, email: data.email, avatar: data.avatar, color: data.color, provider: data.provider
  } : null;
}

async function getRelation(a, b) {
  const ids = [String(a), String(b)].sort();
  const sb = getSupabaseAdmin();
  const { data, error } = await sb.from("relations")
    .select("id,user1_id,user2_id,created_at,accepted_at")
    .eq("user1_id", ids[0]).eq("user2_id", ids[1]).maybeSingle();
  if (error) throw error;
  return data || null;
}

async function relationView(r) {
  if (!r) return null;
  const [a, b] = await Promise.all([getUser(r.user1_id), getUser(r.user2_id)]);
  return {
    id: r.id,
    users: [publicUser(a), publicUser(b)],
    createdAt: Number(r.created_at || 0),
    acceptedAt: r.accepted_at == null ? null : Number(r.accepted_at)
  };
}

async function listUserRelations(userId) {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb.from("relations")
    .select("id,user1_id,user2_id,created_at,accepted_at")
    .or(`user1_id.eq.${userId},user2_id.eq.${userId}`)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return Promise.all((data || []).map(relationView));
}

async function listPersonalEntries(userId, limit = 150) {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb.from("scrapbook_entries")
    .select("*")
    .eq("user_id", userId)
    .eq("scope", "personal")
    .order("last_watched_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data || []).map(rowToEntry);
}

async function listSharedEntries(userId, relationId = null, limit = 150) {
  const sb = getSupabaseAdmin();
  let q = sb.from("scrapbook_entries")
    .select("*")
    .eq("user_id", userId)
    .like("scope", "shared:%")
    .order("last_watched_at", { ascending: false })
    .limit(limit);
  if (relationId) q = q.eq("relation_id", relationId);
  const { data, error } = await q;
  if (error) throw error;
  return (data || []).map(rowToEntry);
}

async function upsertEntry(userId, entry, sharedRelationId = null) {
  const sourceKey = String(entry.sourceKey || "").slice(0, 180);
  if (!sourceKey) return null;
  const scope = sharedRelationId ? `shared:${sharedRelationId}` : "personal";
  const sb = getSupabaseAdmin();
  const { data: existing, error: findError } = await sb.from("scrapbook_entries")
    .select("*")
    .eq("user_id", userId)
    .eq("scope", scope)
    .eq("source_key", sourceKey)
    .maybeSingle();
  if (findError) throw findError;

  if (existing) {
    const patch = normalizeEntry({ ...entry, sourceKey }, existing);
    const { data, error } = await sb.from("scrapbook_entries")
      .update(patch)
      .eq("id", existing.id)
      .select("*")
      .maybeSingle();
    if (error) throw error;
    return rowToEntry(data);
  }

  const t = now();
  const values = normalizeEntry({ ...entry, sourceKey });
  const row = {
    id: id("entry"),
    user_id: userId,
    scope,
    relation_id: sharedRelationId,
    ...values,
    created_at: t
  };
  const { data, error } = await sb.from("scrapbook_entries").insert(row).select("*").maybeSingle();
  if (error) {
    if (error.code === "23505") return upsertEntry(userId, entry, sharedRelationId);
    throw error;
  }
  return rowToEntry(data);
}

async function createInvite(fromUserId, toUserId) {
  const sb = getSupabaseAdmin();
  const relation = await getRelation(fromUserId, toUserId);
  if (relation?.accepted_at) return { relation: await relationView(relation) };
  const { data: existing, error: findError } = await sb.from("invites")
    .select("*").eq("from_user_id", fromUserId).eq("to_user_id", toUserId).eq("status", "pending").maybeSingle();
  if (findError) throw findError;
  if (existing) return { invite: rowToInvite(existing) };
  const invite = { id: id("invite"), from_user_id: fromUserId, to_user_id: toUserId, status: "pending", created_at: now(), responded_at: null };
  const { data, error } = await sb.from("invites").insert(invite).select("*").maybeSingle();
  if (error) throw error;
  return { invite: rowToInvite(data) };
}

function rowToInvite(row) {
  if (!row) return null;
  return {
    id: row.id,
    fromUserId: row.from_user_id,
    toUserId: row.to_user_id,
    status: row.status,
    createdAt: Number(row.created_at || 0),
    respondedAt: row.responded_at == null ? null : Number(row.responded_at)
  };
}

async function listInvites(userId) {
  const sb = getSupabaseAdmin();
  const [incoming, outgoing] = await Promise.all([
    sb.from("invites").select("*").eq("to_user_id", userId).eq("status", "pending").order("created_at", { ascending: false }),
    sb.from("invites").select("*").eq("from_user_id", userId).eq("status", "pending").order("created_at", { ascending: false })
  ]);
  if (incoming.error) throw incoming.error;
  if (outgoing.error) throw outgoing.error;
  const incomingRows = await Promise.all((incoming.data || []).map(async r => ({ ...rowToInvite(r), fromUser: publicUser(await getUser(r.from_user_id)) })));
  const outgoingRows = await Promise.all((outgoing.data || []).map(async r => ({ ...rowToInvite(r), toUser: publicUser(await getUser(r.to_user_id)) })));
  return { pendingIncoming: incomingRows, pendingOutgoing: outgoingRows };
}

async function respondInvite(inviteId, userId, accept) {
  const sb = getSupabaseAdmin();
  const { data: inv, error: findError } = await sb.from("invites")
    .select("*").eq("id", inviteId).eq("to_user_id", userId).eq("status", "pending").maybeSingle();
  if (findError) throw findError;
  if (!inv) return { error: "Invitation no longer exists." };
  const respondedAt = now();
  const { error: updateError } = await sb.from("invites").update({ status: accept ? "accepted" : "declined", responded_at: respondedAt }).eq("id", inviteId);
  if (updateError) throw updateError;
  if (!accept) return { relation: null };
  const ids = [inv.from_user_id, inv.to_user_id].sort();
  const existing = await getRelation(inv.from_user_id, inv.to_user_id);
  let relation = existing;
  if (!relation) {
    const row = { id: id("rel"), user1_id: ids[0], user2_id: ids[1], created_at: respondedAt, accepted_at: respondedAt };
    const { data, error } = await sb.from("relations").insert(row).select("*").maybeSingle();
    if (error) {
      if (error.code === "23505") relation = await getRelation(inv.from_user_id, inv.to_user_id);
      else throw error;
    } else relation = data;
  } else if (!relation.accepted_at) {
    const { data, error } = await sb.from("relations").update({ accepted_at: respondedAt }).eq("id", relation.id).select("*").maybeSingle();
    if (error) throw error;
    relation = data;
  }
  return { relation: await relationView(relation) };
}

async function getHighlights(userId) {
  const entries = await listPersonalEntries(userId, 300);
  const totalSec = entries.reduce((n, e) => n + (e.watchDurationSec || 0), 0);
  return {
    totalEntries: entries.length,
    totalHours: Math.round(totalSec / 3600 * 10) / 10,
    completed: entries.filter(e => e.status === "completed").length,
    moments: []
  };
}

module.exports = {
  id,
  now,
  getUser,
  getRelation,
  relationView,
  listUserRelations,
  listPersonalEntries,
  listSharedEntries,
  upsertEntry,
  createInvite,
  listInvites,
  respondInvite,
  getHighlights,
  rowToInvite
};
