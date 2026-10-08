**Phase 2 update:** Project Tracking now saves projects, work items, settings and saved filters in Supabase. See the repository root `README.md` and `phase2_migration.sql` for setup before deployment.

# EWP Project Tracker V0.5

Local browser prototype for EWP project/work tracking.

## V0.5 major change — one project, multiple work items

A project now keeps one permanent project number while containing one or more independently assigned work items.

Example:
- TC26042 — Dimension Lumber Takeoff — Sarah — In Progress
- TC26042 — EWP Takeoff — Sam — Queue
- TC26042 — EWP Design — John — Queue

The project number is not duplicated; the Board and List display the individual work items.

### Behavior
- Board cards represent work items, not whole projects.
- Dragging a card changes only that work item's status.
- Each work item has Task, Assignee, Status, and an optional Task Due Date.
- If Task Due Date is blank, it uses the project's Due Date.
- Project status is automatic:
  - all work items Queue -> Queue
  - all work items Done -> Done
  - anything in between -> In Progress
- Clicking any Board card or List row opens the parent project and all its work items for editing.
- Existing V0.4 single-task projects are automatically migrated into one V0.5 work item.
- Existing saved filters remain compatible; Task, Assignee, and Status now filter individual work items.
- Search/filter results show work-item counts and project counts.

## Existing features retained
- TCYYXXX numbering with non-recycled automatic sequence
- hard duplicate project-number prevention
- editable last three project-number digits
- Sales, Customer, Address, Phase, Project Type, >14-inch TJI, APL Required, Date Submitted, Due Date
- Settings for Sales, Assignee, and Task options
- Board / List views
- shared multi-select search/filter system
- saved filters
- project deletion without rolling the number counter backward
- local browser persistence

## Testing
Unzip the folder and open `index.html` in Chrome or Edge.
