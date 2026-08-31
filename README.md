# SyncParty relay

The relay carries room membership, synchronized playback events, chat, typing, reactions, navigation, and the canonical room destination URL. The WebSocket implementation remains unchanged by the persistent Scrapbook migration.

## Persistent account + Scrapbook storage

Version 0.7.1 stores SyncParty accounts, password metadata, session tokens, Google identity mappings, Shared Scrapbook relationships, invitations, and Scrapbook entries in Supabase Postgres instead of the previous local JSON stores. The extension API paths and JSON responses remain unchanged.

### Setup

1. Create a Supabase project.
2. Run `supabase-schema.sql` once in the Supabase SQL Editor.
3. Add the environment variables below to Render.
4. Deploy this server.

### Render environment variables

Required:

- `SUPABASE_URL` — your Supabase project URL.
- `SUPABASE_SERVICE_ROLE_KEY` — your server-only Supabase service-role/secret key.

Required for existing Google Sign-In:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`

The Supabase service-role/secret key must never be placed in the Chrome extension or any other browser client.

### Local development

Set the same Supabase environment variables locally, then run `npm install` and `npm start`.

The previous file-backed store is no longer used. This package does not automatically import an old JSON database; migrate legacy data separately before deleting the old file if you still have it.
