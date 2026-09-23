# EWP Material Forecast — GitHub Pages V0.2

A browser-only prototype for turning Weyerhaeuser-style EWP material-list PDFs into:

1. a **Projects & Materials** matrix where rows are materials and each project level is a separate column; and
2. a **Monthly Forecast** where rows are materials and columns are delivery months.

The forecast uses **outstanding material**, not the original PDF total. Partial/urgent deliveries can therefore be recorded against any level and the monthly forecast drops immediately.

## What V0.2 does

- Upload a PDF in the browser.
- Read **Project #, Revision, Address, Level(s), and Total Lengths**.
- Ignore the individual member list, connectors, blocking detail, accessories and other report content.
- Enter one estimated delivery date for the project, or override dates level-by-level.
- Review and edit parsed data before saving.
- Show materials as rows and project levels as columns.
- Record a whole-level or partial delivery without changing the original PDF requirement.
- Change a saved level's forecast date when the schedule moves.
- Remove a wrongly imported/cancelled level (separate from delivery history).
- Undo recorded deliveries.
- Aggregate outstanding LF by month.
- Export both main views as CSV.
- Backup/restore the local database as JSON.
- Store data only in the browser's `localStorage`.

## Privacy model

The repository contains only the app code. **Do not commit customer PDFs or exported project data to the repo.**

The selected PDF is parsed locally in the user's browser. The PDF itself is not uploaded to an application server. PDF.js is loaded from a public CDN; only the PDF.js library is downloaded from that CDN, not the user's PDF.

## Deploy on GitHub Pages

No Python, Node, npm, administrator rights or local server is required for normal use.

1. Create a GitHub repository, for example `ewp-forecast`.
2. Upload/commit all files in this folder to the repository root.
3. In GitHub, open **Settings → Pages**.
4. Under **Build and deployment**, choose **Deploy from a branch**.
5. Select branch **main** and folder **/(root)**, then Save.
6. Wait for GitHub to publish the site. GitHub will show the Pages URL on the same settings page.
7. Open that URL in Edge/Chrome and upload a material-list PDF.

## Important V0.2 limitations

- Project data lives only in the browser/device that created it. Use **Backup JSON** if you need to move data to another PC or protect against browser-data cleanup.
- A new revision of an existing Project # currently replaces that project's stored levels after confirmation. Existing delivery history is intentionally removed because revised quantities may no longer correspond to the previous takeoff.
- The parser is targeted at the material-list format used for the initial sample. Other report layouts may need additional parser rules.
- The forecast is in **linear feet**, because it uses the report's Total Lengths section. It does not yet convert demand into stock-length piece quantities or subtract yard inventory/incoming POs.
- PDF.js is loaded from jsDelivr with a cdnjs fallback. If a corporate network blocks both CDNs, the PDF reader will not load. A later version can vendor PDF.js inside the repo to remove that dependency.

## Files

- `index.html` — UI structure
- `styles.css` — UI styling
- `parser.mjs` — PDF line extraction + Weyerhaeuser material-list parser
- `app.mjs` — project storage, matrix, forecast, deliveries, CSV and backups
- `.nojekyll` — tells GitHub Pages to serve the files directly

## Data model

The app keeps the original requirement and delivery transactions separately:

`PDF Total Lengths → Original Requirement → Delivery Transactions → Outstanding → Monthly Forecast`

This is deliberate. An urgent partial shipment does not destroy or edit the original takeoff.
