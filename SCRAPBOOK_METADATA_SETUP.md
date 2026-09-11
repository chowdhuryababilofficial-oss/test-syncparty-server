# Scrapbook Metadata Intelligence Setup

Scrapbook now uses a conservative local classifier first, then optionally resolves plausible media through TMDB on the SyncParty server. The TMDB credential stays server-side.

## Render
Add this environment variable:

`TMDB_API_TOKEN` = your TMDB API v4 bearer token

Keep existing Supabase and Google variables unchanged.

## Supabase
Run `supabase-schema.sql` once against the existing database. The migration is additive and preserves existing Scrapbook data.

## How it behaves
- Obvious YouTube tutorials/reactions/trailers/etc. are rejected locally before metadata lookup.
- Ambiguous but plausible movie/series/anime media can be verified by the backend.
- Canonical TMDB identity, poster/backdrop, season totals and episode totals are stored.
- Story percentage is calculated from the user's actual saved episode history plus the reliable total episode count; it is not inferred merely from the current URL.
- If TMDB is unavailable, the extension falls back to its existing local classification and never fabricates a story percentage.

TMDB attribution must remain in the product's About/Credits area. See the TMDB documentation/terms for current requirements.
