# EWP Management Portal Handoff

**Current release:** V1.0 Phase 1 (navigation only)
**Canonical components:** EWP Forecast V0.27; Project Tracker V0.5.

## Existing behavior and protected baselines

- `forecast/` is an unchanged EWP Forecast V0.27 app, except the new nonintrusive navigation markup and stylesheet. Read `forecast/EWP_FORECAST_HANDOFF.md` before making any changes to forecasting or Spruce logic.
- `tracker/` is unchanged Project Tracker V0.5, except the navigation markup and stylesheet. It still saves to origin-scoped `localStorage`; do not assume multiuser support.
- `index.html` is the landing page. `portal.css` and `portal-nav.css` are scoped to avoid CSS collisions.
- Both apps load their own scripts with their own relative paths. Keep the 3-document entrypoints (portal root, forecast/index.html, tracker/index.html).
- Relative links `../` and `../forecast/`, `../tracker/` work under project GitHub Pages base paths, even nested repositories.

## Shared backend architecture — next phase

- User chose Supabase as shared backend. Project Tracking is the primary project registry, but EWP Forecast must still allow creating projects by importing PDFs.
- Preserve incoming PDF project numbers rather than replacing them with TCYYXXX.
- Deduplicate by project number and reconcile revisions without deleting delivery records.
- Keep work item status separate from material lifecycle status.
- Assign new TCYYXXX IDs transactionally in Supabase, never localStorage counters for multiuser registration.
- User permits deletion of current test data if necessary, but no data was deleted in Phase 1.
- Unified login and shared data are **not yet implemented**. Do not claim otherwise.

## Deployment

Publish ZIP contents at repository root. No SQL needed in Phase 1; existing Forecast V0.26 schema remains current.
