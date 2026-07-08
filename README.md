# calendar-buffer

Google Apps Script that maintains Busy buffer events around tagged Google
Calendar events, replacing the manual click-dance of creating them yourself.

Tag an event on your primary calendar and, within seconds, matching "Block"
events appear on the **Block** calendar before and after it, availability set
to Busy. The sync is a stateless reconcile, so the buffers track the source
event for the rest of its life: move the event and they follow, delete or
un-tag it and they disappear. Buffer events carry a private marker; anything
you created on the Block calendar by hand is left alone until it's over —
every run purges all past events from the Block calendar, hand-made ones
included, so the calendar never accumulates history.

## Usage

- **Tag**: right-click the event → color **Graphite**. That's the whole
  workflow — buffers of 30 min each side appear on their own (capped at the
  event's own length, so a 15 min meeting gets 15 min buffers).
- **Custom padding**: add `#buffer 15/60` to the event description
  (15 min before / 60 after). `#buffer 45` means 45 both sides. A `#buffer`
  tag also works without the color.
- **Suppress**: `#buffer 0` in the description removes the buffers while
  keeping the color.

Declined invitations and all-day events are skipped. Recurring events get
buffers per instance, out to the 14-day horizon.

## Setup

```bash
./deploy.sh
```

First run creates the Apps Script project and opens the editor; run
`install()` there once to grant auth and create the triggers (a calendar
update trigger for instant reaction, plus an hourly sweep that advances the
horizon and catches missed fires).

Requires a calendar named **Block** to exist. The horizon is a constant at
the top of `Code.js`; everything else can be changed without redeploying,
via script properties (Project Settings → Script properties):

| Property | Default | Meaning |
|---|---|---|
| `TAG_COLOR_ID` | `8` (Graphite) | [Color ID 1–11](https://developers.google.com/apps-script/reference/calendar/event-color) that marks an event for buffering |
| `DEFAULT_BUFFER` | `30/30` | Padding minutes when the event has no `#buffer` override — `45` = both sides, `15/60` = before/after; capped at the event's own duration (an explicit `#buffer` isn't) |
| `BLOCK_CALENDAR_NAME` | `Block` | Calendar the buffers are written to |
| `BUFFER_TITLE` | `Block` | Title of the buffer events (existing buffers are renamed on the next sweep) |
| `WATCHED_CALENDARS` | `primary` | Comma-separated calendar names or IDs to scan; re-run `install()` after changing so the triggers match |

`install()` creates one update trigger per watched calendar, so the trigger
set is fixed at install time. If you change `WATCHED_CALENDARS` without
re-running it, nothing breaks — a newly added calendar still syncs, but only
on the hourly sweep instead of within seconds, and a removed calendar's
trigger keeps firing harmlessly. `install()` is idempotent (it deletes all
project triggers before recreating), so re-run it anytime.

Calendars can be listed by name (`Family`) as long as exactly one calendar
has that name; `primary` and anything containing an `@` is treated as an ID.
To find a calendar's ID: in [Google Calendar](https://calendar.google.com),
hover the calendar under **My calendars** → **⋮** → **Settings and sharing**
→ **Integrate calendar** → **Calendar ID**. Your primary calendar's ID is
your email address (the literal `primary` also works). Secondary calendars
have IDs like `abc123def456@group.calendar.google.com` — use the whole
thing, including the `@group.calendar.google.com` suffix.
