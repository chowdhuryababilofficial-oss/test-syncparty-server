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
function broadcastPeers(room) {
  const set = rooms.get(room); if (!set) return;
  const peers = [...set].map(ws => { const s = clients.get(ws); return { id: s.id, ...s.profile }; });
  broadcast(room, { type: "peers", peers, count: set.size });
}
function detachSocket(ws, announce = true, removeClient = true) {
  const s = clients.get(ws);
  if (!s) return;
  const room = s.room;
  const name = s.profile?.name || "Someone";
  if (room && rooms.has(room)) {
    rooms.get(room).delete(ws);
    if (rooms.get(room).size) {
      if (announce) {
        broadcastPeers(room);
        broadcast(room, { type: "message", payload: { kind: "system", text: `${name} left the party`, t: Date.now() } });
      } else {
        broadcastPeers(room);
      }
    } else {
      rooms.delete(room);
      roomTargets.delete(room);
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

      if (!rooms.has(room)) rooms.set(room, new Set());
      const set = rooms.get(room);
      const wasEmpty = set.size === 0;
      if (!roomTargets.has(room) && s.pageUrl) roomTargets.set(room, s.pageUrl);
      set.add(ws);

      send(ws, { type: "you", id: s.id, clientId: s.clientId });
      send(ws, { type: "room-info", room, targetUrl: roomTargets.get(room) || null });
      broadcastPeers(room);
      if (!wasEmpty) broadcast(room, { type: "message", payload: { kind: "system", text: `${s.profile.name} joined the party`, t: Date.now() } }, ws);
      return;
    }

    if (m.type === "message" && s.room === norm(m.room)) {
      const p = m.payload;
      if (!p || typeof p !== "object") return;

      const kind = String(p.kind || "");
      const roomWideKinds = new Set([
        "chat", "sticker", "typing", "presence", "profile",
        "messageReaction", "reaction", "buffering", "system", "navigate"
      ]);
      if (!roomWideKinds.has(kind) && p.pageKey && s.pageKey && p.pageKey !== s.pageKey) return;

      if (kind === "navigate") {
        const target = normalizeUrl(p.url);
        if (!target) return;
        roomTargets.set(s.room, target);
        s.pageUrl = target;
        s.pageKey = String(p.pageKey || s.pageKey || "");
      }

      const profile = sanitizeProfile(p);
      if (kind === "profile" || kind === "presence" || kind === "chat" || kind === "sticker") s.profile = profile;

      broadcast(s.room, {
        type: "message",
        payload: {
          ...p,
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
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 25000).unref();

httpServer.listen(port, "0.0.0.0", () => console.log(`SyncParty relay listening at http://127.0.0.1:${port}`));
