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
    episodeTitle: row.episode_title || null,
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
    updatedAt: Number(row.updated_at || 0),
    archivedAt: row.archived_at == null ? null : Number(row.archived_at)
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
    // entry.season/episode arrive as null for movies; Number(null) is 0 and
    // Number.isFinite(0) is true, so guard against null explicitly or every
    // movie would be written as "season 0".
    season: entry.season != null && Number.isFinite(Number(entry.season)) ? Number(entry.season) : (existing?.season ?? null),
    episode: entry.episode != null && Number.isFinite(Number(entry.episode)) ? Number(entry.episode) : (existing?.episode ?? null),
    // Never overwrite a known episode name with null: a later save from a
    // page without JSON-LD must not erase a title we already resolved.
    episode_title: entry.episodeTitle ? String(entry.episodeTitle).slice(0, 240) : (existing?.episode_title ?? null),
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
  // party_name/party_avatar/party_color must be selected here too, otherwise
  // publicUser() below would fall back to the Google name on every
  // party-facing surface (Our Story, invitations, relationship UI).
  const { data, error } = await sb.from("users").select("id,name,email,avatar,color,party_name,party_avatar,party_color,provider").eq("id", userId).maybeSingle();
  if (error) throw error;
  return data ? {
    id: data.id, name: data.name, email: data.email, avatar: data.avatar, color: data.color,
    partyName: data.party_name || null, partyAvatar: data.party_avatar || null, partyColor: data.party_color || null,
    provider: data.provider
  } : null;
}

// archived_at / ended_at are additive columns. Ending or archiving an Our
// Story never deletes the relation or any shared memory — it only stamps the
// relation so it stops being the ONE active story and becomes read-only.
const RELATION_COLUMNS = "id,user1_id,user2_id,created_at,accepted_at,archived_at,ended_at";

async function getRelation(a, b) {
  const ids = [String(a), String(b)].sort();
  const sb = getSupabaseAdmin();
  const { data, error } = await sb.from("relations")
    .select(RELATION_COLUMNS)
    .eq("user1_id", ids[0]).eq("user2_id", ids[1]).maybeSingle();
  if (error) throw error;
  return data || null;
}

// Looks a story up by its OWN id. getRelation(a, b) takes two USER ids and
// sorts them into the user1_id/user2_id pair, so passing a relation id there
// never matches anything.
async function getRelationById(relationId) {
  const value = String(relationId || "");
  if (!value) return null;
  const sb = getSupabaseAdmin();
  const { data, error } = await sb.from("relations")
    .select(RELATION_COLUMNS)
    .eq("id", value).maybeSingle();
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
    archivedAt: r.archived_at == null ? null : Number(r.archived_at),
    endedAt: r.ended_at == null ? null : Number(r.ended_at)
  };
}

async function listUserRelations(userId) {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb.from("relations")
    .select(RELATION_COLUMNS)
    .or(`user1_id.eq.${userId},user2_id.eq.${userId}`)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return Promise.all((data || []).map(relationView));
}

// includeArchived lets the Scrapbook show archived memories read-only in its
// "Archived" filter. Default stays active-only so existing callers are
// unaffected.
async function listPersonalEntries(userId, limit = 150, includeArchived = true) {
  const sb = getSupabaseAdmin();
  let q = sb.from("scrapbook_entries")
    .select("*")
    .eq("user_id", userId)
    .eq("scope", "personal")
    .order("last_watched_at", { ascending: false })
    .limit(limit);
  if (!includeArchived) q = q.is("archived_at", null);
  const { data, error } = await q;
  if (error) throw error;
  return (data || []).map(rowToEntry);
}

async function listSharedEntries(userId, relationId = null, limit = 150, includeArchived = true) {
  const sb = getSupabaseAdmin();
  let q = sb.from("scrapbook_entries")
    .select("*")
    .eq("user_id", userId)
    .like("scope", "shared:%")
    .order("last_watched_at", { ascending: false })
    .limit(limit);
  if (relationId) q = q.eq("relation_id", relationId);
  if (!includeArchived) q = q.is("archived_at", null);
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
    const modernSchemaError = /column .*?(content_type|canonical_title|artwork|artwork_candidates|backdrop|metadata_provider|metadata_id|metadata_year|episode_title|story_total_episodes|story_episodes_completed|story_progress|story_progress_confidence|series_episode_counts|together_duration_sec|session_count|completed_at).*?(does not exist|unknown)/i.test(String(error.message || ""));
    if (modernSchemaError) {
      // Every column named in the regex above must be stripped here too —
      // this list previously only dropped the original three (content_type/
      // canonical_title/artwork) even after the regex was widened to cover
      // all the newer optional columns added since. On any deployment still
      // missing one of those newer columns, the retry below re-inserted the
      // very same offending column and failed with the identical error,
      // which is why brand-new rows (e.g. every entry in a guest → account
      // history migration, which is all first-time inserts) surfaced as a
      // generic "SyncParty server error." Existing rows were unaffected
      // since they go through the UPDATE branch above, not this one.
      const legacyRow = { ...row };
      delete legacyRow.content_type;
      delete legacyRow.canonical_title;
      delete legacyRow.artwork;
      delete legacyRow.artwork_candidates;
      delete legacyRow.backdrop;
      delete legacyRow.metadata_provider;
      delete legacyRow.metadata_id;
      delete legacyRow.metadata_year;
      delete legacyRow.episode_title;
      delete legacyRow.story_total_episodes;
      delete legacyRow.story_episodes_completed;
      delete legacyRow.story_progress;
      delete legacyRow.story_progress_confidence;
      delete legacyRow.series_episode_counts;
      delete legacyRow.together_duration_sec;
      delete legacyRow.session_count;
      delete legacyRow.completed_at;
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

// Returns the single active Our Story for a user, if any. "Active" means
// accepted and neither archived nor ended, which is what enforces the
// one-active-story-at-a-time rule and blocks third-party invitations.
async function getActiveRelationRow(userId) {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb.from("relations")
    .select(RELATION_COLUMNS)
    .or(`user1_id.eq.${userId},user2_id.eq.${userId}`)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return (data || []).find(r => r.accepted_at && r.archived_at == null && r.ended_at == null) || null;
}

// Ends or archives an Our Story. Both are non-destructive: the relation row
// and every shared scrapbook_entries row stay exactly as they are, so the
// story remains viewable read-only and personal memories are untouched. After
// this the user is free to start a new Our Story with someone else.
async function closeRelation(relationId, userId, mode = "end") {
  const sb = getSupabaseAdmin();
  const { data: row, error: findError } = await sb.from("relations")
    .select(RELATION_COLUMNS).eq("id", String(relationId)).maybeSingle();
  if (findError) throw findError;
  if (!row) return { error: "That story no longer exists." };
  if (![row.user1_id, row.user2_id].includes(String(userId))) return { error: "You are not part of this story." };
  if (row.archived_at != null || row.ended_at != null) return { relation: await relationView(row) };

  const t = now();
  // Ending also archives, so an ended story still shows up in the archived
  // list as read-only rather than disappearing.
  const patch = mode === "archive" ? { archived_at: t } : { archived_at: t, ended_at: t };
  const { data, error } = await sb.from("relations").update(patch).eq("id", row.id).select(RELATION_COLUMNS).maybeSingle();
  if (error) throw error;

  // Any still-pending invitation tied to this pair is stale once the story is
  // closed; leaving it pending would block a fresh Our Story later.
  const { error: inviteError } = await sb.from("invites")
    .update({ status: "declined", responded_at: t })
    .eq("status", "pending")
    .or(`and(from_user_id.eq.${row.user1_id},to_user_id.eq.${row.user2_id}),and(from_user_id.eq.${row.user2_id},to_user_id.eq.${row.user1_id})`);
  if (inviteError) throw inviteError;

  return { relation: await relationView(data || { ...row, ...patch }) };
}

// Compares what the client believes it has against what is actually stored,
// so the Sync & Backup panel can show real confirmed/pending/failed state
// instead of guessing. Read-only: it never writes entries.
async function reconcileEntries(userId, entries = []) {
  const stored = await listPersonalEntries(userId, 300);
  const sharedStored = await listSharedEntries(userId, null, 300);
  const byKey = new Map();
  // Personal wins on a tie; shared fills in memories that only live in an
  // Our Story scope, which previously always read back as "pending".
  for (const e of sharedStored) byKey.set(e.sourceKey, e);
  for (const e of stored) byKey.set(e.sourceKey, e);
  const out = [];
  for (const candidate of (Array.isArray(entries) ? entries.slice(0, 500) : [])) {
    const sourceKey = String(candidate?.sourceKey || "");
    if (!sourceKey) continue;
    const match = byKey.get(sourceKey);
    if (!match) {
      out.push({ sourceKey, state: "pending" });
      continue;
    }
    // Confirmed means the server has at least as much watch time as the
    // client does; otherwise the client still holds unsent progress.
    const clientSec = Math.max(0, Number(candidate.watchDurationSec) || 0);
    const behind = clientSec > (Number(match.watchDurationSec) || 0) + 1;
    out.push({ sourceKey, state: behind ? "pending" : "synced", id: match.id });
  }
  return { entries: out, reconciledAt: now(), storedCount: stored.length, sharedCount: sharedStored.length };
}

// Archive/restore or remove specific entries the user owns. Archiving keeps
// the memory and only hides it from the default timeline.
async function setEntriesArchived(userId, entryIds, archived) {
  const ids = (Array.isArray(entryIds) ? entryIds : []).map(String).filter(Boolean).slice(0, 500);
  if (!ids.length) return { entries: [] };
  const sb = getSupabaseAdmin();
  const { data, error } = await sb.from("scrapbook_entries")
    .update({ archived_at: archived ? now() : null, updated_at: now() })
    .eq("user_id", userId)
    .in("id", ids)
    .select("*");
  if (error) throw error;
  return { entries: (data || []).map(rowToEntry) };
}

async function removeEntries(userId, entryIds) {
  const ids = (Array.isArray(entryIds) ? entryIds : []).map(String).filter(Boolean).slice(0, 500);
  if (!ids.length) return { removed: 0 };
  const sb = getSupabaseAdmin();
  const { error } = await sb.from("scrapbook_entries").delete().eq("user_id", userId).in("id", ids);
  if (error) throw error;
  return { removed: ids.length };
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
  getRelationById,
  relationView,
  listUserRelations,
  getActiveRelationRow,
  closeRelation,
  reconcileEntries,
  setEntriesArchived,
  removeEntries,
  listPersonalEntries,
  listSharedEntries,
  upsertEntry,
  createInvite,
  listInvites,
  respondInvite,
  getHighlights,
  rowToInvite
};
