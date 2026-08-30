const http = require("http");
const { WebSocketServer } = require("ws");
const port = Number(process.env.PORT || 8787);

// One live WebSocket per stable clientId. A browser tab keeps clientId in
// sessionStorage, so a reload replaces the previous connection instead of
// creating a second participant.
const rooms = new Map();   // room -> Set<ws>
const roomTargets = new Map(); // room -> canonical destination URL
const clients = new Map(); // ws -> session state
const clientSockets = new Map(); // stable clientId -> current ws
const navigationTransitions = new Map(); // room -> active readiness barrier
const NAV_TRANSITION_TTL_MS = 30000;
const NAV_DISCONNECT_GRACE_MS = 15000;

const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify({ ok: true, name: "SyncParty Relay", version: "0.6.0" }));
});

const wss = new WebSocketServer({ server: httpServer });

function norm(s) { return String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6); }
function randId() { return Math.random().toString(36).slice(2, 10); }
function send(ws, o) { if (ws.readyState === 1) ws.send(JSON.stringify(o)); }
function broadcast(room, o, skip = null) {
  const set = rooms.get(room); if (!set) return;
  for (const ws of set) if (ws !== skip) send(ws, o);
}
function sanitizeProfile(p) {
  return {
    name: String(p?.name || "Guest").slice(0, 24),
    avatar: String(p?.avatar || "🙂").slice(0, 4),
    color: String(p?.color || "#54a0ff").slice(0, 16)
  };
}
function normalizeUrl(raw) {
  try {
    const u = new URL(String(raw || ""));
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.searchParams.delete("spRoom");
    return u.toString();
  } catch { return null; }
}
function activeTransition(room) {
  const t = navigationTransitions.get(room);
  if (!t) return null;
  if (Date.now() > t.expiresAt) {
    navigationTransitions.delete(room);
    return null;
  }
  return t;
}
function transitionPeerRecord(s) {
  return {
    id: s.clientId || s.id,
    name: s.profile?.name || "Guest",
    avatar: s.profile?.avatar || "🙂",
    color: s.profile?.color || "#54a0ff"
  };
}
function broadcastPeers(room) {
  const set = rooms.get(room); if (!set) return;
  const t = activeTransition(room);
  const byId = new Map();
  for (const ws of set) {
    const s = clients.get(ws); if (!s) continue;
    byId.set(s.clientId || s.id, transitionPeerRecord(s));
  }
  if (t) {
    for (const [id, meta] of t.participants) if (!byId.has(id)) byId.set(id, { id, ...meta });
  }
  const peers = [...byId.values()];
  broadcast(room, { type: "peers", peers, count: peers.length });
}
function sendTransitionState(ws, t) {
  if (!t) return;
  send(ws, {
    type: "transition-state",
    active: true,
    transitionId: t.id,
    url: t.url,
    title: t.title,
    reason: t.reason,
    releaseAt: t.releaseAt || null,
    requiredCount: t.required.size,
    readyCount: t.ready.size
  });
}
function cleanupTransitionParticipant(room, clientId) {
  const t = activeTransition(room);
  if (!t || !clientId) return;
  const live = [...(rooms.get(room) || [])].some(ws => clients.get(ws)?.clientId === clientId);
  if (live) return;
  t.required.delete(clientId);
  t.ready.delete(clientId);
  t.participants.delete(clientId);
  broadcastPeers(room);
  maybeReleaseTransition(room);
  if (!t.required.size && (!rooms.get(room) || rooms.get(room).size === 0)) {
    navigationTransitions.delete(room);
    rooms.delete(room);
    roomTargets.delete(room);
  }
}
function maybeReleaseTransition(room) {
  const t = activeTransition(room);
  if (!t || t.released || !t.required.size) return;
  for (const id of t.required) if (!t.ready.has(id)) return;
  t.released = true;
  t.releaseAt = Date.now() + 900;
  broadcast(room, { type: "message", payload: {
    kind: "transition-release",
    transitionId: t.id,
    url: t.url,
    releaseAt: t.releaseAt,
    time: 0
  }});
  setTimeout(() => {
    const current = activeTransition(room);
    if (current === t) navigationTransitions.delete(room);
  }, 5000).unref();
}
function startNavigationTransition(room, initiator, p) {
  const set = rooms.get(room); if (!set) return null;
  const url = normalizeUrl(p.url); if (!url) return null;
  const t = {
    id: `nav_${Date.now().toString(36)}_${randId()}`,
    url,
    title: String(p.title || ""),
    reason: String(p.reason || "url-change"),
    createdAt: Date.now(),
    expiresAt: Date.now() + NAV_TRANSITION_TTL_MS,
    releaseAt: null,
    released: false,
    required: new Set(),
    ready: new Set(),
    participants: new Map()
  };
  for (const ws of set) {
    const s = clients.get(ws); if (!s) continue;
    const id = s.clientId || s.id;
    t.required.add(id);
    t.participants.set(id, transitionPeerRecord(s));
  }
  // Always include the initiating connection even if an unusual client frame
  // was not in the room Set at the instant this packet was handled.
  if (initiator) {
    const s = clients.get(initiator);
    if (s) {
      const id = s.clientId || s.id;
      t.required.add(id);
      t.participants.set(id, transitionPeerRecord(s));
    }
  }
  t.required.forEach(id => t.ready.delete(id));
  navigationTransitions.set(room, t);
  roomTargets.set(room, url);
  const transitionPayload = {
    kind: "transition-start",
    transitionId: t.id,
    url: t.url,
    title: t.title,
    reason: t.reason,
    requiredCount: t.required.size,
    readyCount: 0
  };
  broadcast(room, { type: "message", payload: transitionPayload });
  return t;
}
function detachSocket(ws, announce = true, removeClient = true) {
  const s = clients.get(ws);
  if (!s) return;
  const room = s.room;
  const name = s.profile?.name || "Someone";
  const t = activeTransition(room);
  const stableId = s.clientId || s.id;
  const gracefulNavigation = !!(t && t.required.has(stableId));
  if (room && rooms.has(room)) {
    rooms.get(room).delete(ws);
    if (rooms.get(room).size) {
      if (announce && !gracefulNavigation) {
        broadcastPeers(room);
        broadcast(room, { type: "message", payload: { kind: "system", text: `${name} left the party`, t: Date.now() } });
      } else {
        broadcastPeers(room);
      }
    } else if (gracefulNavigation) {
      // Keep the room alive for the navigation handoff; the stable participant
      // remains represented by the transition snapshot until the grace window ends.
      broadcastPeers(room);
      setTimeout(() => cleanupTransitionParticipant(room, stableId), NAV_DISCONNECT_GRACE_MS).unref();
    } else {
      rooms.delete(room);
      roomTargets.delete(room);
      navigationTransitions.delete(room);
    }
  }
  if (s.clientId && clientSockets.get(s.clientId) === ws) clientSockets.delete(s.clientId);
  s.room = null;
  if (removeClient) clients.delete(ws);
}

wss.on("connection", ws => {
  const id = randId();
  clients.set(ws, { id, clientId: null, room: null, pageKey: null, pageUrl: null, profile: null });
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
  send(ws, { type: "system", text: "SyncParty connected." });

  ws.on("message", raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const s = clients.get(ws); if (!s) return;

    if (m.type === "join") {
      const room = norm(m.room); if (room.length !== 6) return;
      const clientId = String(m.clientId || "").trim().slice(0, 128);

      // Replace any older live socket belonging to the same browser tab.
      if (clientId) {
        const old = clientSockets.get(clientId);
        if (old && old !== ws) {
          detachSocket(old, false);
          try { old.close(4001, "replaced by newer tab connection"); } catch {}
        }
      }

      // A single socket cannot belong to multiple rooms.
      if (s.room) detachSocket(ws, true, false);

      s.room = room;
      s.clientId = clientId || s.clientId || s.id;
      s.id = s.clientId || s.id;
      s.pageKey = String(m.pageKey || "");
      s.pageUrl = normalizeUrl(m.pageUrl);
      s.profile = sanitizeProfile(m.profile);
      clientSockets.set(s.clientId, ws);

      const existingTransition = activeTransition(room);
      if (!rooms.has(room)) rooms.set(room, new Set());
      const set = rooms.get(room);
      const wasEmpty = set.size === 0;
      if (!roomTargets.has(room) && s.pageUrl) roomTargets.set(room, s.pageUrl);
      set.add(ws);

      if (existingTransition) {
        // A reconnecting tab must prove readiness again on its newly loaded page;
        // otherwise the old page's ready bit could release the barrier early.
        existingTransition.required.add(s.clientId);
        existingTransition.ready.delete(s.clientId);
        existingTransition.participants.set(s.clientId, transitionPeerRecord(s));
      }

      send(ws, { type: "you", id: s.id, clientId: s.clientId });
      send(ws, { type: "room-info", room, targetUrl: roomTargets.get(room) || null, transition: existingTransition ? { active:true, transitionId:existingTransition.id, url:existingTransition.url, title:existingTransition.title, reason:existingTransition.reason, releaseAt:existingTransition.releaseAt || null, requiredCount:existingTransition.required.size, readyCount:existingTransition.ready.size } : null });
      if (existingTransition) sendTransitionState(ws, existingTransition);
      broadcastPeers(room);
      // During an active navigation handoff, presence is continuous: do not emit
      // a generic joined-party chat line for a reconnecting/newly arrived socket.
      if (!existingTransition && !wasEmpty) broadcast(room, { type: "message", payload: { kind: "system", text: `${s.profile.name} joined the party`, t: Date.now() } }, ws);
      return;
    }

    if (m.type === "message" && s.room === norm(m.room)) {
      const p = m.payload;
      if (!p || typeof p !== "object") return;

      const kind = String(p.kind || "");
      const roomWideKinds = new Set([
        "chat", "sticker", "typing", "presence", "profile",
        "messageReaction", "reaction", "buffering", "system", "navigate", "transition-ready"
      ]);
      if (!roomWideKinds.has(kind) && p.pageKey && s.pageKey && p.pageKey !== s.pageKey) return;

      if (kind === "navigate") {
        const target = normalizeUrl(p.url);
        if (!target) return;
        const t = startNavigationTransition(s.room, ws, p);
        if (!t) return;
        s.pageUrl = target;
        s.pageKey = String(p.pageKey || s.pageKey || "");
        // The transition-start packet above establishes the barrier for every
        // participant. Keep the original navigate packet for URL routing/toast.
      }

      if (kind === "transition-ready") {
        const t = activeTransition(s.room);
        if (!t || !t.required.has(s.clientId)) return;
        if (p.transitionId && String(p.transitionId) !== String(t.id)) return;
        t.ready.add(s.clientId);
        const liveProfile = sanitizeProfile(p);
        t.participants.set(s.clientId, liveProfile);
        broadcastPeers(s.room);
        maybeReleaseTransition(s.room);
        return;
      }

      const profile = sanitizeProfile(p);
      if (kind === "profile" || kind === "presence" || kind === "chat" || kind === "sticker") s.profile = profile;

      broadcast(s.room, {
        type: "message",
        payload: {
          ...p,
          transitionId: kind === "navigate" ? activeTransition(s.room)?.id : p.transitionId,
          url: kind === "navigate" ? normalizeUrl(p.url) : p.url,
          id: p.id || s.id,
          name: profile.name,
          avatar: profile.avatar,
          color: profile.color
        }
      }, ws);

      if (kind === "profile" || kind === "presence") broadcastPeers(s.room);
      return;
    }

    if (m.type === "leave" && s.room === norm(m.room)) {
      detachSocket(ws, true);
      try { ws.close(1000, "left room"); } catch {}
      return;
    }
  });

  ws.on("close", () => {
    detachSocket(ws, true);
  });
});

setInterval(() => {
  for (const [room, t] of navigationTransitions) {
    if (Date.now() > t.expiresAt) {
      navigationTransitions.delete(room);
      if ((!rooms.get(room) || rooms.get(room).size === 0) && roomTargets.has(room)) {
        rooms.delete(room);
        roomTargets.delete(room);
      }
    }
  }
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 25000).unref();

httpServer.listen(port, "0.0.0.0", () => console.log(`SyncParty relay listening at http://127.0.0.1:${port}`));
