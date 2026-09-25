# EWP Material Forecast — V0.25

**Developed by Samuel Chung @ Griff**


## V0.25 changes

V0.25 is a UX cleanup build focused only on the approved button/layout simplifications in Projects & Materials and the Manage Delivery window.

- Projects & Materials headers are cleaner without hiding actions. Status now sits on its own line, and **Manage** is visually emphasized while **Edit** and **Expand / Collapse** remain visible.
- Estimated Delivery Date now **auto-saves** when changed. The separate **Update Date** button is removed and replaced by a small save-status indicator.
- **Put in Spruce** / **Deliver** remains a compact tab-style mode switch in the Manage Delivery window.
- Put in Spruce mode keeps the main buttons visible, but the quick actions are clearer: **Use Entire Forecast** and **Clear Quantities**.
- No Supabase schema, RLS, Realtime, or SQL change is required for V0.25. Deploy the frontend files only.
- The visible app version label is correctly set to **Version 0.25**, and top-level CSS/JS URLs include a `v=0.25` cache-busting suffix so GitHub Pages/browser caches fetch the current build.


## V0.23 changes

V0.23 fixes the remaining refresh-time login popup/flash from V0.22.

- The login gate now starts hidden in the HTML instead of being visible on the first paint.
- Startup checks `restoreSession()` before deciding whether to show the login gate. A valid saved Supabase session therefore refreshes directly into the app without briefly showing the sign-in dialog.
- If no valid saved session exists, the normal sign-in dialog still opens. Explicit sign-out and invalid/revoked sessions are unchanged.
- No Supabase schema, RLS, Realtime, or SQL change is required for V0.23. Deploy the frontend files only.


## V0.22 changes

V0.22 added saved Supabase session restoration on page refresh.

- A valid session stored in browser `localStorage` is restored on startup instead of requiring the password again.
- Startup restores the signed-in identity and hides the login gate after session restoration.
- V0.22 still showed the login gate before restoration completed, which caused a misleading sign-in popup/flash on every refresh; V0.23 removes that flash.
- No Supabase schema, RLS, Realtime, or SQL change is required for V0.22.


## V0.21 changes

V0.21 is a frontend/UX refinement of the V0.20 delivery workflow. It fixes the delivery-PDF picker, makes project/level status reflect the overall workflow rather than a single Spruce state, and adds field-aware project filtering.

- Fixes **Import Delivery PDF** / **Import / Revise Delivery PDF** file selection by resetting the file input before every picker open, using the browser-native `showPicker()` when available, and falling back to a direct file-input click. Selecting the same PDF again after a failed/revised import now triggers a fresh parse.
- Changes collapsed project wording from **packages remaining** to **levels remaining**. Delivery packages such as L3D1/L3D2 remain independent Spruce batches within a level and do not affect the level count.
- Replaces matrix/forecast status pills with **FORECAST / ONGOING / COMPLETED**. A level is Ongoing once any quantity is in Spruce, delivered, or excluded; it is Completed when no outstanding LF remains. A project is Ongoing when at least one level has progressed beyond Forecast but the whole project is not yet complete.
- Collapsed project status is now calculated from **all project levels**, not copied from the next level. This allows one project to correctly show Ongoing while some levels are completed and later levels are still forecast.
- Adds a project-search field selector: **All fields / Sales / Customer / Project # / Project Name / Revision**. `Sales` uses an exact normalized match (for example, Sales = `JH`) so initials do not accidentally match partial text in a customer or project name. Other field filters retain partial matching.
- No Supabase schema/RLS/Realtime change is required for V0.21. If upgrading from V0.20, replace the frontend files only. A database older than V0.20 still needs `supabase_v0_20.sql`.


## V0.20 changes

V0.20 adds business-facing delivery names and a Javelin **Layout Material List PDF → Spruce** import workflow while preserving the quantity-based V0.19 Spruce model.

- Adds automatic delivery names such as **L3D1, L3D2, L3D3** based on the active level. The Delivery Name is editable for nonstandard cases.
- Delivery numbering represents the actual customer/shipping package, **not database actions**. Removing L3D2 from Spruce does not permanently consume that name; re-entering/re-importing the same package can still be L3D2.
- Prevents two active/delivered Spruce orders with the same Delivery Name for one level. Re-importing an **open** L3D2 updates/revises that same delivery instead of creating a duplicate. A delivered package must be undone before it can be revised.
- Adds **Import Delivery PDF** in Put in Spruce and **Import / Revise Delivery PDF** beside open Spruce orders.
- Reads Weyerhaeuser/Javelin Layout Material List rows using **Length × Net Qty = LF**. `Plies` is informational and is not multiplied again.
- Ignores hanger/hardware rows and Web Stiffeners. EWP rows including TJI, LVL/Microllam, LSL/TimberStrand, PSL/Parallam and Rim Board are considered.
- Matches imported EWP to the project using the existing **product + size** identity rule. `WSO`, `SSS`, grade text such as `1.3E`, and manufacturer wording do not create a separate LVL/LSL/PSL stock identity. `ML = LVL`; `TS = LSL` remains supported for POs.
- The import review shows the PDF material, matched project material, imported LF, available LF, editable Put in Spruce LF and match/error status before anything is saved.
- Blocks confirmation when the PDF is for a different project/level, an EWP material cannot be matched, or the imported quantity exceeds the amount still available for that delivery. A revision mismatch is shown as a warning rather than silently ignored.
- Preserves the original PDF filename/project/revision/level on the Spruce order for reference and in Entry History.
- If the entire outstanding level is already committed, the top **Put in Spruce** action changes to **Remove from Spruce**. That action returns all open Spruce batches for the level to Forecast Remaining; individual batches can still be removed from the open-order list.
- Adds `EWP_FORECAST_HANDOFF.md` as the canonical workflow/development handoff for future chat migrations.

### Required Supabase change for V0.20

Run **`supabase_v0_20.sql` before deploying the V0.20 frontend**. It is cumulative/idempotent and includes the prior inventory, purchasing and V0.19 Spruce-batch schema. V0.20 adds delivery-name/source metadata, a per-level unique Delivery Name rule, and an atomic PDF-import/revision database function.

## V0.19 changes

V0.19 replaces the old level-wide **Planning Status** with quantity-based Spruce orders, matching the actual workflow: material can be partially committed to Spruce, but each Spruce order is delivered as one complete batch.

- Removes the **Planning Status** dropdown from the level Manage window.
- Adds two clear actions: **Put in Spruce** and **Deliver Spruce Order**.
- **Put in Spruce** works by material quantity, so one level can simultaneously contain Delivered, In Spruce, Excluded and Forecast Remaining LF.
- Adds **Put Entire Forecast in Spruce** for the common case where the whole remaining forecast is entered at once.
- Each Spruce entry is saved as its own batch/order, preserving separate commitments if material is entered into Spruce at different times.
- **Deliver Spruce Order** shows open Spruce batches and always moves the selected entire batch to Delivered. There is no partial-delivery input for an existing Spruce batch.
- The **Actual Delivery Date** and delivery note appear only in Deliver Spruce Order mode.
- Open Spruce batches can be **Removed from Spruce**, returning the entire batch to Forecast Remaining.
- A delivered Spruce batch can be undone, which moves the entire batch back to In Spruce.
- Existing pre-V0.19 delivery rows remain visible as **Legacy delivery** history and can still be undone.
- Inventory committed demand now uses the exact LF currently in open Spruce batches instead of treating an entire level as committed. Multi/SFD forecast calculations use only the uncommitted Forecast Remaining LF, preventing double counting.
- Level badges can now show **FORECAST**, **PARTLY IN SPRUCE**, **IN SPRUCE**, or **DELIVERED** based on quantities.
- Revision imports are blocked when a revision would reduce required LF below quantities already delivered or committed in Spruce.
- Adds database guards so concurrent users cannot commit more Spruce LF than remains available for a material.

### Required Supabase change for V0.19

Run **`supabase_v0_19.sql` before deploying the V0.19 frontend**. The script is idempotent and includes the earlier V0.16/V0.17 inventory and purchasing schema, so it is safe to run even if those migrations were already applied.

The migration creates `spruce_orders` and `spruce_order_items`, adds authenticated RLS / Realtime access, and automatically converts any existing level whose old `workflow_status` is `spruce` into one open Spruce batch containing that level's current outstanding LF. The old level status is then reset to `forecast`; V0.19 no longer uses it for calculations.


## V0.18 changes

V0.18 makes material identity tolerant of supplier/project naming differences by matching EWP materials on their actual product family and size rather than the full description string.

- Uses a shared **product + size** material identity across Projects, Inventory and Purchasing.
- Treats these as the same material: `ML 1-3/4 x 9-1/4 SSS`, `LVL 1-3/4 x 9-1/4`, and equivalent decimal/fraction formatting.
- Keeps **ML → LVL** and **TS → LSL** aliases. Full-word TimberStrand/LSL and Microllam/LVL naming are also recognized when product identity is determined.
- Ignores nonessential grade/description text such as **SSS** and values such as **1.3E** when deciding whether two LVL/LSL/PSL entries are the same stock material.
- For TJI, identity remains **TJI series + depth** so a TJI 230 and TJI 360 of the same depth stay separate, while a PO description that includes flange width still matches a project description that only lists the joist depth.
- PO review keeps the mill's original description underneath the normalized material for reference.
- If multiple PO rows/descriptions normalize to the same product + size, their footage and package/length detail are combined automatically into one reviewed material line.
- The same identity logic is used by Stock Position, incoming PO footage, manual incoming entries, Add to Inventory duplicate detection, forecasts, and revision matching.

### Supabase change for V0.18

**No new Supabase migration is required when upgrading from V0.17.** V0.18 changes frontend matching/normalization only. If the database has not yet been migrated for V0.17, run `supabase_v0_17.sql` before deploying.

## V0.17 changes

V0.17 separates inventory maintenance from purchasing intake and adds a local Excel PO importer based on the Griff mill-PO format.

- Splits the former **Inventory & Purchasing** page into separate **Inventory** and **Purchasing** tabs.
- Keeps **Inventory** focused on Spruce On Hand, lead times, committed demand, Multi forecast, SFD buffer, incoming totals, Stock Owed and projected balance.
- Renames **+ Track Material** to **+ Add to Inventory**. The button is disabled when nothing is entered or when the selected material is already present in Stock Position; an existing material shows **Already Added**.
- Adds a Purchasing workflow similar to Add Project: **Upload PO Excel → review PO details/materials → confirm**.
- Reads the sample Griff PO structure locally in the browser, including cached Excel formula values for **Description** and **Lineal**. The original workbook is not uploaded.
- Detects the PO number from the workbook when populated, otherwise falls back to filenames such as `PO#2609-P77940.xlsx` → `2609-P77940`.
- Reads PO date, material description, packages, length, pieces and Lineal footage; repeated length rows are aggregated into one incoming LF total per material while the underlying length/package detail is retained.
- Normalizes Griff PO shorthand **ML → LVL** and **TS → LSL** before matching/adding material names. Other descriptions are left unchanged apart from whitespace/`x` cleanup.
- Requires the user to enter **Expected Arrival** before confirming the PO; the PO date from the workbook is treated as the PO/order date, not an assumed arrival date.
- Prevents accidental duplicate PO footage. If the same PO # is uploaded again, the UI warns the user and reconciles the existing PO while preserving already received quantities.
- Keeps manual/transfer incoming entry on the Purchasing tab for material that does not come from an Excel PO.
- Retains imported PO length/package detail in Supabase JSON so future purchasing UI can become more detailed without re-importing the original workbook.
- Adds `purchase_orders`, links imported `incoming_orders` rows to the PO header, and includes the new table in authenticated RLS and Realtime sync.

### Required Supabase change for V0.17

Run **`supabase_v0_17.sql` before deploying the V0.17 frontend**. The script is idempotent and includes the V0.16 planning/inventory additions as well, so it is safe if V0.16 has already been migrated and can also bring a V0.15 database forward in one step.

## V0.16 changes

V0.16 expands the V0.15 project forecast into the inventory / purchasing workflow described by Matt, while preserving the PDF-first project-entry flow.

- Adds **Project Type: Multi-family / SFD**. Multi-family packages require estimated delivery dates; SFD package dates are optional.
- Adds package planning states **Forecast → In Spruce → Delivered**. `In Spruce` reserves the package's outstanding LF against current stock; `Delivered` is derived automatically once no outstanding LF remains.
- Replaces the forecast screen with a **6-week Multi Delivery Schedule**, **6-week material demand**, and the existing longer-term **Monthly Material Forecast**.
- Adds **Inventory & Purchasing** with current Spruce On Hand, material-specific lead time, committed/Spruce demand, Multi forecast demand, SFD buffer, incoming material, available stock, lead-time need, Stock Owed, and projected balance.
- Adds **Incoming Material** records with expected date, PO/reference, note, remaining quantity, receive action and audit history. Receiving an order adds the remaining LF to On Hand.
- Calculates **Stock Owed** using each material's lead-time window: committed demand + SFD buffer + Multi demand due within lead time, less On Hand and incoming material due within the same window.
- Keeps SFD demand out of the dated Multi forecast and instead treats outstanding non-Spruce SFD quantities as a purchasing buffer.
- Changes repeat Project # uploads into **revision reconciliation** instead of delete/recreate. Matching levels/materials are updated in place, new items are added, removed items are archived from the active forecast, and existing delivery/history records are preserved.
- Adds Realtime sync for the new inventory and incoming-material tables and extends Entry History for planning, inventory and purchasing changes.

### Required Supabase change for V0.16

The historical V0.16 package used `supabase_v0_16.sql`. For the current V0.20 package, run **`supabase_v0_20.sql`**. It includes the V0.16/V0.17 inventory and purchasing schema plus the V0.19 Spruce-order tables and V0.20 delivery-name/import additions, so the older migration files do not need to be run separately for a fresh upgrade.

## V0.15 changes

- Clarifies the Delivery / Manage window by separating the planning date from the actual delivery transaction date.
- Renames **Forecast / Estimated Delivery Date** to **Estimated Delivery Date** and places its update control beside it.
- Renames **Delivery Date** to **Actual Delivery Date** and groups it with the delivery note immediately above the material delivery controls.
- Renames **Update Forecast Date** to **Update Estimated Date** and updates related user-facing wording / Entry History labels for consistency.
- No Supabase schema, RLS, Realtime or configuration change is required for V0.15.
- All V0.14 functionality, including cross-page Total Lengths parsing, is preserved.


## V0.14 changes

- Fixes PDF parsing when a **Total Lengths** table continues onto the next PDF page.
- Page footers/headers such as page numbers, timestamps, the Weyerhaeuser literature footer, repeated **Layout Material List Report** title and **Job:** line are ignored while the active Total Lengths table continues.
- Total Lengths capture now stops at a real report section boundary instead of the physical end of a PDF page.
- Existing Web Stiffener filtering still applies to continuation rows, including stiffeners appearing only on the following page.
- No Supabase schema, RLS, Realtime or configuration change is required for V0.14.
- All V0.13 functionality is preserved.

## V0.13 changes

- Shortens the weekly scheduling option to **Auto-set levels 1 week apart**.
- Makes the inline **Delivery date preview** editable. Date changes there stay synchronized with the full level editor and preserve the V0.12 same-date / weekly-anchor behavior.
- Adds a compact **Search materials…** field inside the level Delivery / Manage window so long material lists can be filtered without scrolling.
- Adds auditable **Exclude from Forecast** adjustments for materials from **Projects & Materials → Manage**. Exclusions can be full or partial, preserve the original PDF LF, reduce the Monthly Forecast immediately, can be adjusted/restored later, and are written to Entry History.
- Projects & Materials cells show excluded LF when applicable. Completion/outstanding calculations treat excluded LF as resolved forecast quantity without recording it as a delivery.
- Existing Supabase Auth, RLS, Realtime, deliveries, project deletion, Web Stiffener behavior and lazy Entry History are preserved.

### Required Supabase change for V0.13

Run the V0.13 SQL **before deploying the V0.13 frontend**. It adds three columns to the existing `materials` table; no new table, RLS policy or Realtime publication is required because `materials` is already protected and published.

```sql
alter table public.materials
  add column if not exists excluded_lf numeric not null default 0,
  add column if not exists exclusion_reason text,
  add column if not exists exclusion_note text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'materials_excluded_lf_valid'
      and conrelid = 'public.materials'::regclass
  ) then
    alter table public.materials
      add constraint materials_excluded_lf_valid
      check (excluded_lf >= 0 and excluded_lf <= original_lf);
  end if;
end $$;
```

## V0.12 changes

- Removes the explanatory sentence above **Projects & Materials** and simplifies project search to a single in-field search control with an integrated clear button.
- Keeps both delivery scheduling rules together directly beneath **Estimated Delivery Date**.
- Renames the rules to **Apply this delivery date to all levels** and **Auto-set each next level to 1 week after the previous level**.
- Adds an inline **Delivery date preview** for all detected levels, with Auto/Manual indicators.
- Preserves the V0.11 scheduling rules: same-date and weekly modes are mutually exclusive; manual same-date exceptions turn that mode off; a manual weekly edit becomes a new anchor for later levels.
- Changes the intake save flow to **Review Project → Confirm & Add Project**. No project data is written to Supabase until the confirmation modal is accepted.
- Adds a concise review modal showing Address (Project Name), project metadata, each level/date, package count, material-type count, total LF, and any still-excluded Web Stiffener entries.
- Review can be dismissed with **Back**, the × button, **Esc**, or by clicking outside the modal.
- Adds inline required-field validation and visual error highlighting before the review modal opens.
- Adds subtle matrix zebra striping and row hover to make large material matrices easier to follow.
- Existing Realtime sync, RLS-compatible authentication, Entry History, project deletion, lazy history, search filtering, Web Stiffener filtering, sticky matrix navigation and monthly forecast are preserved.

No new Supabase SQL is required for V0.12.

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
- **Supabase Postgres / Data API** stores shared Project / Level / Material / Delivery / Inventory / Incoming Material data.
- EWP PDFs and PO Excel workbooks are parsed **locally in the user's browser**. The original PDF / workbook is not uploaded by this app.
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
- 6-week Multi delivery/material forecast plus longer-term monthly outstanding-material forecast.
- Separate Inventory and Purchasing views with SFD buffer, committed Spruce demand, Excel PO import, incoming material and Stock Owed.
- V0.5 local-browser data migration.
- CSV export tools.

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
- `realtime.mjs`
- `config.mjs`
- `purchase_parser.mjs`
- `delivery_parser.mjs`
- `supabase_v0_20.sql` (**run this in Supabase SQL Editor before deploying V0.20**)
- `supabase_v0_19.sql` (older migration reference only)
- `supabase_v0_17.sql` (older migration reference only)
- `.nojekyll`
- `.gitignore`
- `README.md`
- `EWP_FORECAST_HANDOFF.md`

Commit and push through GitHub Desktop. GitHub Pages will redeploy from `main` / `/(root)`.

Do not commit real customer PDFs, PO Excel files, exported CSV files, JSON backups, passwords, or Supabase secret keys.


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
  foreach t in array array['projects','levels','materials','deliveries','inventory_materials','purchase_orders','incoming_orders','activity_log']
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
