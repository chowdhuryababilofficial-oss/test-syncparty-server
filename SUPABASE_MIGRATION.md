# Supabase migration for an existing SyncParty deployment

You do **not** need a new Supabase project for Scrapbook 2.1.

Keep the existing Supabase project, existing users, sessions, relations, invitations, and Scrapbook rows.

## One-time database step

In the **existing** Supabase project, run only the Scrapbook migration section in `supabase-schema.sql` (the `ALTER TABLE public.scrapbook_entries ...` statements near the end of the file).

That migration:

- allows `anime` as a Scrapbook type
- adds `content_type`
- adds `canonical_title`
- adds `artwork`
- backfills the new fields from the existing records
- does not recreate or delete the database

Do **not** rerun the whole schema against an existing production database.

## Render

After the one-time SQL migration, deploy/replace the server files on Render.

Keep the existing environment variables, including:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- existing Google OAuth variables

No new Supabase project or separate database is required.

The server continues using the existing `/api/auth/*` and `/api/scrapbook/*` endpoints.
