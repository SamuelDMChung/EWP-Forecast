# EWP Material Forecast — V0.11

**Developed by Samuel Chung @ Griff**

## V0.11 changes

- The Project Defaults **Estimated Delivery Date** automatically becomes the first detected level's date even when no bulk-date option is selected.
- Adds **Each subsequent level 1 week after previous level**. When enabled, detected levels are scheduled in seven-day increments from the project date.
- **Use this date for all levels** and the weekly option are mutually exclusive.
- A manual level-date edit while **Use this date for all levels** is active turns that option off and preserves the exception.
- A manual level-date edit while the weekly option is active makes that level a new scheduling anchor; later levels recalculate at one-week intervals. Editing the first level also updates the project starting date.
- Adds a live **Projects & Materials** search/filter across Project #, Revision, Address (Project Name), Customer and Sales, with a matching-project count and Clear action.
- Existing V0.10 deletion, lazy history, Realtime, Web Stiffener filtering, Supabase authentication and RLS-compatible access are preserved.


## V0.10 changes

- Adds **Delete Project** from the Projects & Materials project editor. Project deletion cascades through its levels, materials and delivery records.
- Deleted project number/name can be reused immediately; deletion metadata remains only in Entry History.
- Optional deletion reason/note is retained in the audit log.
- Entry History now lazy-loads the latest 100 records at a time, with **Load 100 older entries** for deeper history instead of downloading a large history table at once.
- Header credit updated to **Developed by Samuel Chung @ Griff**.


V0.9 adds Supabase email/password authentication to the shared-team V0.7 application. The app remains a static GitHub Pages site, while operational project data stays in Supabase.

## V0.9 authentication

- The app is blocked by a **Sign in** dialog until a valid Supabase user authenticates.
- Public sign-up is intentionally not offered in the app.
- Team users are created manually by the Supabase administrator.
- The signed-in user's email is shown in the header with a **Sign out** button.
- Supabase access and refresh tokens are stored in this browser so the user normally stays signed in.
- Access tokens are refreshed automatically when needed.
- Every database request sends the authenticated user's Bearer token in addition to the browser-safe publishable key.
- New `activity_log` entries record `actor_name`, `actor_email`, and `actor_user_id` from the authenticated Supabase account.
- The old V0.7 "Who are you?" browser-only identity prompt has been removed.

## Architecture

- **GitHub Pages** hosts the web app.
- **Supabase Auth** verifies team users.
- **Supabase Postgres / Data API** stores shared Project / Level / Material / Delivery data.
- EWP PDFs are parsed **locally in the user's browser**. The original PDF is not uploaded by this app.
- Only the structured information extracted/entered by the user is sent to Supabase.

## Important transition state

V0.9 is designed to be deployed and login-tested **before** Row Level Security is switched on.

At this stage:

1. Public Supabase sign-up should already be disabled.
2. Authorized users should be manually created in Supabase and confirmed.
3. Deploy V0.9 and confirm email/password login works.
4. Only after successful login testing should RLS be enabled with authenticated-user policies and anonymous access removed.

Do not enable RLS before the V0.9 login test unless the required policies are created at the same time, or the app will lose database access.

## Existing shared features preserved

- Shared projects, levels, materials and delivery history across multiple computers.
- Automatic cloud refresh while the page is visible.
- Optimistic version checks for project and level edits.
- Additive partial/full delivery transactions.
- Multi-level projects collapsed by default.
- Compact matrix cards, sticky project headers, frozen material column and top horizontal scrollbar.
- Monthly outstanding-material forecast.
- V0.5 local-browser data migration.
- CSV and JSON export/import tools.

## Supabase connection

Browser-safe connection settings are in `config.mjs`:

- Supabase Project URL
- Supabase **publishable** key

The publishable key is expected to be present in frontend code. **Never** put a Supabase Secret key, database password, or `service_role` key into this repository.

## Deploy with GitHub Pages

Put these files directly in the repository root:

- `index.html`
- `styles.css`
- `app.mjs`
- `auth.mjs`
- `parser.mjs`
- `db.mjs`
- `config.mjs`
- `.nojekyll`
- `.gitignore`
- `README.md`

Commit and push through GitHub Desktop. GitHub Pages will redeploy from `main` / `/(root)`.

Do not commit real customer PDFs, exported CSV files, JSON backups, passwords, or Supabase secret keys.


## V0.9 hotfix
Replaced the modal-dialog sign-in with a full-screen authentication gate for better compatibility with restricted/corporate browsers. The application remains blocked until Supabase email/password authentication succeeds.


## V0.9 changes

- Adds a read-only **Entry History** tab backed by `activity_log`.
- Removes the fixed JSON backup/import dock from the app UI.
- Removes the 10-second full-table polling loop. Shared changes now use Supabase Realtime notifications, with manual refresh and window-focus refresh as safety fallbacks.
- Filters Total Length entries containing **Web Stiffener** by default during PDF import. Each filtered line is visibly listed in the review step and can be added back with one click before saving.
- Project edit history records field-level before/after values for new edits.

### One-time Supabase Realtime setup

Run the following once in the Supabase SQL Editor so Postgres Changes are published for the app tables:

```sql
do $$
declare
  t text;
begin
  foreach t in array array['projects','levels','materials','deliveries','activity_log']
  loop
    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
```

If Realtime is unavailable, the app still works through explicit refreshes and refresh-on-focus; it no longer performs recurring full-data polling.
