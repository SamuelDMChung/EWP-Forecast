# EWP Management Portal — V1.0 Phase 1

**Developed by Samuel Chung @ Griff**

## What's included

- `index.html` / `portal.css` — portal homepage with links to both applications.
- `portal-nav.css` — shared top navigation for switching between Portal, Project Tracking, and EWP Forecast.
- `tracker/` — **EWP Project Tracker V0.5**, including its original `app.js`, `styles.css`, and local-browser data model.
- `forecast/` — **EWP Material Forecast V0.27**, including its original `.mjs` modules, styles, and Supabase config.
- `forecast/supabase_v0_26.sql` — existing schema reference, **not a new migration**.

## Deployment to GitHub Pages

1. Back up the existing repository / take note of current live URL.
2. Put all contents of this ZIP **in the GitHub Pages publishing root** (normally repository root for `main / (root)`). The homepage must be the new top-level `index.html`.
3. Commit and push changes using GitHub Desktop. Keep the `forecast/` and `tracker/` folders with their contents, and the root `.nojekyll`.
4. Wait for the GitHub Pages deployment, then visit the repository's base URL. It should open the new portal.
5. Click **Project Tracking** and **EWP Forecast**, then check the navigation links at the top of both workspaces.
6. Existing bookmarks that pointed at the forecast's old root path should be updated to `/forecast/`.

**Important:** If the old forecast was hosted at the repository root, GitHub Pages will now show the portal there. The forecast is at `/forecast/`. Don't keep an old root-level `app.mjs`/`styles.css`/`auth.mjs` as the active app: this structure is intentional. You can archive the old layout in Git history.

## Scope of Phase 1

This phase is intentionally **navigation only**; it does not change either application's data model or backend:

- EWP Forecast continues to use the original Supabase project, account login and database.
- Project Tracker V0.5 continues using browser `localStorage`. Its project data remains **local to the browser and website origin**; it is not yet shared with colleagues or with EWP Forecast.
- The portal homepage has no separate authentication gate. EWP Forecast still requires its own login. A shared login is planned for a later phase.
- The two apps do not yet synchronize customers, salespeople, project numbers, or other project information.
- No Supabase SQL needs to be run for Phase 1. There is **no data deletion**.

**Tracker data caveat:** Browser localStorage is isolated by origin (scheme + host + port). If Tracker was previously opened as a local `file://` page or on another website hostname, its old local data will not automatically appear on the new GitHub Pages URL. Preserve your old browser data until Phase 2 migration.

## Future phases (not implemented here)

- **Phase 2:** Shared Supabase registry and Tracker backend migration, safe numbering, merged project metadata.
- **Phase 3:** Linked project updates, duplicate detection, bidirectional project creation, unified user access.

## Original documentation

See `tracker/README.md`, `forecast/README.md` and `forecast/EWP_FORECAST_HANDOFF.md`. Existing forecasting, PDF imports, Spruce and delivery workflows remain unchanged.
