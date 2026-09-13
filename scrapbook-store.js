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
    contentType: row.content_type || row.kind,
    thumbnail: row.thumbnail,
    artwork: row.artwork || row.thumbnail || null,
    backdrop: row.backdrop || null,
    artworkCandidates: Array.isArray(row.artwork_candidates) ? row.artwork_candidates : [],
    canonicalTitle: row.canonical_title || row.title,
    platform: row.platform,
    season: row.season == null ? null : Number(row.season),
    episode: row.episode == null ? null : Number(row.episode),
    progress: Number(row.progress || 0),
    status: row.status,
    watchDurationSec: Number(row.watch_duration_sec || 0),
    togetherDurationSec: Number(row.together_duration_sec || 0),
    sessionCount: Number(row.session_count || 0),
    completedAt: row.completed_at == null ? null : Number(row.completed_at),
    metadataProvider: row.metadata_provider || "",
    metadataId: row.metadata_id || "",
    metadataYear: row.metadata_year == null ? null : Number(row.metadata_year),
    storyTotalEpisodes: Number(row.story_total_episodes || 0),
    storyEpisodesCompleted: Number(row.story_episodes_completed || 0),
    storyProgress: row.story_progress == null ? null : Number(row.story_progress),
    storyProgressConfidence: row.story_progress_confidence == null ? null : Number(row.story_progress_confidence),
    seriesEpisodeCounts: row.series_episode_counts && typeof row.series_episode_counts === "object" ? row.series_episode_counts : null,
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
    kind: ["movie","series","anime"].includes(entry.contentType || entry.kind) ? (entry.contentType || entry.kind) : (existing?.kind || "movie"),
    content_type: ["movie","series","anime"].includes(entry.contentType || entry.kind) ? (entry.contentType || entry.kind) : (existing?.content_type || existing?.kind || "movie"),
    canonical_title: String(entry.canonicalTitle || existing?.canonical_title || entry.title || existing?.title || "Untitled").slice(0,240),
    artwork: entry.artwork ? String(entry.artwork).slice(0,2000) : (existing?.artwork || null),
    backdrop: entry.backdrop ? String(entry.backdrop).slice(0,2000) : (existing?.backdrop || null),
    artwork_candidates: Array.isArray(entry.artworkCandidates) && entry.artworkCandidates.length
      ? entry.artworkCandidates.slice(0,8).map(u => String(u).slice(0,2000))
      : (existing?.artwork_candidates || []),
    thumbnail: entry.thumbnail ? String(entry.thumbnail).slice(0, 2000) : (existing?.thumbnail || null),
    platform: String(entry.platform || existing?.platform || "").slice(0, 80),
    season: Number.isFinite(Number(entry.season)) ? Number(entry.season) : (existing?.season ?? null),
    episode: Number.isFinite(Number(entry.episode)) ? Number(entry.episode) : (existing?.episode ?? null),
    progress: Math.max(0, Math.min(1, Number(entry.progress) || Number(existing?.progress || 0))),
    status: ["completed", "watching", "paused"].includes(entry.status) ? entry.status : (existing?.status || "watching"),
    watch_duration_sec: existing
      ? Math.max(0, Number(existing.watch_duration_sec || 0) + (Number(entry.watchDurationDeltaSec) || 0))
      : Math.max(0, Number(entry.watchDurationDeltaSec) || Number(entry.watchDurationSec) || 0),
    // Same delta-accumulation pattern as watch_duration_sec, kept as an
    // entirely separate column — see sampleTogether() in
    // scrapbook-collector.js for exactly what this counts.
    together_duration_sec: existing
      ? Math.max(0, Number(existing.together_duration_sec || 0) + (Number(entry.togetherDurationDeltaSec) || 0))
      : Math.max(0, Number(entry.togetherDurationDeltaSec) || Number(entry.togetherDurationSec) || 0),
    session_count: Math.max(0, Number(existing?.session_count || 0) + (Number(entry.sessionCountDelta) || 0)) || 1,
    // Earliest non-null wins — a later re-watch reaching 'completed' again
    // must not overwrite the original completion date.
    completed_at: existing?.completed_at != null ? existing.completed_at : (Number.isFinite(Number(entry.completedAt)) ? Number(entry.completedAt) : null),
    metadata_provider: String(entry.metadataProvider || existing?.metadata_provider || "").slice(0,40),
    metadata_id: String(entry.metadataId || existing?.metadata_id || "").slice(0,80),
    metadata_year: Number.isFinite(Number(entry.metadataYear)) ? Number(entry.metadataYear) : (existing?.metadata_year ?? null),
    story_total_episodes: Math.max(0, Number(entry.storyTotalEpisodes) || Number(existing?.story_total_episodes || 0)),
    story_episodes_completed: Math.max(0, Number(entry.storyEpisodesCompleted) || Number(existing?.story_episodes_completed || 0)),
    story_progress: entry.storyProgress == null ? (existing?.story_progress ?? null) : Math.max(0, Math.min(1, Number(entry.storyProgress))),
    story_progress_confidence: entry.storyProgressConfidence == null ? (existing?.story_progress_confidence ?? null) : Math.max(0, Math.min(1, Number(entry.storyProgressConfidence))),
    series_episode_counts: entry.seriesEpisodeCounts && typeof entry.seriesEpisodeCounts === "object" ? entry.seriesEpisodeCounts : (existing?.series_episode_counts || null),
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
    .select("id,user1_id,user2_id,created_at,accepted_at,ended_at")
    .eq("user1_id", ids[0]).eq("user2_id", ids[1])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
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
    acceptedAt: r.accepted_at == null ? null : Number(r.accepted_at),
    endedAt: r.ended_at == null ? null : Number(r.ended_at),
    active: r.accepted_at != null && r.ended_at == null
  };
}

async function getActiveRelation(userId) {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb.from("relations")
    .select("id,user1_id,user2_id,created_at,accepted_at,ended_at")
    .or(`user1_id.eq.${userId},user2_id.eq.${userId}`)
    .not("accepted_at", "is", null)
    .is("ended_at", null)
    .order("accepted_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function listUserRelations(userId) {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb.from("relations")
    .select("id,user1_id,user2_id,created_at,accepted_at,ended_at")
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
  let { data, error } = await sb.from("scrapbook_entries").insert(row).select("*").maybeSingle();
  if (error) {
    if (error.code === "23505") return upsertEntry(userId, entry, sharedRelationId);
    // An existing deployment may not yet have the optional artwork/title columns.
    // Retry only the legacy-compatible fields; anime still correctly requires the
    // existing kind/content_type constraint to permit it.
    const modernSchemaError = /column .*?(content_type|canonical_title|artwork|artwork_candidates|backdrop|metadata_provider|metadata_id|metadata_year|story_total_episodes|story_episodes_completed|story_progress|story_progress_confidence|series_episode_counts|together_duration_sec|session_count|completed_at).*?(does not exist|unknown)/i.test(String(error.message || ""));
    if (modernSchemaError) {
      const legacyRow = { ...row };
      delete legacyRow.content_type;
      delete legacyRow.canonical_title;
      delete legacyRow.artwork;
      const legacy = await sb.from("scrapbook_entries").insert(legacyRow).select("*").maybeSingle();
      if (!legacy.error) return rowToEntry(legacy.data);
      error = legacy.error;
    }
    throw error;
  }
  return rowToEntry(data);
}

async function createInvite(fromUserId, toUserId) {
  const sb = getSupabaseAdmin();
  if (String(fromUserId) === String(toUserId)) return { error: "Choose a different SyncParty user." };
  const [fromActive, toActive, relation] = await Promise.all([
    getActiveRelation(fromUserId),
    getActiveRelation(toUserId),
    getRelation(fromUserId, toUserId)
  ]);
  if (fromActive) return { error: "You already have an active Our Story." };
  if (toActive) return { error: "That user already has an active Our Story." };
  if (relation?.accepted_at && relation?.ended_at == null) return { relation: await relationView(relation) };
  const { data: existing, error: findError } = await sb.from("invites")
    .select("*").eq("from_user_id", fromUserId).eq("to_user_id", toUserId).eq("status", "pending").maybeSingle();
  if (findError) throw findError;
  if (existing) return { invite: rowToInvite(existing) };
  const invite = { id: id("invite"), from_user_id: fromUserId, to_user_id: toUserId, status: "pending", created_at: now(), responded_at: null };
  const { data, error } = await sb.from("invites").insert(invite).select("*").maybeSingle();
  if (error) {
    if (error.code === "23505") {
      const [freshFrom, freshTo] = await Promise.all([getActiveRelation(fromUserId), getActiveRelation(toUserId)]);
      if (freshFrom || freshTo) return { error: "One of you already has an active Our Story." };
      const { data: retry } = await sb.from("invites").select("*").eq("from_user_id", fromUserId).eq("to_user_id", toUserId).eq("status", "pending").maybeSingle();
      if (retry) return { invite: rowToInvite(retry) };
    }
    throw error;
  }
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
  if (!accept) {
    const { error: updateError } = await sb.from("invites").update({ status: "declined", responded_at: respondedAt }).eq("id", inviteId).eq("status", "pending");
    if (updateError) throw updateError;
    return { relation: null };
  }
  const [fromActive, toActive] = await Promise.all([getActiveRelation(inv.from_user_id), getActiveRelation(inv.to_user_id)]);
  if (fromActive || toActive) return { error: "One of you already has an active Our Story." };
  const ids = [inv.from_user_id, inv.to_user_id].sort();
  const existing = await getRelation(inv.from_user_id, inv.to_user_id);
  let relation = existing;
  if (!relation) {
    const row = { id: id("rel"), user1_id: ids[0], user2_id: ids[1], created_at: respondedAt, accepted_at: respondedAt, ended_at: null };
    const { data, error } = await sb.from("relations").insert(row).select("*").maybeSingle();
    if (error) {
      if (error.code === "23505") {
        const [freshFrom, freshTo] = await Promise.all([getActiveRelation(inv.from_user_id), getActiveRelation(inv.to_user_id)]);
        if (freshFrom || freshTo) return { error: "One of you already has an active Our Story." };
        relation = await getRelation(inv.from_user_id, inv.to_user_id);
        if (!relation || relation.ended_at != null) return { error: "This invitation can no longer be accepted." };
      } else throw error;
    } else relation = data;
  } else if (relation.accepted_at && relation.ended_at == null) {
    return { relation: await relationView(relation) };
  } else {
    relation = null;
    const row = { id: id("rel"), user1_id: ids[0], user2_id: ids[1], created_at: respondedAt, accepted_at: respondedAt, ended_at: null };
    const { data, error } = await sb.from("relations").insert(row).select("*").maybeSingle();
    if (error) {
      if (error.code === "23505") return { error: "One of you already has an active Our Story." };
      throw error;
    }
    relation = data;
  }
  const { error: updateError } = await sb.from("invites").update({ status: "accepted", responded_at: respondedAt }).eq("id", inviteId).eq("status", "pending");
  if (updateError) throw updateError;
  return { relation: await relationView(relation) };
}

async function endRelation(relationId, userId) {
  const sb = getSupabaseAdmin();
  const { data: relation, error: findError } = await sb.from("relations")
    .select("id,user1_id,user2_id,created_at,accepted_at,ended_at")
    .eq("id", relationId)
    .or(`user1_id.eq.${userId},user2_id.eq.${userId}`)
    .maybeSingle();
  if (findError) throw findError;
  if (!relation) return { error: "Our Story was not found." };
  if (!relation.accepted_at) return { error: "This Our Story is not active." };
  if (relation.ended_at != null) return { relation: await relationView(relation) };
  const endedAt = now();
  const { data, error } = await sb.from("relations")
    .update({ ended_at: endedAt })
    .eq("id", relationId)
    .is("ended_at", null)
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return { relation: await relationView(data || { ...relation, ended_at: endedAt }) };
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
  getActiveRelation,
  relationView,
  listUserRelations,
  listPersonalEntries,
  listSharedEntries,
  upsertEntry,
  createInvite,
  listInvites,
  respondInvite,
  endRelation,
  getHighlights,
  rowToInvite
};
