# EWP Material Forecast — Development Handoff

**Canonical baseline:** V0.24  
**Project owner / developer credit:** Samuel Chung @ Griff

This file is the canonical workflow and development handoff for future ChatGPT/code migrations. When continuing development in a new chat, upload the latest ZIP and tell ChatGPT to read this file before changing code.

## 1. Core purpose

The app replaces manual EWP project-demand, delivery-forecast, inventory and purchasing spreadsheets with a shared Supabase-backed web tool. Project demand comes from Weyerhaeuser/Javelin project PDFs; purchasing can come from Griff PO Excel files; delivery/Spruce commitments can come from Javelin Layout Material List PDFs.

## 2. Material identity — canonical rule

Inventory/forecast/purchasing/delivery matching is based on **product family + size**, not the full supplier description.

- `ML` = `LVL` / Microllam LVL.
- `TS` = `LSL` / TimberStrand LSL.
- `SSS` and `WSO` are descriptors only for matching purposes and must not create separate stock materials.
- Grade/manufacturer wording such as `1.3E`, `1.55E`, `2.0E`, `TimberStrand`, `Microllam`, and `Parallam` does not create a separate identity when the product family + size is the same.
- Equivalent fraction/decimal dimension formats should match.
- TJI identity = **TJI series + depth**. TJI 230 and TJI 360 of the same depth are different materials.
- LVL/LSL/PSL identity = **product family + thickness + depth**.
- Preserve original PO/PDF wording for reference even when the canonical identity is normalized.

Example: all of these are the same stock material:
- `ML1-3/4 x 9-1/4" SSS`
- `1 3/4" x 9 1/4" 2.0E Microllam LVL (WSO)`
- `LVL 1-3/4" x 9-1/4"`

## 3. Project intake

- Add Project imports the existing Weyerhaeuser/Javelin project PDF Total Lengths data.
- Web Stiffeners are filtered by default.
- Multi-family and SFD are distinct project types.
- Multi-family uses dated delivery forecasting; SFD outstanding demand contributes to the purchasing buffer.
- Revision uploads reconcile existing project/level/material rows instead of deleting history.
- A revision cannot reduce required LF below quantities already delivered, excluded or committed in Spruce.

## 4. Quantity lifecycle

Material quantity can simultaneously be split between:

**Forecast Remaining → In Spruce → Delivered**

with **Excluded** kept as an independent adjustment.

Definitions:
- **Forecast Remaining:** required material not excluded, delivered or committed to Spruce.
- **In Spruce:** quantity committed/reserved in Spruce but not physically delivered.
- **Delivered:** quantity physically shipped; a Spruce delivery always moves an entire Spruce batch to Delivered.
- **Excluded:** customer-supplied/pre-ordered/no-longer-required material removed from forecast without changing the original project quantity.

### User-facing workflow status (V0.21)

Project/level summary pills use only **FORECAST / ONGOING / COMPLETED**. These are summary states and do not replace the detailed quantity split above.

Level status:
- **FORECAST:** no quantity has progressed into Spruce/delivery/exclusion and outstanding LF remains.
- **ONGOING:** outstanding LF remains and at least some quantity is In Spruce, Delivered, or Excluded.
- **COMPLETED:** no outstanding LF remains.

Project status:
- **FORECAST:** every level is still Forecast.
- **ONGOING:** at least one level has progressed beyond Forecast, but the project is not fully complete. This includes a project with completed earlier levels and forecast later levels.
- **COMPLETED:** every level has no outstanding LF.

Collapsed project cards count **levels remaining**, not delivery packages remaining. One level may contain multiple deliveries such as L3D1/L3D2/L3D3.

## 5. Spruce batches / delivery packages

- Putting material in Spruce can be partial by material quantity.
- Each Spruce entry is a separate batch/package.
- Multiple partial packages are expected and supported (D1, D2, D3, etc.).
- Once a Spruce batch is delivered, the **entire batch** moves to Delivered; there is no partial delivery of an existing Spruce batch.
- An open Spruce batch can be removed, returning its entire quantity to Forecast Remaining.
- A delivered Spruce batch can be undone, returning the entire batch to In Spruce.

### Delivery naming rule

Delivery names are **business-facing package identifiers**, not database transaction counters.

Examples:
- `L3D1` = Level 3, Delivery 1
- `L3D2` = Level 3, Delivery 2
- `L3D3` = Level 3, Delivery 3

Important:
- Removing/correcting/re-importing L3D2 does **not** mean the package becomes L3D3. Shipping, Sales and the customer still know that package as L3D2.
- The database has a separate invisible UUID for audit/technical identity.
- Two active/delivered Spruce orders for the same level cannot share the same Delivery Name.
- Re-importing an **open** L3D2 revises the same L3D2 rather than creating a duplicate.
- If L3D2 has already been delivered, undo its delivery before revising it.
- If an open L3D2 is removed/deleted, that business Delivery Name may be used again when the corrected package is re-entered.
- Auto-generated names use the active level and next apparent delivery sequence; users may edit the Delivery Name.

### Full-level Spruce UX

If Forecast Remaining is zero and there is still open In Spruce quantity, the top **Put in Spruce** action becomes **Remove from Spruce**. This reverses all open Spruce batches for that level to Forecast Remaining. Individual batch removal remains available in the open-order list.

## 6. Delivery Layout Material List PDF import (V0.20)

Purpose: automatically create/revise a partial Spruce package from a Weyerhaeuser/Javelin **Layout Material List Report** PDF.

Rules:
- Read all EWP material rows across all pages.
- Ignore hangers/hardware.
- Ignore Web Stiffeners.
- EWP families include TJI, LVL/Microllam, LSL/TimberStrand, PSL/Parallam, and Rim Board when present.
- Each material row uses **Length × Net Qty = subtotal LF**.
- **Do not multiply by Plies again.** Plies is informational because Net Qty already represents the required pieces.
- Aggregate repeated product/size rows across the report.
- Match imported materials to the active project level using the canonical product + size rule above.
- The import review must show PDF material, matched project material, imported LF, available LF, editable Put in Spruce LF, and status.
- Block confirmation if project/level is wrong, an EWP row cannot be matched, or requested LF exceeds available LF for that package.
- Revision mismatch is a visible warning, not silently ignored.
- Preserve PDF filename, project number, revision, and level name on the Spruce order for reference.
- Filename/report Delivery Name such as `L3D1` should be recognized when present.
- Re-importing the same open Delivery Name updates/revises that package atomically.
- The delivery-PDF UI must show only one import control per context. Keep the real file input hidden and use a native `<label for="sprucePdfFile">` as the visible import control; do not expose a second browser “Choose File” control.
- Clear the file input after every selection/import attempt so selecting the same PDF again still triggers parsing.
- PDF.js is loaded on demand using the current 6.3.289 build (jsDelivr first, cdnjs fallback); do not regress to 4.10.38 because newer Chromium builds can fail with that older version.

Validated sample for V0.20:
- `TC25161_R1 - Sherman Rd - Apartment - L3D1 Test.pdf`
- Project: `TC25161`
- Revision: `R1`
- Level: `L3 Framing`
- Delivery: `L3D1`
- Parser reads 131 EWP material rows, 15 product/size descriptions, totaling 8,322 LF before project-level canonical grouping.

## 7. Purchasing PO Excel import

- Purchasing is a separate top-level tab from Inventory.
- Import workflow: **Upload PO Excel → Review → Confirm**.
- Detect PO # from the workbook if present, otherwise from filenames such as `PO#2609-P77940.xlsx`.
- Parse material description, packages, length, pieces and Lineal LF.
- Preserve detailed length/package breakdown.
- `ML = LVL`, `TS = LSL`.
- Canonical matching uses product + size; `SSS` does not create a separate LVL.
- Duplicate PO # imports reconcile/update the existing PO rather than double incoming stock.
- Expected Arrival is required before confirming.

Validated sample:
- `PO#2609-P77940.xlsx`
- 23 packages
- 788 pieces
- 21,304 LF
- 6 canonical material groups

## 8. Inventory / purchasing calculations

Inventory remains separate from Purchasing.

Inventory tracks:
- On Hand
- material lead time
- In Spruce / committed demand
- Multi forecast demand
- SFD buffer
- incoming/open PO material
- incoming within lead-time window
- Available Now
- Need in Lead Time
- Stock Owed
- Projected Balance

Stock Owed uses the material-specific lead-time window and must not double-count quantities already in Spruce.

## 9. Project search/filter (V0.21)

Projects & Materials has a field selector plus one search input:
- **All fields**: partial match across project #, revision, project name/address, customer and sales.
- **Sales**: exact normalized match. Example: Sales filter `JH` matches Sales = JH and does not match unrelated partial text elsewhere.
- **Customer / Project # / Project Name / Revision**: partial match within the selected field only.


### Delivery PDF picker / reader hardening (V0.24)

- One visible file-import control only; the native file input stays hidden in HTML.
- Normal pointer activation uses a native label-to-file-input relationship instead of `showPicker()` / scripted click.
- PDF.js updated from 4.10.38 to 6.3.289 with two CDN sources.
- No database migration is required.

### Authentication persistence (V0.23)

- Supabase access/refresh tokens continue to be stored in browser `localStorage`.
- A valid saved session must survive a normal page refresh and browser reopen.
- The login gate starts hidden and must stay hidden while `restoreSession()` checks browser storage. It is shown only when no valid saved session exists. This prevents a misleading sign-in popup/flash on every refresh.
- Do not require a fresh password login merely because the page was refreshed.
- Explicit Sign out, revoked/invalid sessions, or browser storage being cleared should still return the user to the login gate.

## 10. Database / deployment

Current schema version: **20**.

V0.24 introduces **no database migration**. If the database is already on V0.20 schema, deploy the V0.24 frontend only.

For a database older than V0.20, run:

`supabase_v0_20.sql`

in the Supabase SQL Editor before deploying V0.24.

The migration is cumulative/idempotent and includes prior inventory/purchasing/Spruce schema. V0.20 adds:
- `delivery_code` and source-PDF metadata on `spruce_orders`
- per-level case-insensitive unique Delivery Name protection
- `upsert_spruce_order_import(...)` for atomic create/revise of PDF-imported Spruce packages

GitHub Pages does not run SQL files automatically. SQL files may remain in the repository as migration/reference files.

## 11. Coding / UX principles

- Preserve existing working behavior unless the requested change requires altering it.
- Do not silently discard or truncate material quantities. Flag mismatches/excesses for user review.
- Keep source descriptions for traceability while using canonical identity for calculations.
- Shared multi-user changes use Supabase Realtime plus manual/window-focus refresh fallback.
- Continue using optimistic version checks / database guards where practical.
- Keep README and this handoff updated with each material workflow/schema change.
