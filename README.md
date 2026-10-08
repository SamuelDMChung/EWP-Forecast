# EWP Management Portal — V1.0 Phase 3 (Integrated Portal)

**Developed by Samuel Chung @ Griff**

## Phase 3 — Unified login and cross-app workflow

This release builds on the **working Phase 2.1 project-number authority fix** and the existing **Forecast V0.27** operational workflows.

- **One login at the portal**: use the existing Supabase credentials at the main homepage. That authenticated browser session is reused in Tracking and Forecast, and restored on normal refresh. All navigation stays under the same GitHub Pages origin.
- **Single sign-out**: signing out of the portal or either tool ends that browser's session. Open pages in other tabs react to a sign-out via browser storage events.
- **Direct routes**: if someone bookmarks `/tracker/` or `/forecast/` without a session, they are returned to the portal login; after signing in they can continue to the requested workspace.
- **Project # links**: Project Tracking board cards and list rows link to the Forecast project. Forecast project/level cards link back to Tracking. Direct links carry the Project # as a URL parameter and pre-filter or pre-fill the destination.
- **Tracker cloud refresh**: optional Realtime notifications for shared project/task/settings changes, with refresh on focus, across-tab notification, manual refresh, and 60-second foreground fallback. The external Supabase JS module is loaded only for Realtime. If it cannot load, all core operations still use Supabase REST.
- **Supabase session handling**: updates to shared session tokens are synchronized between tabs. Where supported, refresh is guarded by a browser-level lock to reduce simultaneous refresh-token conflicts.
- **Protected Forecast workflow**: PDF parsing, original material quantities, Last Package, Spruce/delivery logic, inventory, purchase orders, and prior data are not modified. Tracker authority on conflicting customer/sales/address values remains as in Phase 2.1.

### Installation (Phase 3)

1. Back up your existing GitHub repository (and ideally your Supabase database).
2. This release requires **no new schema migration**. Your previous successful `phase2_migration.sql` and the Forecast V0.26 schema remain valid.
3. Extract the ZIP. Copy all its contents to the GitHub repository root, replacing `index.html`, scripts, styles, and the `tracker/` and `forecast/` folders as appropriate.
4. Commit and **Push origin**, wait for GitHub Pages, then open the portal URL. Versioned JavaScript/CSS imports for Phase 3 are included to reduce stale-browser-code problems.
5. Log in once at the portal, navigate to both tools, test cross-links, create/edit a test project, refresh, and sign out. Verify both creation paths and protected forecast/delivery records.
6. **Optional**: Run `phase3_realtime_optional.sql` in Supabase SQL Editor to enable publication of Tracker tables for faster live updates between different employees. The SQL is idempotent and does not delete records. Without it, focus/refresh/foreground 60-second fallback remains active.

### Scope and limitations

- **No role-based permissions** were added. Existing Supabase RLS team-wide authenticated permissions remain; restrict Supabase accounts to intended employees.
- Realtime requires a working Supabase Realtime service and tables in `supabase_realtime`; if blocked or offline, use Refresh or reopen the tab.
- The main portal is a navigation/login surface; Tracking and Forecast retain separate interfaces and specialized statuses. One Project # links both in a single `projects` registry.
- Automated local tests include syntax/paths and simulated login / Tracker interaction. Live-company-Supabase end-to-end testing still needs your final deployment test.

## Phase 2.1 — Project Tracking is authoritative

- **Project #** matches the same shared Supabase `projects` record (case-insensitive), for projects made in either tool.
- Forecast looks up that project directly in Supabase when the user types a number and after a Javelin PDF import, pre-filling Customer, Sales, Project Name/Address and Type.
- For Tracker-managed records, those shared fields are read-only in Forecast and always use Tracker values, even when a PDF contains conflicting details. Forecast still owns Revision, dates, levels and materials.
- PDF revisions and bulk imports no longer overwrite shared Tracker-managed fields. The final save re-checks the server and requests a new review if Tracker data changed during entry.
- A Tracker-only record is linked by Project # when its first PDF is imported; subsequent imports reconcile the same project without duplicating the registry record.
- Changes saved in Tracking notify other open portal tabs; Forecast also refreshes on tab focus, Realtime notifications, or a once-a-minute foreground fallback.
- **No additional SQL:** `phase2_migration.sql` must already have succeeded. There is no new schema change in this hotfix.

## What's new

- **Portal (`/`)**: the Phase 1 landing page is retained.
- **Project Tracking (`/tracker/`)**: reads and writes shared Supabase tables instead of browser `localStorage`. Sales, task, assignee settings and saved filters are stored in the cloud. Existing Forecast-only projects appear in the Tracker's Queue with an `Assign task` work item.
- **EWP Forecast (`/forecast/`)**: the V0.27 Spruce, PDF, inventory, and purchasing calculations are preserved; PDF intake now pre-fills known Sales/Customer details from the shared project record. Both tools use the same `public.projects` table. Existing Tracker projects are found by project number when importing their Javelin PDF in Forecast.
- **Project numbers**: new Tracker records use `TCYYXXX`; the number is issued atomically on the server for the default automatically proposed number. A manually chosen suffix must still be unique. PDF-imported project numbers that don't use this format are preserved.
- **Login**: Tracker uses the existing Forecast Supabase authentication session in the same browser origin. It can also show its own Supabase sign-in form. A redesigned portal-wide login is reserved for Phase 3.
- **Safety**: no destructive migration. Tracker cannot delete projects with existing Forecast levels. Edits protect against stale project versions. Work-item status and material-delivery status stay independent.

## Deploy in this order

1. **Backup** your Supabase database and GitHub repository before migrating.
2. In your *existing* Supabase project's SQL Editor, execute **`phase2_migration.sql`**, found in the root of this ZIP. This requires the existing EWP Forecast V0.26 schema. Run it **before** deploying the Phase 2 frontend. The migration is transaction-wrapped and creates tables, indexes, triggers, and RPC functions. If it refuses to proceed because duplicate project numbers exist, resolve the duplicates first; do not delete random records to work around it.
3. Unzip the release and copy its contents to the GitHub Pages repository root. **Do not simply copy the `tracker` folder**. Keep the portal, `forecast/`, `tracker/` and root CSS together. Existing files from Phase 1 may be replaced. Commit and push.
4. Wait for Pages and open your existing portal URL, then `/tracker/`. If you've signed into Forecast in the same browser origin, Tracker should use that session. Otherwise sign in with the same Supabase account.
5. Check Settings to confirm the recovered sales list; add missing sales/assignees/tasks. Create a dummy TC project in Tracker. Open Forecast and import a PDF for its number; confirm the forecast connects to the same record. Confirm task and Spruce statuses are independent.

**There is no need to rerun `forecast/supabase_v0_26.sql`** if it is already installed. Run only the root `phase2_migration.sql` for this release.

## Important limitations

- The previous Tracker's browser-only saved projects/settings are **not imported automatically**. They might still exist in the original browser profile/origin, but an automatic migration could accidentally conflict with newer shared records. Any lost browser-only settings can be recreated in Tracker's new cloud Settings. The migration recovers Sales names found in existing Forecast projects.
- No direct access to a live company Supabase instance was available during development; SQL must be run and validated in your project. JavaScript syntax and static package checks were completed, but live end-to-end tests still need to be done after migration. This is an integration test build.
- Sharing still follows the existing Supabase model: authenticated users have shared access to the company's project records. Fine-grained department/role permissions are not part of Phase 2.
- Tracker refreshes from Supabase when loaded, on window focus and via the Refresh button. Full real-time Tracker subscriptions, unified portal authentication, and further cross-app navigation are Phase 3 tasks.
- A project with an existing EWP level cannot have its number changed or be deleted from Tracker, to prevent breaking PDF matching or delivery history.

See `PORTAL_HANDOFF.md` for technical handoff details and `forecast/EWP_FORECAST_HANDOFF.md` for protected Forecast calculations and workflow rules.
