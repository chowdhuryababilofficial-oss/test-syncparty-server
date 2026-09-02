const http = require("http");
const { WebSocketServer } = require("ws");
const { normalizeEmail, createEmailUser, authenticateEmail, getUserById, getGoogleUser, createGoogleUser, updateGoogleUser, createSession, resolveSession, revokeSession, publicUser } = require("./auth-store");
const scrapbook = require("./scrapbook-store");
const port = Number(process.env.PORT || 8787);

// One live WebSocket per stable clientId. A browser tab keeps clientId in
// sessionStorage, so a reload replaces the previous connection instead of
// creating a second participant.
const rooms = new Map();
const roomTargets = new Map();
const roomPlaybackState = new Map(); // room -> latest authoritative Spotify state/command
const clients = new Map();
const clientSockets = new Map();
const navigationTransitions = new Map();
const NAV_TRANSITION_TTL_MS = 30000;
const NAV_DISCONNECT_GRACE_MS = 15000;

function json(res, status, body, extra={}) {
  res.writeHead(status, { "Content-Type":"application/json", "Cache-Control":"no-store", "Access-Control-Allow-Origin":"*", "Access-Control-Allow-Headers":"Content-Type, Authorization", "Access-Control-Allow-Methods":"GET,POST,OPTIONS", ...extra });
  res.end(JSON.stringify(body));
}
async function readJson(req) {
  let raw=""; for await (const chunk of req) raw += chunk; try { return JSON.parse(raw || "{}"); } catch { return {}; }
}
function bearer(req) { return req.headers.authorization || ""; }
async function requireUser(req,res) {
  const user=await resolveSession(bearer(req));
  if(!user){json(res,401,{ok:false,error:"Sign in required."});return null;}
  return user;
}
function isValidPassword(p) { return typeof p === "string" && p.length >= 8 && p.length <= 128; }
function googleConfig() { return { clientId: process.env.GOOGLE_CLIENT_ID || "" }; }

const httpServer = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") { json(res,204,{}); return; }
  if (req.url === "/health" || req.url === "/") {
    json(res,200,{ ok:true, name:"SyncParty Relay", version:"0.7.1" });
    return;
  }
  if (!req.url.startsWith("/api/")) { json(res,404,{ok:false,error:"Not found"}); return; }

  try {
    const u=new URL(req.url,"http://localhost");
    const path=u.pathname;

    if (path === "/api/auth/google/config" && req.method === "GET") {
      json(res,200,{ok:true,...googleConfig()}); return;
    }

    if (path === "/api/auth/signup" && req.method === "POST") {
      const b=await readJson(req); const email=normalizeEmail(b.email);
      if(!email || !email.includes("@")) {json(res,400,{ok:false,error:"Enter a valid email address."});return;}
      if(!isValidPassword(b.password)) {json(res,400,{ok:false,error:"Password must be at least 8 characters."});return;}
      const created=await createEmailUser({email,password:b.password,name:b.name});
      if(created.error){json(res,409,{ok:false,error:created.error});return;}
      const session=await createSession(created.user.id);
      json(res,200,{ok:true,token:session,user:publicUser(created.user)}); return;
    }

    if (path === "/api/auth/login" && req.method === "POST") {
      const b=await readJson(req); const user=await authenticateEmail(b.email,b.password);
      if(!user){json(res,401,{ok:false,error:"Email or password is incorrect."});return;}
      const session=await createSession(user.id);
      json(res,200,{ok:true,token:session,user:publicUser(user)}); return;
    }

    if (path === "/api/auth/logout" && req.method === "POST") {
      await revokeSession(bearer(req)); json(res,200,{ok:true}); return;
    }

    if (path === "/api/auth/me" && req.method === "GET") {
      const user=await requireUser(req,res); if(!user)return;
      json(res,200,{ok:true,user:publicUser(user)}); return;
    }

    if (path === "/api/auth/google/exchange" && req.method === "POST") {
      if(!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET){json(res,503,{ok:false,error:"Google sign-in is not configured on this SyncParty server."});return;}
      const b=await readJson(req); if(!b.code || !b.redirectUri){json(res,400,{ok:false,error:"Missing Google authorization data."});return;}
      const tokenResp=await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({code:b.code,client_id:process.env.GOOGLE_CLIENT_ID,client_secret:process.env.GOOGLE_CLIENT_SECRET,redirect_uri:b.redirectUri,grant_type:"authorization_code"})});
      if(!tokenResp.ok){json(res,401,{ok:false,error:"Google authorization could not be completed."});return;}
      const gt=await tokenResp.json(); const infoResp=await fetch("https://openidconnect.googleapis.com/v1/userinfo",{headers:{Authorization:`Bearer ${gt.access_token}`}});
      if(!infoResp.ok){json(res,401,{ok:false,error:"Google profile could not be read."});return;}
      const info=await infoResp.json(); let user=await getGoogleUser(info.sub);
      if(!user){
        const created=await createGoogleUser({sub:info.sub,email:info.email,name:info.name});
        user=created.user;
      } else {
        user=await updateGoogleUser(user.id,{email:info.email,name:info.name});
      }
      const session=await createSession(user.id);
      json(res,200,{ok:true,token:session,user:publicUser(user)}); return;
    }

    if (path === "/api/scrapbook" && req.method === "GET") {
      const user=await requireUser(req,res); if(!user)return;
      const scope=u.searchParams.get("scope")==="shared"?"shared":"personal";
      const relationId=u.searchParams.get("relationId")||null;
      const limit=Math.min(300,Math.max(1,Number(u.searchParams.get("limit")||150)));
      const entries=scope==='shared'
        ? await scrapbook.listSharedEntries(user.id,relationId,limit)
        : await scrapbook.listPersonalEntries(user.id,limit);
      const relations=await scrapbook.listUserRelations(user.id);
      json(res,200,{ok:true,scope,entries,relations}); return;
    }

    if (path === "/api/scrapbook/entries" && req.method === "POST") {
      const user=await requireUser(req,res); if(!user)return; const b=await readJson(req);
      let relation=null;
      if(b.scope==='shared'){
        relation=await scrapbook.getRelation(user.id,b.relationId);
        if(!relation?.accepted_at){json(res,409,{ok:false,error:"Shared Scrapbook is not active."});return;}
        const ids=[relation.user1_id,relation.user2_id];
        if(!ids.includes(user.id)){json(res,403,{ok:false,error:"You are not part of this Shared Scrapbook."});return;}
      }
      const targets=b.scope==='shared'?[relation.user1_id,relation.user2_id]:[user.id];
      const created=[];
      for(const uid of targets){created.push(await scrapbook.upsertEntry(uid,b.entry,b.scope==='shared'?relation.id:null));}
      json(res,200,{ok:true,entries:created}); return;
    }

    if (path === "/api/scrapbook/entries/bulk" && req.method === "POST") {
      const user=await requireUser(req,res); if(!user)return; const b=await readJson(req);
      const entries=Array.isArray(b.entries)?b.entries.slice(0,500):[];
      const out=[]; for(const e of entries) out.push(await scrapbook.upsertEntry(user.id,e,null));
      json(res,200,{ok:true,entries:out}); return;
    }

    if (path === "/api/scrapbook/relationship" && req.method === "GET") {
      const user=await requireUser(req,res); if(!user)return; const partnerId=u.searchParams.get('partnerId');
      const relation=partnerId?await scrapbook.getRelation(user.id,partnerId):null;
      const invites=await scrapbook.listInvites(user.id);
      json(res,200,{ok:true,relation:await scrapbook.relationView(relation),...invites}); return;
    }

    if (path === "/api/scrapbook/relationship/invite" && req.method === "POST") {
      const user=await requireUser(req,res); if(!user)return; const b=await readJson(req); const partner=await scrapbook.getUser(b.partnerId);
      if(!partner||partner.id===user.id){json(res,400,{ok:false,error:'Choose a valid partner account.'});return;}
      const result=await scrapbook.createInvite(user.id,partner.id);
      if(result.relation){json(res,200,{ok:true,relation:result.relation});return;}
      json(res,200,{ok:true,invite:result.invite});return;
    }

    if (path === "/api/scrapbook/relationship/respond" && req.method === "POST") {
      const user=await requireUser(req,res); if(!user)return; const b=await readJson(req);
      const result=await scrapbook.respondInvite(b.inviteId,user.id,!!b.accept);
      if(result.error){json(res,404,{ok:false,error:result.error});return;}
      json(res,200,{ok:true,relation:result.relation});return;
    }

    if (path === "/api/scrapbook/highlights" && req.method === "GET") {
      const user=await requireUser(req,res); if(!user)return;
      json(res,200,{ok:true,highlights:await scrapbook.getHighlights(user.id)});return;
    }

    json(res,404,{ok:false,error:'Not found'});
  } catch (e) {
    console.error('[SyncParty Scrapbook API]',e);
    const message = process.env.NODE_ENV === 'production' ? 'SyncParty server error.' : (e?.message || 'SyncParty server error.');
    json(res,500,{ok:false,error:message});
  }
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
    accountId: p?.accountId ? String(p.accountId).slice(0, 128) : null,
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
    accountId: s.profile?.accountId || null,
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
    roomPlaybackState.delete(room);
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
      roomPlaybackState.delete(room);
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
      const cachedPlayback = roomPlaybackState.get(room);
      if (cachedPlayback) {
        // Replay the latest Spotify playback state to a late joiner. Keep the
        // packet room-wide and bypass pageKey matching so the joiner can first
        // navigate to the authoritative track when necessary.
        send(ws, {
          type: "message",
          payload: {
            ...cachedPlayback,
            replay: true,
            receivedAt: Date.now()
          }
        });
      }
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
        "messageReaction", "reaction", "buffering", "system", "navigate", "transition-ready", "scrapbook-watch-state", "spotify-command", "spotify-request"
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

      if (kind === "spotify-command") {
        const cached = {
          ...p,
          kind: "spotify-command",
          authoritative: p.authoritative === true,
          senderId: p.senderId || s.clientId || s.id,
          authorityId: p.authorityId || p.senderId || s.clientId || s.id,
          sentAt: Number(p.sentAt || Date.now())
        };
        roomPlaybackState.set(s.room, cached);
      }

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
        roomPlaybackState.delete(room);
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
