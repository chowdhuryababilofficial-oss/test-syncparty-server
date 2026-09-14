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
  let { data, error } = await sb.from("users").select("id,name,email,avatar,color,provider,party_name,party_avatar").eq("id", userId).maybeSingle();
  if (error && /column .*?(party_name|party_avatar).*?(does not exist|unknown)/i.test(String(error.message || ""))) {
    const legacy = await sb.from("users").select("id,name,email,avatar,color,provider").eq("id", userId).maybeSingle();
    data = legacy.data; error = legacy.error;
  }
  if (error) throw error;
  return data ? {
    id: data.id, name: data.name, email: data.email, avatar: data.avatar, color: data.color, provider: data.provider
  } : null;
}

async function getRelation(a, b) {
  const ids = [String(a), String(b)].sort();
  const sb = getSupabaseAdmin();
  const fullSelect = "id,user1_id,user2_id,created_at,accepted_at,archived_at,ended_at";
  const archivedSelect = "id,user1_id,user2_id,created_at,accepted_at,archived_at";
  const baseSelect = "id,user1_id,user2_id,created_at,accepted_at";

  let { data, error } = await sb.from("relations")
    .select(fullSelect)
    .eq("user1_id", ids[0]).eq("user2_id", ids[1]).maybeSingle();

  // The new Scrapbook relation fields are additive. A live/older Supabase
  // deployment may not have one or both columns yet; invitation creation
  // must still work in that environment instead of bubbling a 500 that the
  // production server masks as the generic "SyncParty server error."
  if (error && isMissingColumnError(error, "ended_at")) {
    const legacy = await sb.from("relations")
      .select(archivedSelect)
      .eq("user1_id", ids[0]).eq("user2_id", ids[1]).maybeSingle();
    data = legacy.data; error = legacy.error;
  }
  if (error && isMissingColumnError(error, "archived_at")) {
    const legacy = await sb.from("relations")
      .select(baseSelect)
      .eq("user1_id", ids[0]).eq("user2_id", ids[1]).maybeSingle();
    data = legacy.data; error = legacy.error;
  }
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

function isMissingColumnError(error, col) {
  return !!error && new RegExp(`column\\s+["']?${col}["']?.*?(does not exist|unknown)`, "i").test(String(error.message || ""));
}

// "One active Our Story at a time": a user's single active relation, if any
// (accepted and not archived), regardless of which partner it's with.
async function getActiveRelationForUser(userId) {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb.from("relations")
    .select("id,user1_id,user2_id,created_at,accepted_at,archived_at,ended_at")
    .or(`user1_id.eq.${userId},user2_id.eq.${userId}`)
    .not("accepted_at", "is", null)
    .is("archived_at", null)
    .limit(1)
    .maybeSingle();
  if (!error) return data || null;
  // A deployment that hasn't yet run the archived_at migration (see
  // supabase-schema.sql) has no "archived" concept at all — every accepted
  // relation is active there. Retrying without that filter instead of
  // hard-failing is what actually fixes "SyncParty server error." on Start
  // Our Story for two brand-new accounts: this query runs on every invite
  // attempt, so a not-yet-migrated database made the whole feature crash.
  if (isMissingColumnError(error, "archived_at")) {
    const retry = await sb.from("relations")
      .select("id,user1_id,user2_id,created_at,accepted_at")
      .or(`user1_id.eq.${userId},user2_id.eq.${userId}`)
      .not("accepted_at", "is", null)
      .limit(1)
      .maybeSingle();
    if (retry.error) throw retry.error;
    return retry.data || null;
  }
  throw error;
}

async function listUserRelations(userId) {
  const sb = getSupabaseAdmin();
  let { data, error } = await sb.from("relations")
    .select("id,user1_id,user2_id,created_at,accepted_at,archived_at,ended_at")
    .or(`user1_id.eq.${userId},user2_id.eq.${userId}`)
    .order("created_at", { ascending: false });
  if (error && /column .*?ended_at.*?(does not exist|unknown)/i.test(String(error.message || ""))) {
    const legacy = await sb.from("relations").select("id,user1_id,user2_id,created_at,accepted_at,archived_at").or(`user1_id.eq.${userId},user2_id.eq.${userId}`).order("created_at", { ascending: false });
    data = legacy.data; error = legacy.error;
  }
  if (error) throw error;
  return Promise.all((data || []).map(relationView));
}

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
    const modernSchemaError = /column .*?(content_type|canonical_title|artwork|artwork_candidates|backdrop|metadata_provider|metadata_id|metadata_year|story_total_episodes|story_episodes_completed|story_progress|story_progress_confidence|series_episode_counts|together_duration_sec|session_count|completed_at).*?(does not exist|unknown)/i.test(String(error.message || ""));
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

async function mutateEntries(userId, entryIds, mode, archived = true) {
  const ids = Array.isArray(entryIds) ? entryIds.map(String).filter(Boolean).slice(0, 100) : [];
  if (!ids.length) return { entries: [] };
  const sb = getSupabaseAdmin();
  if (mode === "remove") {
    const { data, error } = await sb.from("scrapbook_entries").delete().eq("user_id", userId).in("id", ids).select("id");
    if (error) throw error;
    return { entries: data || [] };
  }
  const patch = { archived_at: archived ? now() : null };
  const { data, error } = await sb.from("scrapbook_entries").update(patch).eq("user_id", userId).in("id", ids).select("*");
  if (error) {
    if (/column .*?archived_at.*?(does not exist|unknown)/i.test(String(error.message || ""))) return { error: "Per-memory archive needs the latest SyncParty database migration." };
    throw error;
  }
  return { entries: (data || []).map(rowToEntry) };
}

async function reconcileEntries(userId, entries) {
  const sb = getSupabaseAdmin();
  const incoming = Array.isArray(entries) ? entries.slice(0, 500) : [];
  const sourceKeys = incoming.map(e => String(e?.sourceKey || "")).filter(Boolean);
  if (!sourceKeys.length) return { reconciledAt: now(), entries: [] };
  const { data, error } = await sb.from("scrapbook_entries")
    .select("*")
    .eq("user_id", userId)
    .eq("scope", "personal")
    .in("source_key", sourceKeys);
  if (error) throw error;
  const byKey = new Map((data || []).map(r => [String(r.source_key), rowToEntry(r)]));
  const fields=["title","contentType","canonicalTitle","thumbnail","artwork","backdrop","platform","season","episode","progress","status","watchDurationSec","togetherDurationSec","sessionCount","completedAt","metadataProvider","metadataId","metadataYear","storyTotalEpisodes","storyEpisodesCompleted","storyProgress","storyProgressConfidence","seriesEpisodeCounts","firstWatchedAt","lastWatchedAt","archivedAt"];
  const fingerprint = obj => JSON.stringify(fields.map(k => obj?.[k] ?? null));
  const result=incoming.map(e=>{
    const k=String(e?.sourceKey || ""); const server=byKey.get(k);
    if(!server) return {sourceKey:k,state:"failed",reason:"missing-on-server"};
    return {sourceKey:k,state:fingerprint(e)===fingerprint(server)?"synced":"failed",reason:fingerprint(e)===fingerprint(server)?null:"mismatch"};
  });
  return { reconciledAt: now(), entries: result };
}

async function createInvite(fromUserId, toUserId) {
  const sb = getSupabaseAdmin();
  const relation = await getRelation(fromUserId, toUserId);
  if (relation?.accepted_at && !relation.archived_at) return { relation: await relationView(relation) };
  // "One active Our Story at a time": neither party may invite/be invited
  // while already in an active (accepted, unarchived) story with someone
  // else. A pre-existing (possibly archived) relation with THIS SAME
  // partner is fine — that's a restart, handled in respondInvite.
  const [fromActive, toActive] = await Promise.all([
    getActiveRelationForUser(fromUserId),
    getActiveRelationForUser(toUserId)
  ]);
  if (fromActive && !(relation && fromActive.id === relation.id)) return { error: "You already have an active Our Story. End it before starting a new one." };
  if (toActive && !(relation && toActive.id === relation.id)) return { error: "They already have an active Our Story with someone else." };
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
  if (accept) {
    // Race guard: re-verify eligibility right before committing, since
    // either side may have started (or been placed into) an active story
    // with someone else in the time between this invite being shown and
    // the user clicking Accept.
    const preExisting = await getRelation(inv.from_user_id, inv.to_user_id);
    const alreadyActiveWithEachOther = !!(preExisting?.accepted_at && !preExisting.archived_at);
    if (!alreadyActiveWithEachOther) {
      const [fromActive, toActive] = await Promise.all([
        getActiveRelationForUser(inv.from_user_id),
        getActiveRelationForUser(inv.to_user_id)
      ]);
      if (fromActive || toActive) {
        await sb.from("invites").update({ status: "declined", responded_at: respondedAt }).eq("id", inviteId);
        return { error: "This invitation is no longer available — one of you already has an active Our Story." };
      }
    }
  }
  const { error: updateError } = await sb.from("invites").update({ status: accept ? "accepted" : "declined", responded_at: respondedAt }).eq("id", inviteId);
  if (updateError) throw updateError;
  if (!accept) return { relation: null };
  const ids = [inv.from_user_id, inv.to_user_id].sort();
  const existing = await getRelation(inv.from_user_id, inv.to_user_id);
  let relation = existing;
  if (!relation) {
    const row = { id: id("rel"), user1_id: ids[0], user2_id: ids[1], created_at: respondedAt, accepted_at: respondedAt, archived_at: null };
    const { data, error } = await sb.from("relations").insert(row).select("*").maybeSingle();
    if (error) {
      if (error.code === "23505") relation = await getRelation(inv.from_user_id, inv.to_user_id);
      else if (isMissingColumnError(error, "archived_at")) {
        const legacyRow = { ...row }; delete legacyRow.archived_at;
        const retry = await sb.from("relations").insert(legacyRow).select("*").maybeSingle();
        if (retry.error) { if (retry.error.code === "23505") relation = await getRelation(inv.from_user_id, inv.to_user_id); else throw retry.error; }
        else relation = retry.data;
      } else throw error;
    } else relation = data;
  } else if (!relation.accepted_at || relation.archived_at) {
    // Either a brand-new acceptance, or restarting a previously-archived
    // story with the SAME partner — reuse the row (the pair unique index
    // means a second row for this exact pair can never be inserted).
    const { data, error } = await sb.from("relations").update({ accepted_at: respondedAt, archived_at: null }).eq("id", relation.id).select("*").maybeSingle();
    if (error) {
      if (isMissingColumnError(error, "archived_at")) {
        const retry = await sb.from("relations").update({ accepted_at: respondedAt }).eq("id", relation.id).select("*").maybeSingle();
        if (retry.error) throw retry.error;
        relation = retry.data;
      } else throw error;
    } else relation = data;
  }
  return { relation: await relationView(relation) };
}

async function archiveRelation(relationId, userId) {
  const sb = getSupabaseAdmin();
  const { data: rel, error: findError } = await sb.from("relations").select("*").eq("id", relationId).maybeSingle();
  if (findError) throw findError;
  if (!rel || (rel.user1_id !== userId && rel.user2_id !== userId)) return { error: "Story not found." };
  if (rel.archived_at) return { relation: await relationView(rel) };
  const { data, error } = await sb.from("relations").update({ archived_at: now() }).eq("id", relationId).select("*").maybeSingle();
  if (!error) return { relation: await relationView(data) };
  if (isMissingColumnError(error, "archived_at")) return { error: "Archiving Our Story isn't available yet — please run the latest database migration." };
  throw error;
}

// Archives a relation (does not delete it) so its shared memories remain
// viewable/read-only, while freeing both participants to start a new Our
// Story. Idempotent: ending an already-archived story just returns its
// current (already-archived) state as success, so two near-simultaneous
// "End Our Story" clicks — from either or both users — never error.
async function endRelation(relationId, userId) {
  const sb = getSupabaseAdmin();
  const { data: rel, error: findError } = await sb.from("relations").select("*").eq("id", relationId).maybeSingle();
  if (findError) throw findError;
  if (!rel || (rel.user1_id !== userId && rel.user2_id !== userId)) return { error: "Story not found." };
  if (rel.archived_at) return { relation: await relationView(rel) };
  const { data, error } = await sb.from("relations").update({ archived_at: now(), ended_at: now() }).eq("id", relationId).select("*").maybeSingle();
  if (!error) return { relation: await relationView(data) };
  if (/column .*?ended_at.*?(does not exist|unknown)/i.test(String(error.message || ""))) {
    const retry = await sb.from("relations").update({ archived_at: now() }).eq("id", relationId).select("*").maybeSingle();
    if (!retry.error) return { relation: await relationView(retry.data) };
  }
  if (isMissingColumnError(error, "archived_at")) return { error: "Ending Our Story isn't available yet — please run the latest database migration." };
  throw error;
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
  getActiveRelationForUser,
  listUserRelations,
  listPersonalEntries,
  listSharedEntries,
  upsertEntry,
  createInvite,
  listInvites,
  respondInvite,
  endRelation,
  archiveRelation,
  mutateEntries,
  reconcileEntries,
  getHighlights,
  rowToInvite
};
