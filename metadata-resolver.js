const TMDB_BASE = "https://api.themoviedb.org/3";
const IMAGE_BASE = "https://image.tmdb.org/t/p";
const cache = new Map();
const CACHE_MS = 12 * 60 * 60 * 1000;
const MAX_TITLE = 240;

function clean(v, max = MAX_TITLE) { return String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max); }
function image(path, size = "w780") { return path ? `${IMAGE_BASE}/${size}${path.startsWith("/") ? path : `/${path}`}` : null; }
function normTitle(s) { return clean(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
function similarity(a, b) {
  const A = new Set(normTitle(a).split(" ").filter(Boolean));
  const B = new Set(normTitle(b).split(" ").filter(Boolean));
  if (!A.size || !B.size) return 0;
  let hit = 0; for (const x of A) if (B.has(x)) hit++;
  return hit / new Set([...A, ...B]).size;
}
function scoreFor(q, name, isSlug) {
  let s = similarity(q, name);
  if (isSlug) {
    const A = normTitle(q).split(" ").filter(Boolean);
    const B = new Set(normTitle(name).split(" ").filter(Boolean));
    if (A.length && A.join("").length >= 5 && A.every(t => B.has(t))) s = Math.max(s, 0.62);
  }
  return s;
}
function keyFor(q) { return JSON.stringify([q.title || q.canonicalTitle || "", q.type || "", q.season ?? null, q.episode ?? null]); }

async function tmdb(path) {
  const token = process.env.TMDB_API_TOKEN || "";
  if (!token) return null;
  const r = await fetch(`${TMDB_BASE}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  if (!r.ok) { console.error("[SyncParty TMDB] request failed", r.status, String(path).split("?")[0]); return null; }
  return r.json();
}

async function seasonCounts(id, numberOfSeasons) {
  const counts = {};
  for (let n = 1; n <= Math.min(Number(numberOfSeasons) || 0, 40); n++) {
    const data = await tmdb(`/tv/${id}/season/${n}`);
    if (data && Array.isArray(data.episodes)) counts[n] = data.episodes.filter(e => Number(e?.episode_number) > 0).length;
  }
  return counts;
}

// Turn any page-derived string into a searchable TITLE: drop season/episode
// wording, year, quality tags and brand-style suffixes so "Lanterns - Season 1
// Episode 1" queries TMDB as "Lanterns". Similarity scoring needs the bare
// title; the noisy form scored 0.25 against the correct show and was rejected.
function cleanQuery(v) {
  let t = clean(v, MAX_TITLE);
  t = t.replace(/\bS\d{1,2}\s*[x\-]?\s*E\d{1,3}\b/ig, " ")
    .replace(/\bseason\s*\d+\b/ig, " ").replace(/\bepisode\s*\d+\b/ig, " ").replace(/\bep\.?\s*\d+\b/ig, " ")
    .replace(/\((?:19|20)\d{2}\)/g, " ").replace(/\s(?:19|20)\d{2}$/, " ").replace(/\b(?:full movie|full film|watch online|watch free|online free|free online|hd|1080p|720p)\b/ig, " ")
    .replace(/\s*[|\u2022]\s*.*$/, " ");
  t = t.replace(/\s+[-\u2013\u2014]\s*$/g, " ").replace(/^\s*[-\u2013\u2014]\s+/g, " ");
  return clean(t.replace(/\s+[-\u2013\u2014]\s+(?=$)/, " "));
}
function slugQueries(pathname) {
  const out = [];
  try {
    for (const seg of String(pathname || "").split("/").filter(Boolean).reverse()) {
      const words = decodeURIComponent(seg).replace(/\.(?:html?|php|aspx?)$/i, "").replace(/[_+.-]+/g, " ");
      if (words.replace(/[^a-z]/gi, "").length < 3) continue;
      if (/^(?:watch|video|player|embed|stream|episode|ep|season|tv|movie|movies|series|anime|home|play|shows?|films?)$/i.test(words.trim())) continue;
      out.push(words);
    }
  } catch {}
  return out;
}
function queryCandidates(provisional, meta) {
  const raw = [provisional.canonicalTitle, provisional.title, meta.seriesTitle, meta.title,
    ...(Array.isArray(meta.titleCandidates) ? meta.titleCandidates : []), ...slugQueries(meta.pathname)];
  const seen = new Set(); const out = []; const slugSet = new Set();
  const slugKeys = new Set(slugQueries(meta.pathname).map(x => normTitle(cleanQuery(x))));
  const expanded = [];
  for (const r of raw) {
    expanded.push(r);
    // "Resident Evil: Afterlife - Cinejoy": the server cannot know every site's
    // brand, so also try each side of a separator as its own title query.
    const parts = String(r || "").split(/\s+[-\u2013\u2014|]\s+/);
    if (parts.length > 1) expanded.push(...parts);
  }
  for (const r of expanded) {
    const q = cleanQuery(r);
    const k = normTitle(q);
    if (!q || q.length < 3 || !k || seen.has(k)) continue;
    seen.add(k); out.push(q);
    if (slugKeys.has(k)) slugSet.add(q);
    if (out.length >= 8) break;
  }
  out.slug = slugSet;
  return out;
}

async function resolve(input = {}) {
  const meta = input.meta || {};
  const provisional = input.provisional || {};
  const sHint = provisional.season ?? meta.season;
  const eHint = provisional.episode ?? meta.episode;
  const queries = queryCandidates(provisional, meta);
  if (!queries.length) return null;
  let rawTitle = queries[0];
  const key = keyFor({ title: queries.join("|"), type: provisional.contentType, season: sHint, episode: eHint });
  const hit = cache.get(key); if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  // When the classifier had no title to work with (identity only in slug /
  // candidates) it also has no content type; the page's own anime hints still
  // decide Series vs Anime.
  const animeHint = /\/anime(?:\/|$)/i.test(String(meta.pathname || "")) || (Array.isArray(meta.typeHints) ? meta.typeHints : []).some(h => /^anime$/i.test(String(h)));
  const wantsAnime = provisional.contentType === "anime" || (!provisional.contentType && animeHint);
  const preferred = wantsAnime ? "tv" : provisional.contentType;
  const isEpisode = Number.isInteger(Number(eHint)) || Number.isInteger(Number(sHint));
  let selected = null;
  let contentType = null;
  // The page may expose the real title in ANY of several fields (h1, JSON-LD,
  // slug, player title). Try each cleaned query in priority order and stop at
  // the first confident TMDB match, instead of betting on a single field.
  for (const q of queries) {
    const movieData = preferred === "tv" ? null : await tmdb(`/search/movie?query=${encodeURIComponent(q)}&include_adult=false&language=en-US&page=1`);
    const tvData = preferred === "movie" ? null : await tmdb(`/search/tv?query=${encodeURIComponent(q)}&include_adult=false&language=en-US&page=1`);
    const movie = movieData?.results?.map(x => ({ ...x, _score: scoreFor(q, x.title || x.original_title, queries.slug.has(q)) + (x.release_date ? 0.02 : 0) })).sort((a,b) => b._score-a._score)[0] || null;
    const tv = tvData?.results?.map(x => ({ ...x, _score: scoreFor(q, x.name || x.original_name, queries.slug.has(q)) + (x.first_air_date ? 0.02 : 0) })).sort((a,b) => b._score-a._score)[0] || null;
    if (preferred === "movie" && movie && movie._score >= 0.45) { selected = movie; contentType = "movie"; }
    else if ((preferred === "series" || preferred === "anime" || isEpisode) && tv && tv._score >= 0.45) { selected = tv; contentType = wantsAnime ? "anime" : "series"; }
    else if (tv && tv._score >= 0.62 && (!movie || tv._score >= movie._score)) { selected = tv; contentType = wantsAnime ? "anime" : "series"; }
    else if (movie && movie._score >= 0.62) { selected = movie; contentType = "movie"; }
    if (selected && contentType) { rawTitle = q; break; }
  }
  if (!selected || !contentType) return null;

  let details = null;
  let seriesEpisodeCounts = null;
  let storyTotalEpisodes = 0;
  let storyEpisodesCompleted = 0;
  let storyProgress = null;
  let storyProgressConfidence = null;
  if (contentType === "movie") {
    details = await tmdb(`/movie/${selected.id}?language=en-US`);
  } else {
    details = await tmdb(`/tv/${selected.id}?language=en-US`);
    if (details?.number_of_seasons) {
      seriesEpisodeCounts = await seasonCounts(selected.id, details.number_of_seasons);
      storyTotalEpisodes = Object.values(seriesEpisodeCounts).reduce((a,b)=>a+b,0);
      if (storyTotalEpisodes > 0) storyProgressConfidence = Object.keys(seriesEpisodeCounts).length >= Math.min(details.number_of_seasons, 3) ? 0.92 : 0.75;
      // Do not infer that earlier episodes were watched merely because the
      // current URL is S2E3. The page layer combines the user's actual saved
      // episode history with this reliable total to calculate story progress.
    }
  }

  // Episode name, only when we have a confident series match AND a real
  // season+episode. TMDB is authoritative here, so this is the most reliable
  // episode-title source we have; a miss simply leaves it null and the UI
  // falls back to "Episode N" rather than guessing from the page title.
  let episodeTitle = null;
  if (contentType !== "movie") {
    const sNum = Number(provisional.season ?? meta.season);
    const eNum = Number(provisional.episode ?? meta.episode);
    if (Number.isInteger(sNum) && sNum > 0 && Number.isInteger(eNum) && eNum > 0) {
      const ep = await tmdb(`/tv/${selected.id}/season/${sNum}/episode/${eNum}?language=en-US`);
      const epName = clean(ep?.name || "");
      // TMDB returns a placeholder like "Episode 5" when it has no real title.
      if (epName && !/^episode\s*\d+$/i.test(epName)) episodeTitle = epName;
    }
  }

  const artworkCandidates = [
    image(details?.poster_path || selected.poster_path, "w780"),
    image(details?.backdrop_path || selected.backdrop_path, "w1280"),
    ...((meta.imageCandidates || []).filter(Boolean))
  ].filter(Boolean);
  const value = {
    eligible: true,
    metadataProvider: "tmdb",
    metadataId: String(selected.id),
    metadataYear: Number(String(details?.release_date || details?.first_air_date || "").slice(0,4)) || null,
    title: contentType === "movie" ? clean(details?.title || selected.title || rawTitle) : clean(details?.name || selected.name || rawTitle),
    canonicalTitle: contentType === "movie" ? clean(details?.title || selected.title || rawTitle) : clean(details?.name || selected.name || rawTitle),
    contentType,
    season: Number.isInteger(Number(provisional.season ?? meta.season)) ? Number(provisional.season ?? meta.season) : null,
    episode: Number.isInteger(Number(provisional.episode ?? meta.episode)) ? Number(provisional.episode ?? meta.episode) : null,
    episodeTitle,
    artwork: artworkCandidates[0] || null,
    backdrop: image(details?.backdrop_path || selected.backdrop_path, "w1280") || artworkCandidates[0] || null,
    artworkCandidates: artworkCandidates.slice(0, 10),
    storyTotalEpisodes,
    storyEpisodesCompleted,
    storyProgress,
    storyProgressConfidence,
    seriesEpisodeCounts,
    totalRuntimeSec: contentType === "movie" && details?.runtime ? Number(details.runtime) * 60 : 0,
    externalUrl: `https://www.themoviedb.org/${contentType === "movie" ? "movie" : "tv"}/${selected.id}`,
    providerAttribution: "tmdb"
  };
  cache.set(key, { at: Date.now(), value });
  return value;
}
module.exports = { resolve };
