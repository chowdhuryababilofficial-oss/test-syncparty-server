
const fs = require("fs");
const assert = require("assert");
const server = fs.readFileSync("./server.js", "utf8");

assert(server.includes('const roomPlaybackState = new Map();'), "server must keep latest Spotify room playback state");
assert(server.includes('"spotify-command", "spotify-request"'), "Spotify packets must be room-wide and not pageKey filtered");
assert(server.includes('const cachedPlayback = roomPlaybackState.get(room);'), "late join must read cached Spotify playback state");
assert(server.includes('payload: {\n            ...cachedPlayback,\n            replay: true'), "late join must receive cached playback payload");
assert(server.includes('if (kind === "spotify-command")'), "server must cache Spotify commands");
assert(server.includes('roomPlaybackState.set(s.room, cached);'), "server must preserve latest Spotify command/track metadata");
assert(server.includes('roomPlaybackState.delete(room);'), "room state must be cleared when a room is destroyed");
console.log("spotify-room-state.test.js: PASS");
