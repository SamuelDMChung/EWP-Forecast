# EWP Material Forecast — V0.8.1 Secure Team Login

**Developed by Samuel Chung**

V0.8.1 adds Supabase email/password authentication to the shared-team V0.7 application. The app remains a static GitHub Pages site, while operational project data stays in Supabase.

## V0.8.1 authentication

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

V0.8.1 is designed to be deployed and login-tested **before** Row Level Security is switched on.

At this stage:

1. Public Supabase sign-up should already be disabled.
2. Authorized users should be manually created in Supabase and confirmed.
3. Deploy V0.8.1 and confirm email/password login works.
4. Only after successful login testing should RLS be enabled with authenticated-user policies and anonymous access removed.

Do not enable RLS before the V0.8.1 login test unless the required policies are created at the same time, or the app will lose database access.

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


## V0.8.1 hotfix
Replaced the modal-dialog sign-in with a full-screen authentication gate for better compatibility with restricted/corporate browsers. The application remains blocked until Supabase email/password authentication succeeds.
