# CLAUDE.md — calendar-buffer

Google Apps Script that keeps Busy "Block" buffer events in sync around
color-tagged Google Calendar events. What/why and usage: see README.md.

## Architecture

- Single stateless `reconcile()`: desired buffers (from tagged events in the
  next `HORIZON_DAYS`, shrunk out of the way of Busy events on the watched
  calendars **and hand-made events on the Block calendar**, then
  overlapping/touching ones merged into single blocks) diffed against existing
  managed buffers (all future, unbounded — so orphans from sources moved beyond
  the horizon still get cleaned up). Insert/patch/remove the difference; no
  stored state. The in-progress guard in the orphan sweep means a block you're
  currently inside is never deleted mid-flight — the past-purge reaps it once
  it ends.
- Every run also purges **all** past events from the Block calendar —
  hand-made ones included, by design. This is the only write path that
  ignores the managed-buffer marker.
- Managed buffers are identified by `extendedProperties.private`
  (`app=calendar-buffer` plus a `key` listing the member buffers as
  `sourceId:role` sorted and `|`-joined; events from pre-merge deployments
  carry `source`/`role` instead and match via a read-time fallback). The
  reconcile lists **all** future Block-calendar events in one call (no
  server-side `privateExtendedProperty` filter) and partitions them: tagged
  ones become the existing managed state to diff against; hand-made ones (no
  marker) are folded into the `busy` list so buffers shrink around them —
  timed ones only if non-transparent, all-day ones always (a Block-calendar
  all-day event is an unambiguous whole-day block, so transparency is ignored;
  its date-only bounds are read as local midnight, end exclusive). The script
  still never patches or removes a hand-made
  event as a managed buffer — it only reads them as busy, and purges them once
  past. A block whose membership changes is removed + reinserted, not patched.
- Uses the **Calendar advanced service** (manifest `enabledAdvancedServices`),
  not `CalendarApp`, for `transparency`, `extendedProperties`, and
  `singleEvents` recurrence expansion. `CalendarApp` is used only to resolve
  calendar names to IDs (keeps calendar IDs out of the public repo; entries
  with an `@` or the literal `primary` pass through as IDs).
- Triggers (created by `install()`): `forUserCalendar(...).onEventUpdated()`
  fires on any change to the watched calendar — including the tagging color
  click itself — plus an hourly time-based sweep. The script only *writes* to
  the Block calendar, so its own edits don't re-fire the trigger.
  `LockService` serializes burst fires.

## Deploying

- `./deploy.sh` — runs clasp via `bunx @google/clasp` (no global install);
  first run logs in, creates the Apps Script project, and opens the editor.
  `.clasp.json` is per-account state, gitignored.
- clasp 3.x renamed commands: `open` → `open-script` (`create`/`push` still
  work as aliases)
- First-deploy `clasp create` overwrites the local `appsscript.json` with the
  remote default manifest — deploy.sh restores it with `git checkout` before
  pushing

## Gotchas

- Buffer times compare by epoch, not ISO string — the API returns event times
  in the calendar's UTC offset while the script generates `Z`-suffixed ISO
- Manually deleting a managed buffer doesn't stick (the reconcile recreates
  it); the supported way to drop buffers for one event is `#buffer 0` in its
  description
- `install()` deletes **all** project triggers before recreating, so it's
  idempotent — re-run it after changing `WATCHED_CALENDARS`
