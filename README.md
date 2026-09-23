# EWP Material Forecast — V0.5

**Developed by Samuel Chung**

A static, browser-based EWP material forecasting prototype designed for GitHub Pages. No Python, Node, admin rights, or local server is required to use the deployed site.

## What V0.5 does

- Uploads an EWP material-list PDF and parses it locally in the browser.
- Reads the intended fields from the material list: Project #, revision, Address (Project Name), level(s), and each level's Total Lengths section.
- Adds manual project-default fields for Customer and Sales.
- Leaves **Use this date for all levels** unchecked by default, so each detected level can have its own estimated delivery date.
- Stores one project with multiple level/package records.
- Projects & Materials uses materials as rows.
- Expanded multi-level projects show one column per level.
- Every card shows **Address (Project Name)** as the primary heading, with Project # / revision / Customer / Sales in smaller muted text. The project default delivery date remains available for editing but is intentionally not shown on matrix cards.
- New multi-level projects are collapsed by default and can be expanded into one column per level.
- A collapsed project shows the next incomplete delivery level/date, how many packages (incomplete levels) remain, and weighted overall % complete.
- Project/level cards use a compact layout with smaller type, tighter spacing, thinner progress bars and shorter action buttons.
- Projects & Materials has a dedicated horizontal scrollbar above the matrix, so you never need to scroll to the bottom of a long material list just to move left/right.
- The matrix itself uses a bounded vertical viewport with sticky project headers and a sticky Material column, making large row/column sets behave more like a frozen-pane spreadsheet.
- Shift + mouse wheel over the matrix scrolls projects horizontally.
- Projects can be edited directly from Projects & Materials, including Project #, revision, Customer, Sales, Address (Project Name), and project default delivery date.
- The Edit Project dialog can optionally apply its default delivery date to all levels.
- Clicking the backdrop outside the Edit Project or Manage Delivery dialog closes it and returns to Projects & Materials.
- Expanded level cards show each level's weighted % complete.
- Completion is calculated automatically from delivered LF / original required LF.
- A collapsed project's material cell is the outstanding LF summed across its currently visible levels.
- Records full or partial deliveries without changing the original imported requirement.
- Monthly Forecast sums outstanding LF by each level's estimated delivery month.
- Delivery history can be undone.
- Matrix and forecast can be exported to CSV.
- Local data can be backed up/restored as JSON.

## Existing browser data

V0.5 intentionally keeps the same browser storage key and automatically migrates V0.2/V0.3/V0.4 data. Existing projects, levels, delivery history, and saved collapse state should remain. New multi-level projects start collapsed; an existing project keeps the collapse/expand state you already saved.

## Package definition in V0.5

For now, one project level = one package. A package remains outstanding until that level reaches 100% delivered. This can be changed later if your operational definition of a package is different.

## Deploy with GitHub Pages

Put these files directly in the repository root:

- `index.html`
- `styles.css`
- `app.mjs`
- `parser.mjs`
- `.nojekyll`
- `.gitignore`
- `README.md`

Then in GitHub:

1. Open **Settings → Pages**.
2. Under **Build and deployment**, choose **Deploy from a branch**.
3. Select `main` and `/(root)`.
4. Save.

Do not commit real customer PDFs, exported CSV files, or JSON backups. The included `.gitignore` helps guard against this.

## Privacy / storage

PDF parsing and project data are browser-side. The app does not intentionally upload selected PDFs to a backend. Saved project data is stored in the browser's `localStorage`, so it is specific to that browser/profile unless you use Backup JSON / Restore JSON.

PDF.js is loaded from a CDN at runtime. A corporate network that blocks both configured CDNs can prevent PDF parsing even though the rest of the site loads.
