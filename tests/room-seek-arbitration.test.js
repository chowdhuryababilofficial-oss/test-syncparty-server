// Executes the shipped relay playback functions with deterministic room/socket
// stubs. This is a unit test of server.js, not a copied implementation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../server.js'), 'utf8');
const start = source.indexOf('function playbackClock()');
const end = source.indexOf('function retainEmptyRoom(room)');
assert.ok(start >= 0 && end > start, 'playback function block exists in server.js');

const broadcasted = [];
const sent = [];
let id = 0;
const context = {
  Date, Math, Number, String, Set, Map, process,
  roomPlayback: new Map(),
  randId: () => `id-${++id}`,
  broadcast: (room, message) => broadcasted.push({ room, message }),
  send: (ws, message) => sent.push({ ws, message }),
  activeTransition: () => null,
  maybeReleaseTransition: () => {},
  RECENT_MEMBER_MS: 60_000,
  clearRoomDepartures: () => {},
  rooms: new Map(),
  roomTargets: new Map(),
  navigationTransitions: new Map(),
  setTimeout: () => ({ unref() {} }),
  clearTimeout: () => {}
};
vm.createContext(context);
vm.runInContext(source.slice(start, end), context, { filename: 'server.js#playback' });

const room = 'SEEK01';
const x = context.playbackFor(room, true);
x.initialized = true;
x.time = 1200;
x.at = context.playbackClock();
x.playing = true;
x.controller = 'ana';
x.controllerAt = context.playbackClock();
x.revision = 8;

function actor(clientId, name) {
  return { room, clientId, profile: { name }, lastSyncSeq: 0, nextSyncSeq: 0 };
}
function command(s, event, time, overrides = {}) {
  return {
    kind: 'sync', event, time, playing: true, rate: 1,
    commandId: `${s.clientId}-${s.lastSyncSeq + 1}`,
    roomEpoch: x.epoch, baseRevision: x.revision,
    syncSeq: ++s.nextSyncSeq, sampleAgeMs: 0, ...overrides
  };
}
function lastAck(clientId) {
  return [...broadcasted, ...sent].map(x => x.message.payload?.ack).filter(ack => ack?.clientId === clientId).at(-1);
}
function lastSystemLine() {
  return broadcasted.map(x => x.message.payload).filter(p => p?.kind === 'system' && /jumped to/.test(p.text || '')).at(-1);
}

// A user's seek may be held locally while room revision advances. This is a
// fresh gesture, so its server receipt order wins, but delayed packets do not.
const fay = actor('fay', 'Fay');
const initialRevision = x.revision;
context.handlePlaybackMessage({ id: 'socket-fay' }, fay, command(fay, 'seeked', 918,
  { baseRevision: initialRevision - 1, commandId: 'fay-long-seek-1' }));
assert.equal(x.revision, initialRevision + 1, 'fresh explicit seek commits despite an old base revision');
assert.equal(x.controller, 'fay', 'explicit seek transfers controller authority');
assert.equal(x.time, 918, 'relay timeline lands on the final requested seek position');
assert.equal(lastAck('fay')?.accepted, true, 'sender receives accepted ACK');
assert.equal(lastSystemLine()?.text, 'Fay jumped to 15:18', 'chat activity names the actor and settled timestamp');

const timeAfterAccepted = x.time;
context.handlePlaybackMessage({ id: 'socket-fay' }, fay, command(fay, 'seeked', 1800,
  { baseRevision: 0, commandId: 'fay-delayed-seek', sampleAgeMs: 5000 }));
assert.equal(lastAck('fay')?.accepted, false, 'expired seek packet is rejected');
assert.equal(lastAck('fay')?.reason, 'expired', 'expired seek has a clear rejection reason');
assert.equal(x.time, timeAfterAccepted, 'expired seek cannot overwrite the accepted timeline');

context.handlePlaybackMessage({ id: 'socket-fay' }, fay, command(fay, 'seeked', 1700,
  { baseRevision: 0, commandId: 'seek-without-age', sampleAgeMs: undefined }));
assert.equal(lastAck('fay')?.accepted, false, 'a stale seek without a fresh sample age is not allowed to bypass revision arbitration');
assert.equal(lastAck('fay')?.reason, 'stale-revision', 'missing freshness metadata retains stale-revision rejection');
assert.equal(x.time, timeAfterAccepted, 'seek without freshness metadata cannot move the room timeline');

context.handlePlaybackMessage({ id: 'socket-fay' }, fay, command(fay, 'seeked', 1750,
  { baseRevision: 0, commandId: 'seek-without-sequence', syncSeq: undefined }));
assert.equal(lastAck('fay')?.accepted, false, 'a stale seek without ordered sequence metadata is rejected');
assert.equal(lastAck('fay')?.reason, 'stale-revision', 'missing sequence metadata retains stale-revision rejection');
assert.equal(x.time, timeAfterAccepted, 'unordered seek cannot move the room timeline');

context.handlePlaybackMessage({ id: 'socket-fay' }, fay, command(fay, 'seeked', -1,
  { baseRevision: 0, commandId: 'seek-invalid-time', sampleAgeMs: 0 }));
assert.equal(lastAck('fay')?.accepted, false, 'invalid seek timestamp cannot use the stale-revision exception');
assert.equal(lastAck('fay')?.reason, 'stale-revision', 'invalid seek timestamp retains stale-revision rejection');
assert.equal(x.time, timeAfterAccepted, 'invalid seek timestamp cannot move the room timeline');

const another = actor('ana', 'Ana');
x.playing = false; // avoid the idempotent already-playing shortcut; exercise stale Play arbitration.
context.handlePlaybackMessage({ id: 'socket-ana' }, another, command(another, 'play', 50,
  { baseRevision: 0, commandId: 'ana-stale-play' }));
assert.equal(lastAck('ana')?.accepted, false, 'stale Play remains rejected');
assert.equal(lastAck('ana')?.reason, 'stale-revision', 'stale Play is still protected by revision checks');
assert.equal(x.time, timeAfterAccepted, 'stale Play cannot roll back the seek');

x.holds.set('peer', { name: 'Peer', reasons: new Set(['buffering']) });
context.handlePlaybackMessage({ id: 'socket-fay' }, fay, command(fay, 'seeked', 2400,
  { baseRevision: x.revision, commandId: 'seek-while-held' }));
assert.equal(lastAck('fay')?.accepted, false, 'room readiness hold still blocks seek');
assert.equal(lastAck('fay')?.reason, 'not-ready', 'held room explains the rejection');
assert.equal(x.time, timeAfterAccepted, 'seek cannot move timeline through a room hold');

x.holds.clear();
fay.lastSyncSeq = 9; fay.nextSyncSeq = 9;
context.handlePlaybackMessage({ id: 'socket-fay' }, fay, command(fay, 'seeked', 2600,
  { syncSeq: 9, baseRevision: x.revision, commandId: 'duplicate-seek-seq' }));
assert.equal(lastAck('fay')?.accepted, false, 'duplicate/out-of-order seek sequence is rejected');
assert.equal(lastAck('fay')?.reason, 'out-of-order', 'sequence guard remains active for seeks');

console.log('Room seek arbitration tests: PASS (stale-revision intent arbitration, accepted seek activity, expired packets, stale Play, room holds, sync sequence ordering)');
