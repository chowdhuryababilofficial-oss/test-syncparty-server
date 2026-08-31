# Supabase migration

1. Create a Supabase project.
2. Run `supabase-schema.sql` in the SQL Editor.
3. Add `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` to Render.
4. Keep the existing Google OAuth variables.
5. Deploy the server.
6. The extension keeps using the same `/api/auth/*` and `/api/scrapbook/*` endpoints.

The previous file-backed JSON store is intentionally no longer used. Existing JSON data is not automatically imported by this version.
