const http = require("http");
const { WebSocketServer } = require("ws");
const port = Number(process.env.PORT || 8787);
const rooms = new Map();   // room -> Set<ws>
const clients = new Map(); // ws -> {id, room, pageKey, profile}

const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify({ ok: true, name: "SyncParty Relay", version: "0.5.3" }));
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
function broadcastPeers(room) {
  const set = rooms.get(room); if (!set) return;
  const peers = [...set].map(ws => { const s = clients.get(ws); return { id: s.id, ...s.profile }; });
  broadcast(room, { type: "peers", peers, count: set.size });
}

wss.on("connection", ws => {
  const id = randId();
  clients.set(ws, { id, room: null, pageKey: null, profile: null });
  send(ws, { type: "system", text: "SyncParty connected." });

  ws.on("message", raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    const s = clients.get(ws); if (!s) return;

    if (m.type === "join") {
      const room = norm(m.room); if (room.length !== 6) return;
      // leaving a previous room first
      if (s.room && rooms.has(s.room)) {
        rooms.get(s.room).delete(ws);
        if (rooms.get(s.room).size) {
          broadcastPeers(s.room);
          broadcast(s.room, { type: "message", payload: { kind: "system", text: `${s.profile?.name || "Someone"} left the party`, t: Date.now() } });
        } else rooms.delete(s.room);
      }
      s.room = room;
      s.pageKey = String(m.pageKey || "");
      s.profile = sanitizeProfile(m.profile);
      if (!rooms.has(room)) rooms.set(room, new Set());
      const wasEmpty = rooms.get(room).size === 0;
      rooms.get(room).add(ws);
      send(ws, { type: "you", id: s.id });
      broadcastPeers(room);
      if (!wasEmpty) broadcast(room, { type: "message", payload: { kind: "system", text: `${s.profile.name} joined the party`, t: Date.now() } }, ws);
      return;
    }

    if (m.type === "message" && s.room === norm(m.room)) {
      const p = m.payload;
      if (!p || typeof p !== "object") return;
      if (p.pageKey && s.pageKey && p.pageKey !== s.pageKey) return;
      broadcast(s.room, { type: "message", payload: p }, ws);
    }
  });

  ws.on("close", () => {
    const s = clients.get(ws); if (!s) return;
    if (s.room && rooms.has(s.room)) {
      rooms.get(s.room).delete(ws);
      if (rooms.get(s.room).size) {
        broadcastPeers(s.room);
        broadcast(s.room, { type: "message", payload: { kind: "system", text: `${s.profile?.name || "Someone"} left the party`, t: Date.now() } });
      } else rooms.delete(s.room);
    }
    clients.delete(ws);
  });
});

wss.on("connection", ws => { ws.isAlive = true; ws.on("pong", () => ws.isAlive = true); });
setInterval(() => { for (const ws of wss.clients) { if (ws.isAlive === false) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); } }, 25000).unref();

httpServer.listen(port, "0.0.0.0", () => console.log(`SyncParty relay listening at http://127.0.0.1:${port}`));
