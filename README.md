# EWP Material Forecast — V0.6 Shared Team Edition

**Developed by Samuel Chung**

V0.6 moves the working project data from one browser's `localStorage` into the shared Supabase database while keeping the app itself as a static GitHub Pages site.

## V0.7 — lightweight user names for edit history

- On the first visit in each browser, the app asks **Who are you?**
- The entered name is stored locally in that browser under `ewp_forecast_user_name`.
- The current name is shown in the header and can be changed at any time.
- Every new `activity_log` entry now includes `actor_name` inside the JSON `details` object, so future edit-history UI can show who made each change.
- This is **not authentication** and does not provide security or identity verification. It is a lightweight audit label until proper login is added.
- No Supabase schema change is required for this release because the actor name is stored in the existing `details` JSONB field.


## Architecture

- **GitHub Pages** hosts the web app.
- **Supabase** stores shared Project / Level / Material / Delivery data.
- EWP PDFs are still parsed **locally in the user's browser**. The original PDF is not uploaded by this app.
- Only the structured data extracted/entered by the user is sent to Supabase.
- Every connected team member sees the same shared data.

## V0.6 features

- Shared projects, levels, materials and delivery history across multiple computers.
- Automatic cloud refresh every 10 seconds while the page is visible.
- Refreshes immediately after writes and when the browser regains focus.
- Manual **Refresh** button on Projects & Materials and Monthly Forecast.
- Uses optimistic `version` checks for edits to project fields and level forecast dates so stale edits are not silently overwritten.
- Delivery entries are additive. Before recording a delivery, the app refreshes the level so the latest remaining LF is used for validation.
- Multi-level projects remain collapsed by default on each browser. Collapse/expand is a local UI preference, not shared operational data.
- Existing compact matrix cards, frozen material column, sticky project headers and top horizontal scrollbar are preserved.
- Existing V0.5 browser data can be imported into the shared database with **Import V0.5 browser data**.
- JSON backups can be exported from shared data and imported back into the cloud.

## Supabase connection

The browser-safe connection settings are in `config.mjs`:

- Supabase Project URL
- Supabase **publishable** key

A publishable key is intentionally usable in frontend/browser code. **Never** put a Supabase Secret key or `service_role` key into this repository.

## Current security state

This V0.6 prototype assumes the Supabase tables are accessible through the Data API without Row Level Security, matching the current development setup.

That is suitable for internal testing, but it is **not the final production security model**. Before exposing sensitive company data broadly, add authentication and RLS policies.

## Concurrent use

Different users can add different projects at the same time normally.

For project-field edits and level forecast-date edits, V0.6 uses the database `version` value. If another user changes the same record first, the stale update is rejected and the app reloads shared data instead of silently overwriting the newer change.

Delivery records are additive. V0.6 refreshes immediately before validating a delivery, which substantially reduces stale-entry problems. A fully transactional server-side delivery function can be added later if strict prevention of simultaneous over-delivery is required.

## Data imported from V0.5

V0.6 still checks the old `ewp_forecast_v2` browser storage key. If it finds V0.5-era projects, the footer shows **Import V0.5 browser data**.

Importing does not automatically erase the old browser copy. Matching Project # records in Supabase are replaced only after you confirm the import.

## Deploy with GitHub Pages

Put these files directly in the repository root:

- `index.html`
- `styles.css`
- `app.mjs`
- `parser.mjs`
- `db.mjs`
- `config.mjs`
- `.nojekyll`
- `.gitignore`
- `README.md`

Then commit and push through GitHub Desktop. GitHub Pages will redeploy the site from `main` / `/(root)`.

Do not commit real customer PDFs, exported CSV files or JSON backups.
