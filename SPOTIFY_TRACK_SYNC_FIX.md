# Spotify Track Sync Fix

## Root causes

1. The Relay server treated `spotify-command` as page-scoped traffic. If participants had different Spotify URLs/pageKeys, the server dropped the command before it reached the receiving client. Play/pause could appear to work when both tabs happened to share the same pageKey.
2. The Relay server had no cached Spotify playback state. A late joiner therefore had no authoritative track URI/position until a future live packet.
3. The Spotify client attempted to click an existing track anchor but returned immediately, then applied seek/play against whatever track was still active. It did not wait for the requested track to become the active media identity.
4. Spotify commands already carried a track ID/URL, but the transport and track-activation path were incomplete.

## Fix

- `spotify-command` and `spotify-request` are explicitly room-wide server packets and bypass pageKey filtering.
- Server stores the latest `spotify-command` per live room and replays it to a late joiner.
- Spotify commands now carry `trackId`, `trackUri`, and `trackUrl`.
- Remote track activation waits until the target track identity is observed before applying position/play.
- Existing single WebSocket architecture is unchanged.
- Standard/Theater/Engine Resolver/SP_ISLAND/video-discovery/player-layout/state/playback-sync are untouched.

## Late join

A joins and is playing track X at ~60 seconds.
B joins the room.
Server sends the cached authoritative Spotify state to B.
B's Spotify adapter sees the track identity, loads/navigates to that exact track, waits for it to become active, applies the saved position and playing state, and then continues receiving live commands.

## No Supabase change

This fix is entirely in the Spotify client + existing relay WebSocket path. Supabase schema/API is not involved.
