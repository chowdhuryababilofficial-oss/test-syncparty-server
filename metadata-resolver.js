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
function keyFor(q) { return JSON.stringify([q.title || q.canonicalTitle || "", q.type || "", q.season ?? null, q.episode ?? null]); }

async function tmdb(path) {
  const token = process.env.TMDB_API_TOKEN || "";
  if (!token) return null;
  const r = await fetch(`${TMDB_BASE}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  if (!r.ok) return null;
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

async function resolve(input = {}) {
  const meta = input.meta || {};
  const provisional = input.provisional || {};
  const rawTitle = clean(provisional.canonicalTitle || provisional.title || meta.seriesTitle || meta.title || "");
  if (!rawTitle || rawTitle.length < 3) return null;
  const key = keyFor({ title: rawTitle, type: provisional.contentType, season: provisional.season ?? meta.season, episode: provisional.episode ?? meta.episode });
  const hit = cache.get(key); if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  let preferred = provisional.contentType === "anime" ? "tv" : provisional.contentType;
  let movieData = preferred === "tv" ? null : await tmdb(`/search/movie?query=${encodeURIComponent(rawTitle)}&include_adult=false&language=en-US&page=1`);
  let tvData = preferred === "movie" ? null : await tmdb(`/search/tv?query=${encodeURIComponent(rawTitle)}&include_adult=false&language=en-US&page=1`);
  const movie = movieData?.results?.map(x => ({ ...x, _score: similarity(rawTitle, x.title || x.original_title) + (x.release_date ? 0.02 : 0) })).sort((a,b) => b._score-a._score)[0] || null;
  const tv = tvData?.results?.map(x => ({ ...x, _score: similarity(rawTitle, x.name || x.original_name) + (x.first_air_date ? 0.02 : 0) })).sort((a,b) => b._score-a._score)[0] || null;

  const isEpisode = Number.isInteger(Number(provisional.episode ?? meta.episode)) || Number.isInteger(Number(provisional.season ?? meta.season));
  let selected = null;
  let contentType = null;
  if (preferred === "movie" && movie && movie._score >= 0.45) { selected = movie; contentType = "movie"; }
  else if ((preferred === "series" || preferred === "anime" || isEpisode) && tv && tv._score >= 0.45) { selected = tv; contentType = preferred === "anime" ? "anime" : "series"; }
  else if (tv && tv._score >= 0.62 && (!movie || tv._score >= movie._score)) { selected = tv; contentType = preferred === "anime" ? "anime" : "series"; }
  else if (movie && movie._score >= 0.62) { selected = movie; contentType = "movie"; }
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
    image(details?.poster_path, "w780"),
    image(details?.backdrop_path, "w1280"),
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
    backdrop: image(details?.backdrop_path, "w1280") || artworkCandidates[0] || null,
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
