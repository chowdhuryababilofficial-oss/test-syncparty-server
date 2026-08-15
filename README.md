# SyncParty relay

The relay is a ~90-line WebSocket server. It only ever carries room
membership, play/pause/seek events, chat, typing indicators and reaction
pings — never the movie stream itself.

You have two ways to run it. **Option A removes the "run a server every
time" step entirely** — do it once and every install of the extension
just works. Option B is the old manual/local flow, still here for quick
testing or if you'd rather not deploy anywhere.

## Option A — deploy once, free, no domain needed (recommended)

Render, Fly.io and Railway all have a free tier that gives you a public
`https://something.onrender.com`-style address with **no domain
purchase required** — that address is enough, you don't need
`syncparty.com` or anything like it.

Using Render (a `render.yaml` blueprint is already in this folder):

1. Push this repo (or just the `server/` folder) to a GitHub repo.
2. On Render: **New → Blueprint**, point it at that repo. It reads
   `render.yaml` and provisions a free web service automatically.
3. Wait for the build to finish. Render gives you a URL like
   `https://syncparty-relay-xxxx.onrender.com`.
4. Your WebSocket address is the same host with `wss://` instead of
   `https://` — e.g. `wss://syncparty-relay-xxxx.onrender.com`.
5. Open `extension/background.js` and set:
   ```js
   const DEFAULT_RELAY = "wss://syncparty-relay-xxxx.onrender.com";
   ```
6. Reload the unpacked extension.

That's it — from now on, "Create a room" and the invite link both work
for anyone who installs the extension, with nothing to start manually.
(Free-tier instances on these platforms typically sleep after a period
of inactivity and take a few seconds to wake on the next connection —
fine for this use case, just not instant on the very first request.)

## Option B — local / no deployment

    npm install
    npm start

Use `ws://127.0.0.1:8787` in SyncParty's settings. Only works between
browsers on the same PC.

For long-distance without deploying anywhere, `npm run public` wraps the
same server in a LocalTunnel HTTPS tunnel and prints a temporary
`wss://...` URL — paste that into SyncParty on both ends and keep the
terminal open while you watch. This URL changes every time you restart
the tunnel, so it can't be baked into a permanent invite link — that's
exactly what Option A solves.
