# EWP Management Portal — V1.0 Phase 2 (Shared Database)

**Developed by Samuel Chung @ Griff**

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
