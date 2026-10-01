const crypto = require("crypto");
const { AsyncLocalStorage } = require("async_hooks");
const { getSupabaseAdmin } = require("./supabase");
const { publicUser } = require("./auth-store");

function id(prefix = "id") {
  return `${prefix}_${crypto.randomBytes(9).toString("hex")}`;
}

function now() { return Date.now(); }

const TMDB_IMG_RE = /image[.]tmdb[.]org[/]t[/]p[/]/;
const TMDB_BACKDROP_RE = /image[.]tmdb[.]org[/]t[/]p[/]w1280[/]/;
function tmdbBackdropFrom(list) {
  return Array.isArray(list) ? (list.find(u => typeof u === "string" && TMDB_BACKDROP_RE.test(u)) || null) : null;
}

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
    // Legacy rows (and deployments missing the backdrop column) still carry the
    // TMDB w1280 backdrop inside artwork_candidates.
    backdrop: row.backdrop || tmdbBackdropFrom(row.artwork_candidates) || null,
    artworkCandidates: Array.isArray(row.artwork_candidates) ? row.artwork_candidates : [],
    canonicalTitle: row.canonical_title || row.title,
    platform: row.platform,
    season: positiveIntOrNull(row.season),
    episode: positiveIntOrNull(row.episode),
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

const CONTENT_TYPES = ["movie","series","anime","manual"];

// --- artwork provenance -----------------------------------------------------
// TMDB artwork is canonical. Page-derived images (og:image, site art) may only
// fill an EMPTY slot or replace other non-TMDB art; they can never override
// TMDB artwork, and TMDB art always heals a previously stored page image.
function isTmdbUrl(u) { return TMDB_IMG_RE.test(String(u || "")); }
function safeImageUrl(u) {
  const v = String(u == null ? "" : u).trim();
  return /^https?:[/][/]/i.test(v) && v.length <= 2000 ? v : null;
}
function pickArt(incoming, existing) {
  const next = safeImageUrl(incoming);
  const old = safeImageUrl(existing);
  if (!next) return old;
  if (!old) return next;
  if (isTmdbUrl(old) && !isTmdbUrl(next)) return old;
  return next;
}
function pickCandidates(incoming, existing) {
  const next = (Array.isArray(incoming) ? incoming : []).map(safeImageUrl).filter(Boolean).slice(0, 8);
  const old = (Array.isArray(existing) ? existing : []).map(safeImageUrl).filter(Boolean);
  if (!next.length) return old;
  if (old.some(isTmdbUrl) && !next.some(isTmdbUrl)) return old;
  return next;
}
// Integer columns (bigint/integer) reject fractional values outright.
function toInt(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.round(n) : 0; }

function normalizeEntry(entry, existing = null) {
  const t = now();
  const art = pickArt(entry.artwork || entry.thumbnail, existing?.artwork || existing?.thumbnail);
  return {
    source_key: String(entry.sourceKey || existing?.source_key || "").slice(0, 180),
    title: String(entry.title || existing?.title || "Untitled").slice(0, 240),
    // "manual" is a Manual Memory kept with /keep. It is a first-class type
    // so manually kept content is never mislabelled as movie/series/anime.
    kind: CONTENT_TYPES.includes(entry.contentType || entry.kind) ? (entry.contentType || entry.kind) : (existing?.kind || "movie"),
    content_type: CONTENT_TYPES.includes(entry.contentType || entry.kind) ? (entry.contentType || entry.kind) : (existing?.content_type || existing?.kind || "movie"),
    canonical_title: String(entry.canonicalTitle || existing?.canonical_title || entry.title || existing?.title || "Untitled").slice(0,240),
    artwork: art,
    backdrop: pickArt(entry.backdrop, existing?.backdrop),
    artwork_candidates: pickCandidates(entry.artworkCandidates, existing?.artwork_candidates),
    thumbnail: art,
    platform: String(entry.platform || existing?.platform || "").slice(0, 80),
    // entry.season/episode arrive as null for movies; Number(null) is 0 and
    // Number.isFinite(0) is true, so guard against null explicitly or every
    // movie would be written as "season 0".
    // Only a positive integer is a real season/episode. Refusing to carry a
    // legacy 0 forward from `existing` also heals rows already poisoned with
    // 0 on their next save.
    season: positiveIntOrNull(entry.season) ?? positiveIntOrNull(existing?.season),
    episode: positiveIntOrNull(entry.episode) ?? positiveIntOrNull(existing?.episode),
    // Never overwrite a known episode name with null: a later save from a
    // page without JSON-LD must not erase a title we already resolved.
    episode_title: entry.episodeTitle ? String(entry.episodeTitle).slice(0, 240) : (existing?.episode_title ?? null),
    progress: Math.max(0, Math.min(1, Number(entry.progress) || Number(existing?.progress || 0))),
    status: ["completed", "watching", "paused"].includes(entry.status) ? entry.status : (existing?.status || "watching"),
    watch_duration_sec: toInt(existing
      ? Number(existing.watch_duration_sec || 0) + (Number(entry.watchDurationDeltaSec) || 0)
      : (Number(entry.watchDurationDeltaSec) || Number(entry.watchDurationSec) || 0)),
    // Same delta-accumulation pattern as watch_duration_sec, kept as an
    // entirely separate column — see sampleTogether() in
    // scrapbook-collector.js for exactly what this counts.
    together_duration_sec: toInt(existing
      ? Number(existing.together_duration_sec || 0) + (Number(entry.togetherDurationDeltaSec) || 0)
      : (Number(entry.togetherDurationDeltaSec) || Number(entry.togetherDurationSec) || 0)),
    session_count: toInt(Number(existing?.session_count || 0) + (Number(entry.sessionCountDelta) || 0)) || 1,
    // Earliest non-null wins — a later re-watch reaching 'completed' again
    // must not overwrite the original completion date.
    completed_at: existing?.completed_at != null ? existing.completed_at : (Number(entry.completedAt) > 0 ? Math.round(Number(entry.completedAt)) : null),
    metadata_provider: String(entry.metadataProvider || existing?.metadata_provider || "").slice(0,40),
    metadata_id: String(entry.metadataId || existing?.metadata_id || "").slice(0,80),
    metadata_year: Number(entry.metadataYear) > 0 ? Math.round(Number(entry.metadataYear)) : (existing?.metadata_year ?? null),
    story_total_episodes: toInt(Number(entry.storyTotalEpisodes) || Number(existing?.story_total_episodes || 0)),
    story_episodes_completed: toInt(Number(entry.storyEpisodesCompleted) || Number(existing?.story_episodes_completed || 0)),
    story_progress: entry.storyProgress == null ? (existing?.story_progress ?? null) : Math.max(0, Math.min(1, Number(entry.storyProgress))),
    story_progress_confidence: entry.storyProgressConfidence == null ? (existing?.story_progress_confidence ?? null) : Math.max(0, Math.min(1, Number(entry.storyProgressConfidence))),
    series_episode_counts: entry.seriesEpisodeCounts && typeof entry.seriesEpisodeCounts === "object" ? entry.seriesEpisodeCounts : (existing?.series_episode_counts || null),
    first_watched_at: Math.round(Math.min(Number(existing?.first_watched_at || 0) || Number(entry.firstWatchedAt) || t, Number(entry.firstWatchedAt) || t)),
    last_watched_at: Math.round(Math.max(Number(existing?.last_watched_at || 0), Number(entry.lastWatchedAt) || t)),
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
// A season/episode number is meaningful only as a POSITIVE integer. 0, "",
// NaN and negatives all mean "unknown" and must be stored/returned as NULL.
// Number(null) is 0 and Number.isFinite(0) is true, which is how unknown
// episodes ended up persisted and rendered as "S0 E0".
function positiveIntOrNull(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && Math.trunc(n) > 0 ? Math.trunc(n) : null;
}

const RELATION_COLUMNS = "id,user1_id,user2_id,created_at,accepted_at,archived_at,ended_at";

// The single source of truth for "is this story the ONE active story?".
// Active === accepted AND not archived AND not ended. Everything else is
// history: still readable, never blocking a new story.
function isActiveRelationRow(row) {
  return !!(row && row.accepted_at && row.archived_at == null && row.ended_at == null);
}

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
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const sourceKey = String(entry.sourceKey || "").slice(0, 180);
  if (!sourceKey) return null;
  if (sharedRelationId && v2Enabled()) return legacySharedSave(userId, sharedRelationId, { ...entry, sourceKey });
  // Rollout safety (v2): an old-format personal save must follow the journey
  // generation rules. A removed / purged (tombstoned) generation is never
  // written again - the save lands in a fresh generation instead of
  // resurrecting what the person deleted.
  let scope = sharedRelationId ? `shared:${sharedRelationId}` : "personal";
  if (!sharedRelationId && v2Enabled()) {
    scope = personalScope(await currentGeneration(personalSpace(userId), journeyKeyOf({ ...entry, sourceKey })));
  }
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
  // Only an ACTIVE story short-circuits the invitation. Previously any
  // accepted row did, including one that had already been ended/archived:
  // "Start Our Story" then returned the dead relation as if it were live, so
  // the pair could never start a new story with each other and the UI kept
  // showing the old story as active. An ended story must be re-invited like
  // any other, and accepting revives it as a new chapter (see respondInvite).
  if (isActiveRelationRow(relation)) return { relation: await relationView(relation) };
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
    if (relation) await startChapter(null, relation);
  } else if (!isActiveRelationRow(relation)) {
    const before = relation;
    // Re-accepting after an end/archive starts a NEW chapter on the same
    // relation row: archived_at/ended_at are cleared so the story is active
    // again, while every shared memory already attached to it is preserved.
    const { data, error } = await sb.from("relations")
      .update({ accepted_at: relation.accepted_at || respondedAt, archived_at: null, ended_at: null })
      .eq("id", relation.id).select("*").maybeSingle();
    if (error) throw error;
    relation = data;
    // A restart is a NEW Story Chapter; the closed one is never reopened.
    await startChapter(before, relation);
  } else {
    await ensureChapters(relation);
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
  return (data || []).find(isActiveRelationRow) || null;
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
  await closeOpenChapter(row, userId, mode, t);

  // Any still-pending invitation tied to this pair is stale once the story is
  // closed; leaving it pending would block a fresh Our Story later.
  const { error: inviteError } = await sb.from("invites")
    .update({ status: "declined", responded_at: t })
    .eq("status", "pending")
    .or(`and(from_user_id.eq.${row.user1_id},to_user_id.eq.${row.user2_id}),and(from_user_id.eq.${row.user2_id},to_user_id.eq.${row.user1_id})`);
  if (inviteError) throw inviteError;

  return { relation: await relationView(data || { ...row, ...patch }) };
}

// Unarchive ( = reopen ) a story the user archived or ended. Non-destructive
// and symmetric with closeRelation(): it clears the archive/end stamps so the
// story becomes the active one again. Refused when either side already has a
// DIFFERENT active story, which keeps the "one active Our Story" rule true.
async function reopenRelation(relationId, userId) {
  const sb = getSupabaseAdmin();
  const { data: row, error: findError } = await sb.from("relations")
    .select(RELATION_COLUMNS).eq("id", String(relationId)).maybeSingle();
  if (findError) throw findError;
  if (!row) return { error: "That story no longer exists." };
  if (![row.user1_id, row.user2_id].includes(String(userId))) return { error: "You are not part of this story." };
  if (isActiveRelationRow(row)) return { relation: await relationView(row) };
  if (!row.accepted_at) return { error: "That story was never accepted." };

  const [mine, theirs] = await Promise.all([
    getActiveRelationRow(row.user1_id),
    getActiveRelationRow(row.user2_id)
  ]);
  const blocking = [mine, theirs].find(r => r && String(r.id) !== String(row.id));
  if (blocking) return { error: "One of you already has an active Our Story. End it first." };

  const { data, error } = await sb.from("relations")
    .update({ archived_at: null, ended_at: null })
    .eq("id", row.id).select(RELATION_COLUMNS).maybeSingle();
  if (error) throw error;
  await startChapter(row, data || { ...row, archived_at: null, ended_at: null });
  return { relation: await relationView(data || { ...row, archived_at: null, ended_at: null }) };
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
  if (v2Enabled()) {
    const chapters = await chaptersForUser(userId);
    for (const c of chapters) for (const e of (await listSharedV2(userId, { chapterId: c.id, includeHidden: true })).entries) if (!byKey.has(e.sourceKey)) byKey.set(e.sourceKey, e);
  }
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
  const { data, error } = await sb.from("scrapbook_entries").select("*").eq("user_id", userId).in("id", ids);
  if (error) throw error;
  if (!v2Enabled()) {
    // v1 (v2 OFF): the caller's own personal rows are removed from the v1
    // table the v1 list reads. Never touches v2 journey state.
    const own = (data || []).filter(r => r.scope === "personal").map(r => r.id);
    if (own.length) { const { error: de } = await sb.from("scrapbook_entries").delete().eq("user_id", userId).eq("scope", "personal").in("id", own); if (de) throw de; }
    return { removed: own.length, soft: false };
  }
  const keys = [...new Set((data || []).filter(r => scopeGeneration(r.scope) != null).map(r => journeyKeyOf(rowToEntry(r))))];
  for (const journeyKey of keys) await journeyAction(userId, { space: "personal", journeyKey, action: "remove" });
  return { removed: (data || []).length, soft: true };
}

async function getHighlights(userId) {
  const entries = v2Enabled() ? await listPersonalV2(userId, { includeArchived: true }) : await listPersonalEntries(userId, 300, true);
  const totalSec = entries.reduce((n, e) => n + (e.watchDurationSec || 0), 0);
  return {
    totalEntries: entries.length,
    totalHours: Math.round(totalSec / 3600 * 10) / 10,
    completed: entries.filter(e => e.status === "completed").length,
    moments: await buildMoments(userId)
  };
}

// ===========================================================================
// Scrapbook v2: Story Chapters, server-decided sittings, idempotent ledger,
// journey state (display title / archive / remove), Moments, maintenance.
// ===========================================================================
// Identity rules (unchanged from v1): an episode is identified by its
// source_key exactly as the collector builds it; a journey is grouped by the
// SAME key the Scrapbook page uses (canonicalTitle || title, trimmed,
// lower-cased, whitespace collapsed). display_title is presentation only and
// is never read by any of the functions below that compute keys or ids.
const V2 = {
  SITTING_GAP_MS: 30 * 60 * 1000,
  INTENT_FRESH_MS: 20 * 1000,
  CLOSED_CHAPTER_GRACE_MS: 6 * 3600 * 1000,
  REMOVAL_REQUEST_TTL_MS: 14 * 86400000,
  REMOVAL_COOLDOWN_MS: 30 * 86400000,
  RESTORE_WINDOW_MS: 30 * 86400000,
  LEDGER_COMPACT_MS: 90 * 86400000,
  LEASE_MS: 10 * 60 * 1000
};
// OFF until the v2 client (sitting saves) ships: the current extension still
// sends v1 dual personal+shared saves. Set SCRAPBOOK_SHARED_V2=1 to enable.
function v2Enabled() { return String(process.env.SCRAPBOOK_SHARED_V2 ?? "0") === "1"; }
// Hard server-side kill switch. With v2 OFF no v2-only entry point reads or
// writes v2 storage, so a client still mid-sitting after an ON -> OFF flip is
// refused (503, retryable: the client keeps its envelope in its separate v2
// backup) and is never re-routed into the v1 tables.
const V2_DISABLED_ERROR = "Shared Scrapbook v2 is disabled on this server.";
function v2Disabled() { return { status: 503, code: "SCRAPBOOK_V2_DISABLED", error: V2_DISABLED_ERROR, v2Disabled: true }; }

const v2Locks = new Map();
// Cross-instance mutual exclusion WITH FENCING. The in-process queue orders
// work inside one Node process; when v2 is on, the same key is ALSO held as a
// row in public.scrapbook_locks (sp_scrapbook_lock_acquire: insert, or take
// over an EXPIRED lease, in one statement) and every acquisition returns a
// strictly increasing fence number. The fences held by the current async
// call chain travel with every critical write (p_fences): the database
// rejects the write with SP_FENCED if the lease expired and moved to another
// worker meanwhile, so a paused/slow worker can never commit a stale
// decision, save, journey change or purge. The lease is renewed while the
// work runs and released by holder+fence. Correctness does not rest on the
// lease alone: every transition is an atomic, self-validating DB function
// (supabase-schema.sql 9.8).
const LOCK_TTL_MS = Math.max(50, Number(process.env.SCRAPBOOK_LOCK_TTL_MS) || 15000);
const LOCK_WAIT_MS = Math.max(50, Number(process.env.SCRAPBOOK_LOCK_WAIT_MS) || 10000);
// Test-only hooks (never set in production): beforeRpc(name, params) runs
// before each fenced write; renew=false stops lease renewal (simulates a
// stalled worker whose lease expires).
const testHooks = { beforeRpc: null, renew: true };
const leaseCtx = new AsyncLocalStorage();
function heldFences() {
  const held = leaseCtx.getStore();
  return held && held.length ? held.map(l => ({ k: l.key, f: l.fence })) : null;
}
function dbLocksEnabled() { return v2Enabled() && String(process.env.SCRAPBOOK_DB_LOCKS ?? "1") !== "0"; }
const sleep = ms => new Promise(r => setTimeout(r, ms));
function rpcMissing(error) { return !!error && ["PGRST202", "42883", "PGRST204"].includes(String(error.code || "")); }
function schemaError(name) {
  const e = new Error(`Scrapbook v2 needs ${name}() - apply supabase-schema.sql sections 9.7-9.8.`);
  e.status = 503; e.code = "SP_SCHEMA_MISSING"; return e;
}
// Calls a 9.7/9.8 function. Scrapbook v2 fails CLOSED without them: there is
// no unguarded read-modify-write fallback any more.
async function rpcRequired(name, params) {
  const sb = sbx();
  if (typeof sb.rpc !== "function") throw schemaError(name);
  const { data, error } = await sb.rpc(name, params);
  if (!error) return data;
  if (rpcMissing(error)) { console.warn(`[SyncParty Scrapbook] ${name}() missing - apply supabase-schema.sql 9.7-9.8.`); throw schemaError(name); }
  const msg = String(error.message || "");
  if (error.code === "SPF01" || msg.includes("SP_FENCED")) {
    const e = new Error("Scrapbook lock moved to another server; try again."); e.status = 503; e.code = "SP_FENCED"; throw e;
  }
  const e = new Error(msg || "Scrapbook database error");
  e.code = error.code; e.dbError = error;
  if (["SPV01", "SPC01", "SPR01"].includes(String(error.code))) e.status = 409;
  throw e;
}
// A critical write: carries the fences of every lock this call chain holds.
async function fencedRpc(name, params) {
  if (testHooks.beforeRpc) await testHooks.beforeRpc(name, params);
  return rpcRequired(name, { ...params, p_fences: heldFences() });
}
async function acquireDbLock(key) {
  const holder = id("lk");
  const deadline = Date.now() + LOCK_WAIT_MS;
  let fence = null;
  for (let attempt = 0; ; attempt++) {
    fence = await rpcRequired("sp_scrapbook_lock_acquire", { p_key: key, p_holder: holder, p_ttl_ms: LOCK_TTL_MS });
    if (fence != null) break;
    if (Date.now() > deadline) { const e = new Error("Scrapbook is busy, try again."); e.status = 503; e.code = "SP_LOCK_TIMEOUT"; throw e; }
    await sleep(Math.min(100, 4 + attempt * 6) + Math.floor(Math.random() * 8));
  }
  const lease = { key, holder, fence: Number(fence), timer: null, lost: false };
  lease.timer = setInterval(() => {
    if (!testHooks.renew) return;
    rpcRequired("sp_scrapbook_lock_renew", { p_key: key, p_holder: holder, p_fence: lease.fence, p_ttl_ms: LOCK_TTL_MS })
      .then(ok => { if (ok === false) lease.lost = true; }, () => {});
  }, Math.max(10, Math.floor(LOCK_TTL_MS / 3)));
  lease.timer.unref?.();
  return lease;
}
async function releaseDbLock(lease) {
  clearInterval(lease.timer);
  try { await rpcRequired("sp_scrapbook_lock_release", { p_key: lease.key, p_holder: lease.holder, p_fence: lease.fence }); } catch {}
}
async function withLock(key, fn) {
  const prev = v2Locks.get(key) || Promise.resolve();
  let release;
  const gate = new Promise(r => { release = r; });
  const tail = prev.then(() => gate);
  v2Locks.set(key, tail);
  await prev;
  let lease = null;
  try {
    if (dbLocksEnabled()) lease = await acquireDbLock(key);
    if (!lease) return await fn();
    return await leaseCtx.run([...(leaseCtx.getStore() || []), lease], fn);
  } finally {
    if (lease) await releaseDbLock(lease);
    release(); if (v2Locks.get(key) === tail) v2Locks.delete(key);
  }
}

// totals += deltas, clamped at zero, as ONE statement (9.7). Used only for
// the legacy (pre-v2 client) shared save and last-watched "touch" updates.
async function bumpTotals(table, rowId, d, t = now()) {
  const dw = Math.round(Number(d.watch) || 0), dt = Math.round(Number(d.together) || 0), ds = Math.round(Number(d.sessions) || 0);
  if (!dw && !dt && !ds && !d.touch) return;
  await rpcRequired("sp_scrapbook_bump_totals", { p_table: table, p_id: String(rowId), p_watch: dw, p_together: dt, p_sessions: ds, p_at: t });
}
// Both partners' decisions + their co-sitting in ONE transaction: both are
// written or neither is. The database verifies the two users ARE the
// chapter's Story partner pair, each sitting is that user's recorded intent
// and the chapter is still open. Returns true when this call wrote them.
async function writePairDecision(co, own, partner) {
  const t = now();
  const full = r => ({ decided_at: t, last_active_at: t, reason: "co_watch", ...r });
  try {
    const v = await fencedRpc("sp_scrapbook_decide_pair", { p_co: co, p_first: full(partner), p_second: full(own) });
    return v === true || !!(v && v.applied === true);
  } catch (e) {
    if (["SPV01", "SPC01"].includes(String(e.code))) return false;
    throw e;
  }
}
function coSittingId(chapterId, a, b) {
  return "cos_" + crypto.createHash("sha256").update(`${chapterId}|${[String(a), String(b)].sort().join("|")}`).digest("hex").slice(0, 32);
}

async function q(promise) {
  const { data, error } = await promise;
  if (error) throw error;
  return data;
}
function sbx() { return getSupabaseAdmin(); }

function journeyKeyOf(e) {
  return String((e && (e.canonicalTitle || e.canonical_title || e.title)) || "").trim().toLowerCase().replace(/\s+/g, " ");
}
function normJourneyKey(k) { return String(k || "").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 240); }
function personalSpace(userId) { return `u:${userId}`; }
function chapterSpace(chapterId) { return `c:${chapterId}`; }
function personalScope(gen) { return Number(gen) > 1 ? `personal:v${Number(gen)}` : "personal"; }
function scopeGeneration(scope) {
  if (scope === "personal") return 1;
  const m = /^personal:v(\d+)$/.exec(String(scope || ""));
  return m ? Number(m[1]) : null;
}

// ---------------------------------------------------------------- chapters
function chapterView(c) {
  if (!c) return null;
  return {
    id: c.id,
    relationId: c.relation_id,
    chapterNo: Number(c.chapter_no),
    startedAt: Number(c.started_at),
    endedAt: c.ended_at == null ? null : Number(c.ended_at),
    endMode: c.end_mode || null,
    legacy: !!c.legacy,
    readOnly: c.ended_at != null
  };
}
async function listChapterRows(relationId) {
  const rows = await q(sbx().from("story_chapters").select("*").eq("relation_id", String(relationId)));
  return (rows || []).sort((a, b) => Number(a.chapter_no) - Number(b.chapter_no));
}
async function getChapterRow(chapterId) {
  return q(sbx().from("story_chapters").select("*").eq("id", String(chapterId)).maybeSingle());
}
async function insertChapter(relationId, { legacy = false, startedAt, endedAt = null, endMode = null, endedBy = null }) {
  const list = await listChapterRows(relationId);
  const no = list.reduce((m, c) => Math.max(m, Number(c.chapter_no)), 0) + 1;
  const row = {
    id: id("chap"), relation_id: String(relationId), chapter_no: no,
    started_at: Math.round(Number(startedAt) || now()), ended_at: endedAt == null ? null : Math.round(Number(endedAt)),
    end_mode: endMode, ended_by: endedBy, legacy: !!legacy, created_at: now()
  };
  const { data, error } = await sbx().from("story_chapters").insert(row).select("*").maybeSingle();
  if (error && error.code !== "23505") throw error;
  if (data) return data;
  // Lost an insert race (another instance): the chapter number or the one
  // open chapter already exists - return what is stored, never a guess.
  const after = await listChapterRows(relationId);
  return (endedAt == null ? after.find(c => c.ended_at == null) : null) || after.find(c => Number(c.chapter_no) === no) || null;
}
// Relations that predate chapters receive ONE legacy chapter covering their
// whole earlier history (it cannot be split retroactively).
async function ensureChaptersUnlocked(rel) {
  let list = await listChapterRows(rel.id);
  if (!list.length && rel.accepted_at) {
    const active = isActiveRelationRow(rel);
    await insertChapter(rel.id, {
      legacy: true,
      startedAt: Number(rel.accepted_at || rel.created_at || now()),
      endedAt: active ? null : Number(rel.ended_at || rel.archived_at || now()),
      endMode: active ? null : (rel.ended_at != null ? "end" : "archive")
    });
    list = await listChapterRows(rel.id);
  }
  return list;
}
async function ensureChapters(rel) { return withLock(`rel:${rel.id}`, () => ensureChaptersUnlocked(rel)); }

// Called when a Story starts or restarts. prevRow is the relation as it was
// BEFORE activation (null for a brand-new relation). Never touches a closed
// chapter: a restart always inserts a new chapter id.
async function startChapter(prevRow, activeRow) {
  return withLock(`rel:${activeRow.id}`, async () => {
    let list = prevRow ? await ensureChaptersUnlocked(prevRow) : await listChapterRows(activeRow.id);
    const open = list.find(c => c.ended_at == null);
    if (open) return open;
    // Opened while v2 is OFF => its shared watches are v1 rows: flag it legacy
    // so they stay readable (and backfillable) once v2 is turned ON.
    return insertChapter(activeRow.id, { legacy: !v2Enabled(), startedAt: now() });
  });
}

async function cancelPendingRequests(space, t) {
  const rows = await q(sbx().from("journey_state").select("*").eq("space", space).eq("removal_state", "requested"));
  for (const r of rows || []) {
    await q(sbx().from("journey_state").update({ removal_state: "none", removal_requested_by: null, removal_requested_at: null, updated_at: t }).eq("id", r.id));
  }
}

// Closes the open chapter of a relation that is being ended/archived. This is
// the ONLY update ever applied to a chapter row, and it only matches rows
// whose ended_at is still null.
async function closeOpenChapter(relBefore, userId, mode, t) {
  return withLock(`rel:${relBefore.id}`, async () => {
    const list = await ensureChaptersUnlocked({ ...relBefore, archived_at: null, ended_at: null });
    const open = list.find(c => c.ended_at == null);
    if (!open) return null;
    await cancelPendingRequests(chapterSpace(open.id), t);
    await q(sbx().from("story_chapters").update({ ended_at: t, end_mode: mode === "archive" ? "archive" : "end", ended_by: String(userId) })
      .eq("id", open.id).is("ended_at", null));
    return getChapterRow(open.id);
  });
}

async function rawUserRelations(userId) {
  return (await q(sbx().from("relations").select(RELATION_COLUMNS).or(`user1_id.eq.${userId},user2_id.eq.${userId}`))) || [];
}
function partnerOf(rel, userId) { return String(rel.user1_id) === String(userId) ? rel.user2_id : rel.user1_id; }

async function activeChapterForUser(userId) {
  const rel = await getActiveRelationRow(userId);
  if (!rel) return null;
  const list = await ensureChapters(rel);
  let chapter = list.find(c => c.ended_at == null);
  if (!chapter) chapter = await startChapter(null, rel);
  return { chapter, relation: rel, partnerId: partnerOf(rel, userId) };
}

async function chaptersForUser(userId) {
  if (!v2Enabled()) return [];
  const rels = (await rawUserRelations(userId)).filter(r => r.accepted_at);
  const out = [];
  for (const rel of rels) {
    const list = await ensureChapters(rel);
    const partner = await getUser(partnerOf(rel, userId)).catch(() => null);
    for (const c of list) out.push({ ...chapterView(c), partner: partner ? publicUser(partner) : null, relationActive: isActiveRelationRow(rel) });
  }
  return out.sort((a, b) => (b.endedAt == null) - (a.endedAt == null) || b.startedAt - a.startedAt);
}

async function userInChapter(userId, chapter) {
  if (!chapter) return false;
  const rel = await getRelationById(chapter.relation_id);
  return !!(rel && [rel.user1_id, rel.user2_id].map(String).includes(String(userId)));
}

// ----------------------------------------------------------- journey state
async function journeyStateRows(space, journeyKey = null) {
  let query = sbx().from("journey_state").select("*").eq("space", space);
  if (journeyKey != null) query = query.eq("journey_key", journeyKey);
  return (await q(query)) || [];
}
function latestState(rows, jk) {
  return rows.filter(r => r.journey_key === jk).sort((a, b) => Number(b.generation) - Number(a.generation))[0] || null;
}
async function getOrCreateState(space, jk, gen) {
  const found = (await journeyStateRows(space, jk)).find(r => Number(r.generation) === Number(gen));
  if (found) return found;
  const row = { id: id("jst"), space, journey_key: jk, generation: Number(gen), removal_state: "none", updated_at: now() };
  const { data, error } = await sbx().from("journey_state").insert(row).select("*").maybeSingle();
  if (error && error.code !== "23505") throw error;
  return data || (await journeyStateRows(space, jk)).find(r => Number(r.generation) === Number(gen));
}
// The generation new saves go to. A removed generation is never written to
// again: the next viewing starts generation + 1.
async function currentGeneration(space, jk) {
  const latest = latestState(await journeyStateRows(space, jk), jk);
  if (!latest) return 1;
  if (latest.removed_at == null) return Number(latest.generation);
  const next = Number(latest.generation) + 1;
  await getOrCreateState(space, jk, next);
  return next;
}
function effectiveRemoval(st, t = now()) {
  if (!st) return { state: "none" };
  if (st.removal_state === "requested") {
    const at = Number(st.removal_requested_at || 0);
    if (t - at > V2.REMOVAL_REQUEST_TTL_MS) return { state: "expired", blockedUntil: at + V2.REMOVAL_REQUEST_TTL_MS + V2.REMOVAL_COOLDOWN_MS };
    return { state: "requested", requestedBy: st.removal_requested_by, requestedAt: at, expiresAt: at + V2.REMOVAL_REQUEST_TTL_MS };
  }
  return { state: "none", blockedUntil: st.removal_blocked_until == null ? null : Number(st.removal_blocked_until) };
}
function stateView(st, t = now()) {
  if (!st) return null;
  const r = effectiveRemoval(st, t);
  return {
    journeyKey: st.journey_key, generation: Number(st.generation),
    displayTitle: st.display_title || null, titleEditedBy: st.title_edited_by || null,
    archivedAt: st.archived_at == null ? null : Number(st.archived_at),
    removedAt: st.removed_at == null ? null : Number(st.removed_at),
    removedBy: st.removed_by || null,
    purgeAfter: st.purge_after == null ? null : Number(st.purge_after),
    removal: r.state === "requested" ? r : { state: "none", blockedUntil: r.blockedUntil && r.blockedUntil > t ? r.blockedUntil : null }
  };
}
async function logEvent(space, jk, actorId, kind, payload = {}) {
  await q(sbx().from("memory_events").insert({ id: id("evt"), space, journey_key: jk, actor_id: actorId ? String(actorId) : null, kind, payload, at: now() }));
}

// ------------------------------------------------------------ targets
const TOTAL_COLS = ["watch_duration_sec", "together_duration_sec", "session_count"];
function identityPatch(entry, existing) {
  const p = normalizeEntry({ ...entry, watchDurationDeltaSec: 0, watchDurationSec: 0, togetherDurationDeltaSec: 0, togetherDurationSec: 0, sessionCountDelta: 0 }, existing);
  for (const c of TOTAL_COLS) delete p[c];
  return p;
}

async function ensurePersonalRow(userId, entry, sourceKey) {
  const jk = journeyKeyOf(entry);
  const gen = await currentGeneration(personalSpace(userId), jk);
  const scope = personalScope(gen);
  const existing = await q(sbx().from("scrapbook_entries").select("*").eq("user_id", userId).eq("scope", scope).eq("source_key", sourceKey).maybeSingle());
  if (existing) {
    return q(sbx().from("scrapbook_entries").update(identityPatch({ ...entry, sourceKey }, existing)).eq("id", existing.id).select("*").maybeSingle());
  }
  const row = { id: id("entry"), user_id: userId, scope, relation_id: null, ...identityPatch({ ...entry, sourceKey }, null), watch_duration_sec: 0, together_duration_sec: 0, session_count: 0, created_at: now() };
  const { data, error } = await sbx().from("scrapbook_entries").insert(row).select("*").maybeSingle();
  if (error) {
    if (error.code === "23505") return q(sbx().from("scrapbook_entries").select("*").eq("user_id", userId).eq("scope", scope).eq("source_key", sourceKey).maybeSingle());
    throw error;
  }
  return data;
}

async function getMemory(memoryId) { return q(sbx().from("shared_memories").select("*").eq("id", String(memoryId)).maybeSingle()); }
async function ensureSharedMemory(chapterId, entry, sourceKey) {
  const jk = journeyKeyOf(entry);
  const gen = await currentGeneration(chapterSpace(chapterId), jk);
  const find = () => q(sbx().from("shared_memories").select("*").eq("chapter_id", chapterId).eq("source_key", sourceKey).eq("journey_version", gen).maybeSingle());
  const t = now();
  const mem = await find();
  if (mem) {
    const patch = identityPatch({ ...entry, sourceKey }, mem.entry || null);
    return q(sbx().from("shared_memories").update({ entry: { ...(mem.entry || {}), ...patch }, completed_at: mem.completed_at ?? patch.completed_at ?? null, last_watched_at: Math.max(Number(mem.last_watched_at || 0), t), updated_at: t }).eq("id", mem.id).select("*").maybeSingle());
  }
  const patch = identityPatch({ ...entry, sourceKey }, null);
  const row = { id: id("mem"), chapter_id: chapterId, source_key: sourceKey, journey_key: jk, journey_version: gen, entry: patch, together_sec: 0, session_count: 0, first_watched_at: patch.first_watched_at || t, last_watched_at: t, completed_at: patch.completed_at ?? null, legacy: false, created_at: t, updated_at: t };
  const { data, error } = await sbx().from("shared_memories").insert(row).select("*").maybeSingle();
  if (error) { if (error.code === "23505") return find(); throw error; }
  return data;
}
async function ensureMember(memoryId, userId) {
  const find = () => q(sbx().from("shared_memory_members").select("*").eq("memory_id", memoryId).eq("user_id", userId).maybeSingle());
  const m = await find();
  if (m) return m;
  const t = now();
  const { data, error } = await sbx().from("shared_memory_members").insert({ id: id("mm"), memory_id: memoryId, user_id: userId, watch_sec: 0, together_sec: 0, session_count: 0, first_watched_at: t, last_watched_at: t, updated_at: t }).select("*").maybeSingle();
  if (error) { if (error.code === "23505") return find(); throw error; }
  return data;
}

// Is the generation a target belongs to removed?
async function targetRemoved(destination, target) {
  if (!target) return true;
  if (destination === "SHARED") {
    const st = (await journeyStateRows(chapterSpace(target.chapter_id), target.journey_key)).find(r => Number(r.generation) === Number(target.journey_version));
    return !!(st && st.removed_at != null);
  }
  const gen = scopeGeneration(target.scope) || 1;
  const st = (await journeyStateRows(personalSpace(target.user_id), journeyKeyOf(rowToEntry(target)))).find(r => Number(r.generation) === gen);
  return !!(st && st.removed_at != null);
}

// ------------------------------------------------------------ sittings
function decisionView(d) {
  return d ? { sittingId: d.sitting_id, destination: d.destination, chapterId: d.chapter_id || null, coSittingId: d.co_sitting_id || null, reason: d.reason || null, decidedAt: Number(d.decided_at) } : null;
}
async function getDecision(sittingId) { return q(sbx().from("sitting_decisions").select("*").eq("sitting_id", String(sittingId)).maybeSingle()); }
// Write-once: the first decision stored for a sitting wins forever. The
// database validates a SHARED decision (Story member, open chapter, co-sitting
// of that chapter/episode) and refuses it for anyone else.
async function writeDecision(row) {
  const t = now();
  const full = { decided_at: t, last_active_at: t, chapter_id: null, co_sitting_id: null, ...row };
  await fencedRpc("sp_scrapbook_write_decision", { p_row: full });
  return getDecision(row.sitting_id);
}
function validSittingId(s) { return typeof s === "string" && /^[A-Za-z0-9_-]{8,80}$/.test(s); }

async function recordIntent(userId, { sittingId, sourceKey, roomId = null, playing = false }) {
  if (!v2Enabled()) return v2Disabled();
  if (!validSittingId(sittingId) || !sourceKey) return { status: 400, error: "Invalid sitting." };
  const t = now();
  const sb = sbx();
  const existing = await q(sb.from("sitting_intents").select("*").eq("sitting_id", sittingId).maybeSingle());
  if (existing && String(existing.user_id) !== String(userId)) return { status: 403, error: "Not your sitting." };
  const values = { user_id: String(userId), source_key: String(sourceKey).slice(0, 180), room_id: roomId ? String(roomId).slice(0, 80) : null, playing: !!playing, last_seen_at: t };
  if (existing) await q(sb.from("sitting_intents").update(values).eq("sitting_id", sittingId));
  else {
    const { error } = await sb.from("sitting_intents").insert({ sitting_id: sittingId, first_seen_at: t, ...values });
    if (error && error.code !== "23505") throw error;
  }
  const d = await getDecision(sittingId);
  if (d && String(d.user_id) === String(userId)) await q(sb.from("sitting_decisions").update({ last_active_at: t }).eq("sitting_id", sittingId));
  return { ok: true, decision: decisionView(d) };
}

// Server-authoritative UNDECIDED -> PERSONAL | SHARED, exactly once.
// Rules, in order: (1) an existing decision is returned unchanged; (2) no
// active Story -> PERSONAL; (2b) the same user's other live tab on the same
// episode -> same destination; (3) an open co-sitting the partner belongs to
// -> join it; (4) the partner is already in a PERSONAL sitting of this
// episode -> PERSONAL (late join never converts it); (5) the partner has a
// fresh, playing, undecided intent for the same episode in the same room ->
// both become SHARED in ONE new co-sitting; (6) otherwise PERSONAL.
async function decideSitting(userId, { sittingId, sourceKey, roomId = null }) {
  if (!v2Enabled()) return v2Disabled();
  sourceKey = String(sourceKey || "").slice(0, 180);
  const intent = await recordIntent(userId, { sittingId, sourceKey, roomId, playing: true });
  if (intent.error) return intent;
  let d = await getDecision(sittingId);
  if (d) return String(d.user_id) === String(userId) ? { ok: true, decision: decisionView(d) } : { status: 403, error: "Not your sitting." };
  const ctx = await activeChapterForUser(userId);
  if (!ctx) {
    // Another live tab of the same user on the same episode -> same sitting group.
    const t0 = now();
    const other = ((await q(sbx().from("sitting_decisions").select("*").eq("user_id", String(userId)).eq("source_key", sourceKey))) || [])
      .some(r => r.sitting_id !== sittingId && t0 - Number(r.last_active_at || 0) < V2.SITTING_GAP_MS);
    return { ok: true, decision: decisionView(await writeDecision({ sitting_id: sittingId, user_id: String(userId), source_key: sourceKey, destination: "PERSONAL", reason: other ? "same_user_tab" : "no_story" })) };
  }
  return withLock(`chapter:${ctx.chapter.id}`, async () => {
    d = await getDecision(sittingId);
    if (d) return { ok: true, decision: decisionView(d) };
    const t = now();
    const chapterId = ctx.chapter.id;
    // The database has the final word on SHARED (open chapter, Story member,
    // matching co-sitting); if it refuses (e.g. the Story ended a moment ago)
    // the sitting is PERSONAL.
    const mk = async (destination, reason, coId = null) => {
      try {
        return await writeDecision({ sitting_id: sittingId, user_id: String(userId), source_key: sourceKey, destination, reason, chapter_id: destination === "SHARED" ? chapterId : null, co_sitting_id: coId });
      } catch (e) {
        if (destination !== "SHARED" || !["SPV01", "SPC01"].includes(String(e.code))) throw e;
        return writeDecision({ sitting_id: sittingId, user_id: String(userId), source_key: sourceKey, destination: "PERSONAL", reason: "shared_refused" });
      }
    };
    const recent = rows => (rows || []).filter(r => t - Number(r.last_active_at || 0) < V2.SITTING_GAP_MS).sort((a, b) => Number(b.last_active_at) - Number(a.last_active_at));
    // Only decisions made inside THIS chapter count: a sitting from before a
    // Story ended/restarted never steers a sitting of the new chapter.
    const inChapter = r => r.destination === "SHARED" ? r.chapter_id === chapterId : Number(r.decided_at || 0) >= Number(ctx.chapter.started_at || 0);
    const mine = recent(await q(sbx().from("sitting_decisions").select("*").eq("user_id", String(userId)).eq("source_key", sourceKey))).filter(r => r.sitting_id !== sittingId && inChapter(r));
    if (mine[0]) {
      const same = mine[0].destination === "SHARED" && mine[0].chapter_id === chapterId;
      return { ok: true, decision: decisionView(await mk(same ? "SHARED" : "PERSONAL", "same_user_tab", same ? mine[0].co_sitting_id : null)) };
    }
    const partnerDecs = recent(await q(sbx().from("sitting_decisions").select("*").eq("user_id", String(ctx.partnerId)).eq("source_key", sourceKey))).filter(inChapter);
    const sharedP = partnerDecs.find(r => r.destination === "SHARED" && r.chapter_id === chapterId && r.co_sitting_id);
    if (sharedP) {
      const co = await q(sbx().from("co_sittings").select("*").eq("id", sharedP.co_sitting_id).maybeSingle());
      if (co && t - Number(co.last_active_at || 0) < V2.SITTING_GAP_MS) return { ok: true, decision: decisionView(await mk("SHARED", "join_open_shared", co.id)) };
    }
    if (partnerDecs.some(r => r.destination === "PERSONAL")) return { ok: true, decision: decisionView(await mk("PERSONAL", "partner_personal")) };
    if (roomId) {
      const intents = ((await q(sbx().from("sitting_intents").select("*").eq("user_id", String(ctx.partnerId)).eq("source_key", sourceKey).eq("room_id", String(roomId)))) || [])
        .filter(i => i.playing && t - Number(i.last_seen_at || 0) <= V2.INTENT_FRESH_MS)
        .sort((a, b) => Number(b.last_seen_at) - Number(a.last_seen_at));
      for (const i of intents) {
        if (await getDecision(i.sitting_id)) continue;
        // Deterministic co-sitting id (chapter + both sitting ids): two
        // instances pairing the same two sittings always name the same
        // co-sitting, and the pair of decisions is written atomically.
        const co = { id: coSittingId(chapterId, sittingId, i.sitting_id), chapter_id: chapterId, source_key: sourceKey, opened_at: t, last_active_at: t, applied_together_sec: 0, memory_id: null };
        const base = { source_key: sourceKey, destination: "SHARED", reason: "co_watch", chapter_id: chapterId, co_sitting_id: co.id };
        await writePairDecision(co, { ...base, sitting_id: sittingId, user_id: String(userId) }, { ...base, sitting_id: i.sitting_id, user_id: String(ctx.partnerId) });
        const own = await getDecision(sittingId);
        if (own) return { ok: true, decision: decisionView(own) };
        // Lost the race for the partner's sitting: follow whatever it became.
        const pd = await getDecision(i.sitting_id);
        if (pd && pd.destination === "SHARED" && pd.chapter_id === chapterId && pd.co_sitting_id) return { ok: true, decision: decisionView(await mk("SHARED", "join_open_shared", pd.co_sitting_id)) };
        if (pd && pd.destination === "PERSONAL") return { ok: true, decision: decisionView(await mk("PERSONAL", "partner_personal")) };
        break;
      }
    }
    return { ok: true, decision: decisionView(await mk("PERSONAL", "alone")) };
  });
}

// Multi-tab rule. Each tab is its own sitting (own id, own ledger row). For
// one user on one target, sittings whose server-observed intervals overlap
// form a cluster; a cluster credits min(sum of reported watch, cluster wall
// length) watch time, min(sum together, credited watch) together time and
// exactly ONE session. Two tabs playing at once therefore never double-count
// time or sessions, while back-to-back sittings still add up normally.
function clustersOf(rows) {
  const sorted = [...rows].sort((a, b) => Number(a.interval_start) - Number(b.interval_start));
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && Number(r.interval_start) <= last.end) { last.rows.push(r); last.end = Math.max(last.end, Number(r.interval_end)); }
    else out.push({ start: Number(r.interval_start), end: Number(r.interval_end), rows: [r] });
  }
  return out;
}
function distribute(total, rows, key) {
  const sum = rows.reduce((n, r) => n + Number(r[key] || 0), 0);
  const out = new Map();
  let given = 0;
  rows.forEach((r, i) => {
    const v = i === rows.length - 1 ? total - given : (sum > 0 ? Math.floor(total * Number(r[key] || 0) / sum) : 0);
    out.set(r.sitting_id, Math.max(0, v)); given += Math.max(0, v);
  });
  return out;
}
function unionLengthSec(rows) {
  return clustersOf(rows).reduce((n, c) => n + (c.end - c.start) / 1000, 0);
}

// Each ledger row's credited amounts move by compare-and-set and the totals
// change by exactly that delta in the SAME transaction
// (sp_scrapbook_apply_ledger), so two instances recomputing the same row can
// never both add it and a crash can never leave a CAS without its delta. A
// lost CAS means another writer moved the row: re-read and recompute.
async function recomputeMember(destination, targetId, userId) {
  const t = now();
  const memberId = destination === "SHARED" ? (await ensureMember(targetId, String(userId))).id : null;
  let rows = [];
  for (let attempt = 0; attempt < 6; attempt++) {
    rows = (await q(sbx().from("sitting_ledger").select("*").eq("target_id", targetId).eq("user_id", String(userId)))) || [];
    let lost = false;
    for (const c of clustersOf(rows)) {
      const len = (c.end - c.start) / 1000;
      const sumW = c.rows.reduce((n, r) => n + Number(r.watch_sec_cum || 0), 0);
      const credW = Math.floor(Math.min(sumW, len));
      const sumT = c.rows.reduce((n, r) => n + Number(r.together_sec_cum || 0), 0);
      const credT = Math.floor(Math.min(sumT, credW));
      const w = distribute(credW, c.rows, "watch_sec_cum");
      const tt = distribute(credT, c.rows, "together_sec_cum");
      for (let i = 0; i < c.rows.length; i++) {
        const r = c.rows[i];
        const nw = w.get(r.sitting_id), nt = tt.get(r.sitting_id), ns = i === 0 ? 1 : 0;
        const ow = Number(r.applied_watch_sec || 0), ot = Number(r.applied_together_sec || 0), os = Number(r.applied_sessions || 0);
        if (nw === ow && nt === ot && ns === os) continue;
        const applied = await fencedRpc("sp_scrapbook_apply_ledger", {
          p_sitting_id: r.sitting_id, p_old: { w: ow, t: ot, s: os }, p_new: { w: nw, t: nt, s: ns },
          p_table: destination === "SHARED" ? "shared_memory_members" : "scrapbook_entries", p_bump_id: destination === "SHARED" ? memberId : targetId, p_at: t
        });
        if (applied === true) { r.applied_watch_sec = nw; r.applied_together_sec = nt; r.applied_sessions = ns; }
        else lost = true;
      }
    }
    if (!lost) break;
  }
  if (destination === "SHARED") await bumpTotals("shared_memory_members", memberId, { touch: true }, t);
  return rows;
}

// together(co) = min(max over members of that member's credited together in
// the co-sitting, wall length of the co-sitting). It moves by compare-and-set
// on the co-sitting and the memory follows in the same transaction
// (sp_scrapbook_apply_co), recomputed from facts on every save.
async function recomputeCo(coId, memoryId) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const co = await q(sbx().from("co_sittings").select("*").eq("id", coId).maybeSingle());
    if (!co || co.memory_id !== memoryId) return;
    const rows = (await q(sbx().from("sitting_ledger").select("*").eq("co_sitting_id", coId))) || [];
    const byUser = new Map();
    for (const r of rows) byUser.set(r.user_id, (byUser.get(r.user_id) || 0) + Number(r.applied_together_sec || 0));
    const maxT = Math.max(0, ...byUser.values());
    const together = Math.floor(Math.min(maxT, unionLengthSec(rows)));
    const old = Number(co.applied_together_sec || 0);
    if (together === old) return;
    if (await fencedRpc("sp_scrapbook_apply_co", { p_co_id: coId, p_old: old, p_new: together, p_memory_id: memoryId, p_at: now() }) === true) return;
  }
}

// A sitting decided before its journey generation was removed can never
// write into that space again - not even after the purge deleted its ledger
// row (that is what the tombstone / journey_state row guards against).
async function removedSince(space, jk, decidedAt) {
  const rows = await journeyStateRows(space, jk);
  return rows.some(r => r.removed_at != null && Number(r.removed_at) >= Number(decidedAt || 0));
}

// Idempotent save. (sittingId, seq) with running totals: a seq at or below
// the last applied one is a no-op, totals only ever move forward, and every
// stored figure is recomputed from the ledger. The destination is read from
// the stored decision - never from the request - so a retried shared save
// can only ever land in the shared memory. The seq moves by compare-and-set,
// so two instances receiving the same or reordered saves apply each once.
async function saveSitting(userId, body = {}) {
  if (!v2Enabled()) return v2Disabled();
  const sittingId = String(body.sittingId || "");
  const seq = Math.floor(Number(body.seq));
  const entry = body.entry && typeof body.entry === "object" && !Array.isArray(body.entry) ? body.entry : null;
  const sourceKey = String(entry?.sourceKey || "").slice(0, 180);
  if (!validSittingId(sittingId) || !(seq >= 1) || !entry || !sourceKey) return { status: 400, error: "Invalid sitting save." };
  let d = await getDecision(sittingId);
  if (d && String(d.user_id) !== String(userId)) return { status: 403, error: "Not your sitting." };
  if (!d) {
    const r = await decideSitting(userId, { sittingId, sourceKey, roomId: body.roomId || null });
    if (r.error) return r;
    d = await getDecision(sittingId);
  }
  if (d.source_key !== sourceKey) return { status: 409, error: "This sitting belongs to a different episode." };
  const lockKey = d.destination === "SHARED" ? `chapter:${d.chapter_id}` : `user:${userId}`;
  return withLock(lockKey, async () => {
    const t = now();
    const view = decisionView(d);
    const ledger = await q(sbx().from("sitting_ledger").select("*").eq("sitting_id", sittingId).maybeSingle());
    if (ledger && seq <= Number(ledger.last_seq)) return { ok: true, duplicate: true, decision: view };
    if (d.destination === "SHARED") {
      const ch = await getChapterRow(d.chapter_id);
      if (!ch) return { ok: true, ignored: "chapter_missing", decision: view };
      if (ch.ended_at != null && (Number(d.decided_at) > Number(ch.ended_at) || t > Number(ch.ended_at) + V2.CLOSED_CHAPTER_GRACE_MS)) return { ok: true, ignored: "chapter_closed", decision: view };
    }
    let targetId, jk = journeyKeyOf(entry), gen = null;
    try {
      if (ledger) {
        targetId = ledger.target_id;
        const target = d.destination === "SHARED" ? await getMemory(targetId) : await q(sbx().from("scrapbook_entries").select("*").eq("id", targetId).maybeSingle());
        if (await targetRemoved(d.destination, target)) return { ok: true, ignored: "removed", decision: view };
        if (d.destination === "SHARED") await ensureSharedMemory(d.chapter_id, entry, sourceKey);
        else {
          await q(sbx().from("scrapbook_entries").update(identityPatch({ ...entry, sourceKey }, target)).eq("id", targetId));
          jk = journeyKeyOf(rowToEntry(target)); gen = scopeGeneration(target.scope) || 1;
        }
      } else {
        const space = d.destination === "SHARED" ? chapterSpace(d.chapter_id) : personalSpace(String(userId));
        if (await removedSince(space, jk, d.decided_at)) return { ok: true, ignored: "removed", decision: view };
        if (d.destination === "SHARED") {
          const mem = await ensureSharedMemory(d.chapter_id, entry, sourceKey);
          targetId = mem.id;
          await ensureMember(mem.id, String(userId));
        } else {
          const row = await ensurePersonalRow(String(userId), entry, sourceKey);
          targetId = row.id; gen = scopeGeneration(row.scope) || 1;
        }
      }
    } catch (e) {
      // The database refused to (re)create content in a removed generation.
      if (String(e.code) === "SPR01") return { ok: true, ignored: "removed", decision: view };
      throw e;
    }
    // The ledger move itself is ONE database transaction that re-verifies the
    // decision, owner, target, closed-chapter grace window and removal, and
    // advances (seq, running totals) monotonically. A stale lock owner is
    // rejected (SP_FENCED) before anything is written.
    let res;
    try {
      res = await fencedRpc("sp_scrapbook_save_ledger", {
        p_row: { sitting_id: sittingId, user_id: String(userId), target_id: targetId, watch_cum: toInt(body.watchSecCum), together_cum: toInt(body.togetherSecCum), journey_key: jk, generation: gen, max_age_ms: V2.LEDGER_COMPACT_MS },
        p_seq: seq, p_now: t, p_grace_ms: V2.CLOSED_CHAPTER_GRACE_MS
      });
    } catch (e) {
      if (String(e.code) === "SPR01") return { ok: true, ignored: "removed", decision: view };
      throw e;
    }
    const status = res && res.status;
    if (status === "duplicate") return { ok: true, duplicate: true, decision: view };
    if (status !== "inserted" && status !== "advanced") return { ok: true, ignored: status || "rejected", decision: view };
    // Exactly one instance links the co-sitting and counts its ONE session
    // (idempotent: retried until some save of the co-sitting succeeds).
    if (d.destination === "SHARED" && d.co_sitting_id) await fencedRpc("sp_scrapbook_link_co", { p_co_id: d.co_sitting_id, p_memory_id: targetId, p_at: t });
    await recomputeMember(d.destination, targetId, userId);
    if (d.destination === "SHARED" && d.co_sitting_id) await recomputeCo(d.co_sitting_id, targetId);
    return { ok: true, decision: view, target: { destination: d.destination, id: targetId } };
  });
}

// Old (pre-v2) clients still POST delta saves with scope 'shared'. They are
// folded into the chapter's shared memory (member totals += deltas; memory
// together/sessions follow the max member) instead of creating a copy.
async function legacySharedSave(userId, relationId, entry) {
  const rel = await getRelationById(relationId);
  if (!rel || ![rel.user1_id, rel.user2_id].map(String).includes(String(userId)) || !isActiveRelationRow(rel)) return null;
  const sourceKey = String(entry.sourceKey || "").slice(0, 180);
  const list = await ensureChapters(rel);
  const chapter = list.find(c => c.ended_at == null) || await startChapter(null, rel);
  return withLock(`chapter:${chapter.id}`, async () => {
    const mem = await ensureSharedMemory(chapter.id, entry, sourceKey);
    const m0 = await ensureMember(mem.id, String(userId));
    const t = now();
    await bumpTotals("shared_memory_members", m0.id, { watch: toInt(entry.watchDurationDeltaSec), together: toInt(entry.togetherDurationDeltaSec), sessions: toInt(entry.sessionCountDelta), touch: true }, t);
    const m = await q(sbx().from("shared_memory_members").select("*").eq("id", m0.id).maybeSingle());
    const tg = Number(m?.together_sec || 0), s = Number(m?.session_count || 0);
    const fresh = await getMemory(mem.id);
    await q(sbx().from("shared_memories").update({ together_sec: Math.max(Number(fresh.together_sec || 0), tg), session_count: Math.max(Number(fresh.session_count || 0), s), updated_at: t }).eq("id", mem.id));
    await flagTwinFor(String(userId), sourceKey, await getMemory(mem.id), chapter, true);
    return memoryToEntries([await getMemory(mem.id)], String(userId), chapter)[0];
  });
}

// ------------------------------------------------------ twins (6 conditions)
const TWIN_WINDOW_MS = 10 * 60 * 1000;
function isPureTwin(personal, shared, chapter) {
  const first = Number(personal.first_watched_at || 0), last = Number(personal.last_watched_at || 0);
  const covers = first >= Number(chapter.started_at || 0) && (chapter.ended_at == null || first <= Number(chapter.ended_at));
  const w1 = Number(personal.watch_duration_sec || 0), w2 = Number(shared.watchSec || 0);
  return covers &&
    Math.abs(first - Number(shared.firstWatchedAt || 0)) <= TWIN_WINDOW_MS &&
    Math.abs(last - Number(shared.lastWatchedAt || 0)) <= TWIN_WINDOW_MS &&
    Math.abs(w1 - w2) <= Math.max(120, 0.05 * Math.max(w1, w2)) &&
    Number(personal.session_count || 0) === Number(shared.sessions || 0);
}
async function flagTwinFor(userId, sourceKey, mem, chapter, write) {
  const p = await q(sbx().from("scrapbook_entries").select("*").eq("user_id", userId).eq("scope", "personal").eq("source_key", sourceKey).maybeSingle());
  if (!p || p.twin_class) return false;
  const m = await q(sbx().from("shared_memory_members").select("*").eq("memory_id", mem.id).eq("user_id", userId).maybeSingle());
  if (!m) return false;
  const ok = isPureTwin(p, { firstWatchedAt: m.first_watched_at, lastWatchedAt: m.last_watched_at, watchSec: m.watch_sec, sessions: m.session_count }, chapter);
  if (ok && write) await q(sbx().from("scrapbook_entries").update({ twin_class: "pure_twin", twin_of_shared_id: mem.id }).eq("id", p.id));
  return ok;
}

// ------------------------------------------------------------ reading
function memoryToEntries(mems, viewerId, chapter, members = null, states = [], prefs = [], t = now()) {
  return mems.map(mem => {
    const ms = (members || []).filter(m => m.memory_id === mem.id);
    const mine = ms.find(m => String(m.user_id) === String(viewerId));
    const e = rowToEntry({
      ...(mem.entry || {}), id: mem.id, user_id: viewerId, scope: `chapter:${mem.chapter_id}`, relation_id: chapter?.relation_id || null,
      source_key: mem.source_key, watch_duration_sec: mine ? mine.watch_sec : 0, together_duration_sec: mem.together_sec,
      session_count: mem.session_count, completed_at: mem.completed_at ?? (mem.entry || {}).completed_at ?? null,
      first_watched_at: mem.first_watched_at, last_watched_at: mem.last_watched_at, created_at: mem.created_at, updated_at: mem.updated_at, archived_at: null
    });
    const st = states.find(s => s.journey_key === mem.journey_key && Number(s.generation) === Number(mem.journey_version));
    const pref = prefs.find(p => p.journey_key === mem.journey_key);
    return {
      ...e, shared: true, chapterId: mem.chapter_id, journeyKey: mem.journey_key, journeyVersion: Number(mem.journey_version),
      members: ms.map(m => ({ userId: m.user_id, watchSec: Number(m.watch_sec || 0), togetherSec: Number(m.together_sec || 0), sessions: Number(m.session_count || 0) })),
      displayTitle: st?.display_title || null, journeyState: stateView(st, t), hidden: !!pref?.hidden_at,
      readOnly: chapter ? chapter.ended_at != null : false, legacy: !!mem.legacy
    };
  });
}

async function listPersonalV2(userId, { limit = 300, includeArchived = true, includeRemoved = false, includeTwins = false } = {}) {
  const sb = sbx();
  const base = (await q(sb.from("scrapbook_entries").select("*").eq("user_id", userId).eq("scope", "personal"))) || [];
  const later = (await q(sb.from("scrapbook_entries").select("*").eq("user_id", userId).like("scope", "personal:v%"))) || [];
  const states = await journeyStateRows(personalSpace(userId));
  const t = now();
  const out = [];
  for (const row of [...base, ...later]) {
    const e = rowToEntry(row);
    const jk = journeyKeyOf(e);
    const gen = scopeGeneration(row.scope) || 1;
    const st = states.find(s => s.journey_key === jk && Number(s.generation) === gen);
    if (st && st.removed_at != null && (!includeRemoved || st.purged_at != null)) continue;
    if (row.twin_class === "pure_twin" && !includeTwins) continue;
    // Journey-scope archive wins; rows without journey state keep their
    // legacy row-level archived flag exactly as before.
    const archivedAt = st?.archived_at != null ? Number(st.archived_at) : e.archivedAt;
    if (!includeArchived && archivedAt != null) continue;
    out.push({ ...e, archivedAt, journeyKey: jk, journeyVersion: gen, displayTitle: st?.display_title || null, journeyState: stateView(st, t), twinOfShared: row.twin_of_shared_id || null, removedAt: st?.removed_at == null ? null : Number(st.removed_at) });
  }
  return out.sort((a, b) => b.lastWatchedAt - a.lastWatchedAt).slice(0, limit);
}

function pickChapter(chapters, { chapterId = null, relationId = null } = {}) {
  if (chapterId) return chapters.find(c => c.id === String(chapterId)) || null;
  const pool = relationId ? chapters.filter(c => c.relationId === String(relationId)) : chapters;
  return pool.find(c => c.endedAt == null) || [...pool].sort((a, b) => b.chapterNo - a.chapterNo || b.startedAt - a.startedAt)[0] || null;
}

async function listSharedV2(userId, { chapterId = null, relationId = null, includeHidden = false, includeRemoved = false } = {}) {
  const chapters = await chaptersForUser(userId);
  const picked = pickChapter(chapters, { chapterId, relationId });
  if (!picked) return { entries: [], chapter: null, chapters };
  const chapter = await getChapterRow(picked.id);
  const mems = (await q(sbx().from("shared_memories").select("*").eq("chapter_id", chapter.id))) || [];
  const members = mems.length ? ((await q(sbx().from("shared_memory_members").select("*").in("memory_id", mems.map(m => m.id)))) || []) : [];
  const space = chapterSpace(chapter.id);
  const states = await journeyStateRows(space);
  const prefs = (await q(sbx().from("journey_member_prefs").select("*").eq("space", space).eq("user_id", String(userId)))) || [];
  const t = now();
  let entries = memoryToEntries(mems, userId, chapter, members, states, prefs, t);
  if (legacyReadsEnabled() && picked.legacy) {
    const legacyRows = ((await q(sbx().from("scrapbook_entries").select("*").eq("user_id", String(userId)).eq("scope", `shared:${chapter.relation_id}`))) || [])
      .filter(r => !r.migrated_to_shared_id);
    for (const r of legacyRows) {
      const e = rowToEntry(r);
      const jk = journeyKeyOf(e);
      const st = states.find(s => s.journey_key === jk && Number(s.generation) === 1);
      const pref = prefs.find(p => p.journey_key === jk);
      entries.push({ ...e, shared: true, chapterId: chapter.id, journeyKey: jk, journeyVersion: 1, members: [], displayTitle: st?.display_title || null, journeyState: stateView(st, t), hidden: !!pref?.hidden_at, readOnly: chapter.ended_at != null, legacy: true, legacyUnmigrated: true });
    }
  }
  entries = entries.filter(e => (includeHidden || !e.hidden) && (includeRemoved || !(e.journeyState && e.journeyState.removedAt != null)));
  return { entries: entries.sort((a, b) => b.lastWatchedAt - a.lastWatchedAt), chapter: { ...picked }, chapters };
}
function legacyReadsEnabled() { return String(process.env.SCRAPBOOK_LEGACY_SHARED_READS ?? "1") !== "0"; }

// ------------------------------------------------------ journey actions
const PERSONAL_ACTIONS = ["rename", "reset-title", "archive", "unarchive", "remove", "restore"];
const SHARED_ACTIONS = ["rename", "reset-title", "hide", "unhide", "request-removal", "cancel-removal", "confirm-removal", "decline-removal", "restore"];
const CLOSED_ALLOWED = ["hide", "unhide", "restore"];

// Is there live (unremoved) content for generation `gen` of a journey? Only
// then may an action create that generation's state row: a decline / cancel
// / confirm (or any other action) on an already-removed journey never
// creates an empty next-generation row.
async function journeyHasContent(space, jk, gen, chapter = null) {
  if (space.startsWith("u:")) {
    const rows = (await q(sbx().from("scrapbook_entries").select("*").eq("user_id", space.slice(2)).eq("scope", personalScope(gen)))) || [];
    return rows.some(r => journeyKeyOf(rowToEntry(r)) === jk);
  }
  const mems = (await q(sbx().from("shared_memories").select("id").eq("chapter_id", space.slice(2)).eq("journey_key", jk).eq("journey_version", Number(gen)))) || [];
  if (mems.length) return true;
  if (Number(gen) !== 1 || !chapter) return false;
  const legacy = (await q(sbx().from("scrapbook_entries").select("*").eq("scope", `shared:${chapter.relation_id}`))) || [];
  return legacy.some(r => !r.migrated_to_shared_id && journeyKeyOf(rowToEntry(r)) === jk);
}
// The state row an action applies to: the latest live generation, or - only
// for actions that need one and only when that generation has content - a
// newly created row. Returns null when there is nothing to act on.
const CREATES_STATE = ["rename", "reset-title", "archive", "unarchive", "remove", "request-removal"];
async function stateForAction(space, jk, action, chapter = null) {
  const latest = latestState(await journeyStateRows(space, jk), jk);
  if (action === "restore") return latest;
  if (latest && latest.removed_at == null) return latest;
  if (!CREATES_STATE.includes(action)) return null;
  const gen = latest ? Number(latest.generation) + 1 : 1;
  if (!(await journeyHasContent(space, jk, gen, chapter))) return null;
  return getOrCreateState(space, jk, gen);
}
// Every journey_state change is a compare-and-set on the row exactly as it
// was read (sp_scrapbook_journey_update, fenced): a concurrent change on
// another instance (confirm vs decline, purge vs restore, expiry vs confirm)
// makes this one fail with 409 instead of overwriting it.
const STATE_COLS = ["display_title", "title_edited_by", "title_edited_at", "archived_at", "removed_at", "removed_by", "purge_after", "purged_at", "removal_state", "removal_requested_by", "removal_requested_at", "removal_blocked_until", "updated_at"];
function expectOf(st) { const e = {}; for (const c of STATE_COLS) e[c] = st[c] === undefined ? null : st[c]; return e; }
async function casState(st, patch, requireOpen = false) {
  try {
    return await fencedRpc("sp_scrapbook_journey_update", { p_state_id: st.id, p_expect: expectOf(st), p_patch: patch, p_require_open: !!requireOpen });
  } catch (e) {
    if (String(e.code) === "SPC01") return { error: { status: 409, error: "This chapter has ended and is read-only.", readOnly: true } };
    if (String(e.code) === "SPR01") return { error: { status: 409, error: "The restore window has passed." } };
    throw e;
  }
}
const CONFLICT = { status: 409, error: "This memory was just changed; refresh and try again.", conflict: true };

async function journeyAction(userId, body = {}) {
  if (!v2Enabled()) return v2Disabled();
  const action = String(body.action || "");
  const jk = normJourneyKey(body.journeyKey);
  if (!jk) return { status: 400, error: "Missing journey." };
  const t = now();
  if (body.space === "personal") {
    if (!PERSONAL_ACTIONS.includes(action)) return { status: 400, error: "Unknown action." };
    const space = personalSpace(userId);
    return withLock(`space:${space}`, async () => {
      const st = await stateForAction(space, jk, action);
      if (!st) return action === "restore" ? { status: 409, error: "Nothing to restore." } : { status: 404, error: "Nothing to change for this journey." };
      const patch = await applyCommon(st, action, userId, body, t);
      if (patch.error) return patch;
      if (action === "archive" || action === "unarchive") {
        patch.archived_at = action === "archive" ? t : null;
        if (action === "unarchive") {
          const scope = personalScope(st.generation);
          const legacyRows = ((await q(sbx().from("scrapbook_entries").select("*").eq("user_id", String(userId)).eq("scope", scope))) || []).filter(r => journeyKeyOf(rowToEntry(r)) === jk && r.archived_at != null);
          for (const r of legacyRows) await q(sbx().from("scrapbook_entries").update({ archived_at: null }).eq("id", r.id));
        }
      }
      if (action === "remove") Object.assign(patch, { removed_at: t, removed_by: String(userId), purge_after: t + V2.RESTORE_WINDOW_MS });
      const saved = await casState(st, { ...patch, updated_at: t });
      if (saved && saved.error) return saved.error;
      if (!saved) return CONFLICT;
      await logEvent(space, jk, userId, action, { generation: Number(st.generation) });
      return { ok: true, state: stateView(saved, t) };
    });
  }
  if (!SHARED_ACTIONS.includes(action)) return { status: 400, error: "Unknown action." };
  const chapter = await getChapterRow(body.chapterId);
  if (!chapter || !(await userInChapter(userId, chapter))) return { status: 403, error: "You are not part of this chapter." };
  const closed = chapter.ended_at != null;
  if (closed && !CLOSED_ALLOWED.includes(action)) return { status: 409, error: "This chapter has ended and is read-only.", readOnly: true };
  const space = chapterSpace(chapter.id);
  return withLock(`space:${space}`, async () => {
    if (action === "hide" || action === "unhide") {
      const existing = await q(sbx().from("journey_member_prefs").select("*").eq("space", space).eq("journey_key", jk).eq("user_id", String(userId)).maybeSingle());
      const values = { hidden_at: action === "hide" ? t : null, updated_at: t };
      if (existing) await q(sbx().from("journey_member_prefs").update(values).eq("id", existing.id));
      else await q(sbx().from("journey_member_prefs").insert({ id: id("jmp"), space, journey_key: jk, user_id: String(userId), ...values }));
      await logEvent(space, jk, userId, action);
      return { ok: true, hidden: action === "hide" };
    }
    const st = await stateForAction(space, jk, action, chapter);
    if (!st) {
      if (action === "restore") return { status: 409, error: "Nothing to restore." };
      if (["cancel-removal", "confirm-removal", "decline-removal"].includes(action)) return { status: 409, error: "There is no open removal request." };
      return { status: 404, error: "Nothing to change for this journey." };
    }
    const patch = await applyCommon(st, action, userId, body, t);
    if (patch.error) return patch;
    const removal = effectiveRemoval(st, t);
    const blockedUntil = removal.state === "expired" ? removal.blockedUntil : Number(st?.removal_blocked_until || 0);
    if (action === "request-removal") {
      if (removal.state === "requested") return { status: 409, error: "A removal request is already waiting." };
      if (blockedUntil > t) return { status: 409, error: "This memory was kept recently; you can ask again later.", blockedUntil };
      Object.assign(patch, { removal_state: "requested", removal_requested_by: String(userId), removal_requested_at: t });
    } else if (["cancel-removal", "confirm-removal", "decline-removal"].includes(action)) {
      if (removal.state !== "requested") return { status: 409, error: "There is no open removal request." };
      const mine = String(removal.requestedBy) === String(userId);
      if (action === "cancel-removal" && !mine) return { status: 403, error: "Only the person who asked can cancel." };
      if (action !== "cancel-removal" && mine) return { status: 403, error: "Your partner has to answer this request." };
      Object.assign(patch, { removal_state: "none", removal_requested_by: null, removal_requested_at: null });
      if (action === "confirm-removal") Object.assign(patch, { removed_at: t, removed_by: String(userId), purge_after: t + V2.RESTORE_WINDOW_MS });
      if (action === "decline-removal") patch.removal_blocked_until = t + V2.REMOVAL_COOLDOWN_MS;
    }
    const saved = await casState(st, { ...patch, updated_at: t }, !CLOSED_ALLOWED.includes(action));
    if (saved && saved.error) return saved.error;
    if (!saved) return CONFLICT;
    await logEvent(space, jk, userId, action, { generation: Number(st.generation) });
    return { ok: true, state: stateView(saved, t) };
  });
}

// Rename / reset / restore rules shared by both spaces.
async function applyCommon(st, action, userId, body, t) {
  if (action === "rename") {
    const title = String(body.displayTitle || "").replace(/\s+/g, " ").trim().slice(0, 120);
    if (!title) return { status: 400, error: "Enter a title." };
    return { display_title: title, title_edited_by: String(userId), title_edited_at: t };
  }
  if (action === "reset-title") return { display_title: null, title_edited_by: null, title_edited_at: null };
  if (action === "restore") {
    if (!st || st.removed_at == null) return { status: 409, error: "Nothing to restore." };
    if (st.purged_at != null || t > Number(st.purge_after || 0)) return { status: 409, error: "The restore window has passed." };
    const newer = (await journeyStateRows(st.space, st.journey_key)).some(r => Number(r.generation) > Number(st.generation));
    if (newer) return { status: 409, error: "A newer journey for this title already exists." };
    return { removed_at: null, removed_by: null, purge_after: null };
  }
  return {};
}

// ----------------------------------------------------------- maintenance
async function acquireLease(name, holder, t) {
  const sb = sbx();
  const row = await q(sb.from("maintenance_lease").select("*").eq("name", name).maybeSingle());
  if (!row) {
    const { error } = await sb.from("maintenance_lease").insert({ name, holder, until_at: t + V2.LEASE_MS });
    return !error;
  }
  if (Number(row.until_at) > t) return false;
  await q(sb.from("maintenance_lease").update({ holder, until_at: t + V2.LEASE_MS }).eq("name", name).eq("holder", row.holder));
  const after = await q(sb.from("maintenance_lease").select("*").eq("name", name).maybeSingle());
  return after && after.holder === holder;
}

// Purges removed generations past their restore window (tombstoned), expires
// stale removal requests and compacts ledger rows older than 90 days (their
// credited amounts already live in the totals). Legacy rows of a purged
// Story journey stay in place, hidden by the journey state.
async function runMaintenance(t = now()) {
  const holder = id("mnt");
  if (!(await acquireLease("scrapbook", holder, t))) return { skipped: true };
  const report = { expiredRequests: 0, purgedJourneys: 0, purgedRows: 0, compactedLedger: 0 };
  const sb = sbx();
  const states = (await q(sb.from("journey_state").select("*"))) || [];
  for (const st of states) {
    const r = effectiveRemoval(st, t);
    if (r.state === "expired") {
      // Only the exact request that expired is cleared (compare-and-set on
      // the whole row), so a confirm / decline / newer request that another
      // instance wrote first is never wiped.
      const exp = await fencedRpc("sp_scrapbook_journey_update", { p_state_id: st.id, p_expect: expectOf(st), p_patch: { removal_state: "none", removal_requested_by: null, removal_requested_at: null, removal_blocked_until: r.blockedUntil, updated_at: t }, p_require_open: false });
      if (exp) { report.expiredRequests++; Object.assign(st, exp); }
    }
    if (st.removed_at != null && st.purged_at == null && Number(st.purge_after || 0) <= t) {
      // Same locks as restore (space) and saves (chapter / user); the purge
      // itself is ONE fenced transaction that re-checks the state row under
      // FOR UPDATE, deletes the generation's rows, marks it purged and writes
      // the tombstone - a restore on another instance either wins before it
      // or fails after it, never interleaves.
      const inner = st.space.startsWith("u:") ? `user:${st.space.slice(2)}` : `chapter:${st.space.slice(2)}`;
      const did = await withLock(`space:${st.space}`, () => withLock(inner, async () => {
        let entryIds = [];
        if (st.space.startsWith("u:")) {
          const rows = ((await q(sb.from("scrapbook_entries").select("*").eq("user_id", st.space.slice(2)).eq("scope", personalScope(st.generation)))) || []).filter(r => journeyKeyOf(rowToEntry(r)) === st.journey_key);
          entryIds = rows.map(r => r.id);
        }
        const res = await fencedRpc("sp_scrapbook_purge_journey", { p_state_id: st.id, p_now: t, p_entry_ids: entryIds });
        if (!(res && res.purged)) return false;
        report.purgedRows += Number(res.rows || 0);
        return true;
      }));
      if (did) report.purgedJourneys++;
    }
  }
  const old = ((await q(sb.from("sitting_ledger").select("*").lt("updated_at", t - V2.LEDGER_COMPACT_MS))) || []);
  // Conditional delete: a row that was written again meanwhile is kept.
  for (const r of old) { await q(sb.from("sitting_ledger").delete().eq("sitting_id", r.sitting_id).lt("updated_at", t - V2.LEDGER_COMPACT_MS)); report.compactedLedger++; }
  await q(sb.from("maintenance_runs").insert({ id: id("run"), kind: "scrapbook", started_at: t, finished_at: now(), report }));
  await q(sb.from("maintenance_lease").update({ until_at: 0 }).eq("name", "scrapbook").eq("holder", holder));
  return report;
}

// --------------------------------------------------------------- backfill
// Conservative, idempotent, dry-run first. Never deletes or rewrites a
// legacy row's content: legacy shared copies are only LINKED to the merged
// memory, personal twins only FLAGGED, archive flags only FOLDED into new
// journey state rows. A second run finds nothing left to do.
async function runBackfill({ apply = false } = {}) {
  const sb = sbx();
  const report = { mode: apply ? "apply" : "dry-run", relations: 0, legacyChaptersCreated: 0, legacySharedRows: 0, memoriesCreated: 0, memoriesMerged: 0, rowsLinked: 0, twinsFlagged: 0, archiveFolded: 0, partialArchiveJourneys: 0, skipped: [] };
  const rels = ((await q(sb.from("relations").select(RELATION_COLUMNS))) || []).filter(r => r.accepted_at);
  report.relations = rels.length;
  const chapterFor = new Map();
  for (const rel of rels) {
    const list = await listChapterRows(rel.id);
    if (!list.length) {
      report.legacyChaptersCreated++;
      if (apply) chapterFor.set(rel.id, (await ensureChapters(rel))[0]);
      else chapterFor.set(rel.id, { id: `(new legacy chapter for ${rel.id})`, started_at: Number(rel.accepted_at), ended_at: isActiveRelationRow(rel) ? null : Number(rel.ended_at || rel.archived_at || now()), dry: true });
    } else chapterFor.set(rel.id, list.find(c => c.legacy) || list[0]);
  }
  const legacy = ((await q(sb.from("scrapbook_entries").select("*").like("scope", "shared:%"))) || []).filter(r => !r.migrated_to_shared_id);
  report.legacySharedRows = legacy.length;
  const groups = new Map();
  for (const r of legacy) {
    const relId = String(r.scope).slice(7);
    const k = `${relId}\u0000${r.source_key}`;
    if (!groups.has(k)) groups.set(k, { relId, sourceKey: r.source_key, rows: [] });
    groups.get(k).rows.push(r);
  }
  for (const g of groups.values()) {
    const chapter = chapterFor.get(g.relId);
    if (!chapter) { report.skipped.push({ relationId: g.relId, sourceKey: g.sourceKey, reason: "relation missing or never accepted" }); continue; }
    const byUser = new Map();
    for (const r of g.rows) byUser.set(String(r.user_id), r);
    const rows = [...byUser.values()];
    const primary = rows.slice().sort((a, b) => Number(b.updated_at || 0) - Number(a.updated_at || 0))[0];
    const jk = journeyKeyOf(rowToEntry(primary));
    const maxTogether = Math.max(0, ...rows.map(r => Number(r.together_duration_sec || 0)));
    const maxSessions = Math.max(0, ...rows.map(r => Number(r.session_count || 0)));
    const existing = chapter.dry ? null : await q(sb.from("shared_memories").select("*").eq("chapter_id", chapter.id).eq("source_key", g.sourceKey).eq("journey_version", 1).maybeSingle());
    if (existing) report.memoriesMerged++; else report.memoriesCreated++;
    report.rowsLinked += g.rows.length;
    if (!apply) continue;
    const t = now();
    let mem = existing;
    const legacyEntry = { ...primary };
    for (const c of ["id", "user_id", "scope", "relation_id", "migrated_to_shared_id", "twin_of_shared_id", "twin_class", "archived_at", "created_at", ...TOTAL_COLS]) delete legacyEntry[c];
    const firsts = rows.map(r => Number(r.first_watched_at || 0)).filter(Boolean);
    const lasts = rows.map(r => Number(r.last_watched_at || 0));
    if (!mem) {
      mem = await q(sb.from("shared_memories").insert({ id: id("mem"), chapter_id: chapter.id, source_key: g.sourceKey, journey_key: jk, journey_version: 1, entry: legacyEntry, together_sec: maxTogether, session_count: maxSessions, first_watched_at: firsts.length ? Math.min(...firsts) : t, last_watched_at: Math.max(0, ...lasts), completed_at: rows.map(r => r.completed_at).filter(v => v != null).sort()[0] ?? null, legacy: true, created_at: t, updated_at: t }).select("*").maybeSingle());
    } else {
      mem = await q(sb.from("shared_memories").update({ entry: { ...legacyEntry, ...(existing.entry || {}) }, together_sec: Number(existing.together_sec || 0) + maxTogether, session_count: Number(existing.session_count || 0) + maxSessions, first_watched_at: Math.min(Number(existing.first_watched_at || t), ...(firsts.length ? firsts : [t])), legacy: true, updated_at: t }).eq("id", existing.id).select("*").maybeSingle());
    }
    for (const r of rows) {
      const m = await ensureMember(mem.id, String(r.user_id));
      await q(sb.from("shared_memory_members").update({ watch_sec: Number(m.watch_sec || 0) + Number(r.watch_duration_sec || 0), together_sec: Number(m.together_sec || 0) + Number(r.together_duration_sec || 0), session_count: Number(m.session_count || 0) + Number(r.session_count || 0), first_watched_at: Number(r.first_watched_at || m.first_watched_at), last_watched_at: (Number(m.watch_sec || 0) || Number(m.session_count || 0)) ? Math.max(Number(r.last_watched_at || 0), Number(m.last_watched_at || 0)) : Number(r.last_watched_at || m.last_watched_at), updated_at: t }).eq("id", m.id));
    }
    for (const r of g.rows) await q(sb.from("scrapbook_entries").update({ migrated_to_shared_id: mem.id }).eq("id", r.id));
    for (const r of rows) if (await flagTwinFor(String(r.user_id), g.sourceKey, mem, chapter, true)) report.twinsFlagged++;
  }
  if (!apply) {
    // Dry-run twin estimate against the legacy copies themselves.
    for (const g of groups.values()) {
      const chapter = chapterFor.get(g.relId);
      if (!chapter) continue;
      for (const r of g.rows) {
        const p = await q(sb.from("scrapbook_entries").select("*").eq("user_id", r.user_id).eq("scope", "personal").eq("source_key", g.sourceKey).maybeSingle());
        if (p && !p.twin_class && isPureTwin(p, { firstWatchedAt: r.first_watched_at, lastWatchedAt: r.last_watched_at, watchSec: r.watch_duration_sec, sessions: r.session_count }, chapter)) report.twinsFlagged++;
      }
    }
  }
  const personal = (await q(sb.from("scrapbook_entries").select("*").eq("scope", "personal"))) || [];
  const journeys = new Map();
  for (const r of personal) {
    const k = `${r.user_id}\u0000${journeyKeyOf(rowToEntry(r))}`;
    if (!journeys.has(k)) journeys.set(k, { userId: String(r.user_id), jk: journeyKeyOf(rowToEntry(r)), rows: [] });
    journeys.get(k).rows.push(r);
  }
  for (const j of journeys.values()) {
    const archived = j.rows.filter(r => r.archived_at != null);
    if (!archived.length) continue;
    if (archived.length < j.rows.length) { report.partialArchiveJourneys++; continue; }
    const st = (await journeyStateRows(personalSpace(j.userId), j.jk)).find(s => Number(s.generation) === 1);
    if (st && st.archived_at != null) continue;
    report.archiveFolded++;
    if (apply) {
      const s = st || await getOrCreateState(personalSpace(j.userId), j.jk, 1);
      await q(sb.from("journey_state").update({ archived_at: Math.max(...archived.map(r => Number(r.archived_at))), updated_at: now() }).eq("id", s.id));
    }
  }
  return report;
}

// ---------------------------------------------------------------- Moments
// Stable ids: type | space | journey_key | period. They never contain a
// display title, so renaming a journey never resurfaces a seen Moment.
function ymd(ms) { return new Date(ms).toISOString().slice(0, 10); }
async function buildMoments(userId, t = now()) {
  if (!v2Enabled()) return [];
  const moments = [];
  const personal = await listPersonalV2(userId, { includeArchived: false });
  const spaces = [{ space: personalSpace(userId), label: "My Scrapbook", entries: personal }];
  const chapters = await chaptersForUser(userId);
  for (const c of chapters) {
    const r = await listSharedV2(userId, { chapterId: c.id });
    spaces.push({ space: chapterSpace(c.id), label: "Our Story", chapter: c, entries: r.entries });
  }
  const DAY = 86400000;
  for (const s of spaces) {
    const journeys = new Map();
    for (const e of s.entries) {
      const k = e.journeyKey || journeyKeyOf(e);
      if (!journeys.has(k)) journeys.set(k, []);
      journeys.get(k).push(e);
    }
    for (const [jk, list] of journeys) {
      const title = list.find(e => e.displayTitle)?.displayTitle || list[0].canonicalTitle || list[0].title;
      const gen = list[0].journeyVersion || 1;
      const done = list.filter(e => e.completedAt).sort((a, b) => a.completedAt - b.completedAt);
      if (list[0].contentType === "movie" && done[0]) moments.push({ id: `finished|${s.space}|${jk}|g${gen}`, type: "finished", space: s.space, journeyKey: jk, title, at: done[0].completedAt });
      const byFirst = list.slice().sort((a, b) => a.firstWatchedAt - b.firstWatchedAt);
      for (let i = 1; i < byFirst.length; i++) {
        if (byFirst[i].firstWatchedAt - byFirst[i - 1].lastWatchedAt > 30 * DAY) moments.push({ id: `return|${s.space}|${jk}|${ymd(byFirst[i].firstWatchedAt)}`, type: "return", space: s.space, journeyKey: jk, title, at: byFirst[i].firstWatchedAt });
      }
      const first = byFirst[0]?.firstWatchedAt;
      if (first) {
        for (const years of [1, 2, 3, 4, 5]) {
          const anniv = new Date(first); anniv.setUTCFullYear(anniv.getUTCFullYear() + years);
          if (Math.abs(t - anniv.getTime()) <= 3 * DAY) moments.push({ id: `on-this-day|${s.space}|${jk}|${anniv.getUTCFullYear()}`, type: "on-this-day", space: s.space, journeyKey: jk, title, years, at: anniv.getTime() });
        }
      }
    }
    if (s.chapter) {
      const first = s.entries.slice().sort((a, b) => a.firstWatchedAt - b.firstWatchedAt)[0];
      if (first) moments.push({ id: `first-together|${s.space}|${first.journeyKey}|chapter`, type: "first-together", space: s.space, journeyKey: first.journeyKey, title: first.displayTitle || first.canonicalTitle || first.title, at: first.firstWatchedAt });
      const hours = s.entries.reduce((n, e) => n + (e.togetherDurationSec || 0), 0) / 3600;
      for (const h of [10, 25, 50, 100, 250, 500]) if (hours >= h) moments.push({ id: `together-hours|${s.space}|*|${h}`, type: "together-hours", space: s.space, journeyKey: null, hours: h, title: `${h} hours together`, at: s.entries[0]?.lastWatchedAt || t });
    }
  }
  const ledger = ((await q(sbx().from("sitting_ledger").select("*").eq("user_id", String(userId)))) || []).filter(r => Number(r.applied_watch_sec || 0) >= 7200);
  for (const r of ledger) {
    const space = r.destination === "SHARED" ? spaces.find(s => s.entries.some(e => e.id === r.target_id)) : spaces[0];
    const e = space?.entries.find(x => x.id === r.target_id);
    if (e) moments.push({ id: `marathon|${space.space}|${e.journeyKey}|${ymd(Number(r.interval_start))}`, type: "marathon", space: space.space, journeyKey: e.journeyKey, title: e.displayTitle || e.canonicalTitle || e.title, at: Number(r.interval_end) });
  }
  // Chapter + artwork context for the story viewer. Additive fields only;
  // ids, ordering and seen state are unchanged.
  for (const m of moments) {
    const s = spaces.find(x => x.space === m.space);
    const e = s && m.journeyKey ? s.entries.find(x => x.journeyKey === m.journeyKey) : s?.entries[0];
    m.scope = s?.chapter ? "shared" : "personal";
    m.chapterId = s?.chapter?.id || null;
    m.chapterNo = s?.chapter?.chapterNo ?? null;
    m.readOnly = !!s?.chapter?.readOnly;
    m.art = (e && (e.backdrop || e.artwork || e.thumbnail)) || null;
    m.contentType = e?.contentType || null;
  }
  const unique = [...new Map(moments.map(m => [m.id, m])).values()];
  const seen = new Set(((await q(sbx().from("moment_seen").select("*").eq("user_id", String(userId)))) || []).map(r => r.moment_id));
  return unique.map(m => ({ ...m, seen: seen.has(m.id) })).sort((a, b) => (a.seen - b.seen) || (b.at - a.at)).slice(0, 12);
}
async function markMomentsSeen(userId, ids) {
  if (!v2Enabled()) return { ok: false, ...v2Disabled() };
  const list = (Array.isArray(ids) ? ids : []).map(String).filter(Boolean).slice(0, 50);
  for (const mid of list) {
    const { error } = await sbx().from("moment_seen").insert({ id: id("seen"), user_id: String(userId), moment_id: mid.slice(0, 400), seen_at: now() });
    if (error && error.code !== "23505") throw error;
  }
  return { ok: true, seen: list.length };
}

module.exports = {
  V2, v2Enabled, v2Disabled, journeyKeyOf, chaptersForUser, activeChapterForUser, listPersonalV2, listSharedV2,
  recordIntent, decideSitting, saveSitting, journeyAction, runMaintenance, runBackfill, buildMoments, markMomentsSeen,
  __testHooks: testHooks,
  id,
  now,
  getUser,
  getRelation,
  getRelationById,
  relationView,
  listUserRelations,
  getActiveRelationRow,
  closeRelation,
  reopenRelation,
  isActiveRelationRow,
  positiveIntOrNull,
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
