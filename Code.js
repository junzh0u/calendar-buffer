/**
 * Buffer events around tagged Google Calendar events.
 *
 * Watches the primary calendar for events tagged with the reserved color
 * (default Graphite) or a "#buffer" description tag; for each, maintains
 * Busy "Block" events before and after it on the Block calendar. Buffers
 * only claim free time: they shrink out of the way of real Busy events on
 * the watched calendars, and buffers that overlap or touch each other merge
 * into a single block. The sync is
 * a stateless reconcile — buffers follow the source event when it moves, and
 * disappear when it is deleted or un-tagged. Every run also purges all past
 * events from the Block calendar, hand-made ones included. Runs on a
 * calendar-update trigger plus an hourly sweep (see install()).
 *
 * Tag an event:   right-click → Graphite color, or "#buffer" in the description
 * Custom padding: "#buffer 15/60" in the description = 15 min before / 60 after;
 *                 "#buffer 45" = 45 both sides; "#buffer 0" = no buffers even
 *                 while the color tag stays on
 *
 * Block events are titled by their length: "30m buffer", "3h 30m buffer".
 *
 * Optional script properties (Project Settings → Script properties):
 *   TAG_COLOR_ID (default 8 = Graphite), BLOCK_CALENDAR_NAME (default Block),
 *   DEFAULT_BUFFER ("30" or "15/60", default 30/30, capped at the event's
 *   own duration — an explicit #buffer isn't), WATCHED_CALENDARS
 *   (comma-separated calendar names or IDs, default primary — re-run
 *   install() after changing it so the calendar triggers match)
 */

// Marker stored in each managed event's private extended properties; manual
// events on the Block calendar lack it and are never touched.
const APP_TAG = 'calendar-buffer';

const SCRIPT_PROPS = PropertiesService.getScriptProperties();

// Overridable via script properties of the same name (Project Settings →
// Script properties) — no redeploy needed. WATCHED_CALENDARS is a
// comma-separated list of calendar names or IDs; re-run install() after
// changing it so the calendar triggers match. Color IDs 1-11:
// https://developers.google.com/apps-script/reference/calendar/event-color
const WATCHED_CALENDARS = (SCRIPT_PROPS.getProperty('WATCHED_CALENDARS') || 'primary')
  .split(',')
  .map((calendar) => resolveCalendarId(calendar.trim()));
const BLOCK_CALENDAR_NAME = SCRIPT_PROPS.getProperty('BLOCK_CALENDAR_NAME') || 'Block';
const TAG_COLOR_ID = SCRIPT_PROPS.getProperty('TAG_COLOR_ID') || '8'; // Graphite
// Same notation as the #buffer override: "45" = both sides, "15/60" = before/after
const DEFAULT_BUFFER = parsePadding(SCRIPT_PROPS.getProperty('DEFAULT_BUFFER') || '30/30');
const HORIZON_DAYS = 14;

const MS_PER_MINUTE = 60 * 1000;

/** Entry point for both triggers. */
function reconcile() {
  // The calendar trigger fires once per edit, so a burst of edits stacks
  // runs — serialize them; the reconcile each run does is identical anyway.
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) return;
  try {
    reconcileLocked();
  } finally {
    lock.releaseLock();
  }
}

function reconcileLocked() {
  const now = new Date();
  const horizon = new Date(now.getTime() + HORIZON_DAYS * 24 * 60 * MS_PER_MINUTE);
  const blockCalendarId = resolveCalendarId(BLOCK_CALENDAR_NAME);

  // Wanted buffers: a pre and post buffer for every tagged event in the
  // horizon, plus the Busy intervals buffers must stay clear of
  const rawBuffers = [];
  const busy = [];
  for (const calendarId of WATCHED_CALENDARS) {
    const events = listEvents(calendarId, {
      timeMin: now.toISOString(),
      timeMax: horizon.toISOString(),
      singleEvents: true, // expand recurring events; each instance gets buffers
    });
    for (const event of events) {
      if (!event.start.dateTime) continue; // all-day events: no buffers, and they don't block any
      if (isDeclined(event)) continue;
      const start = new Date(event.start.dateTime);
      const end = new Date(event.end.dateTime);
      if (event.transparency !== 'transparent') busy.push({ start, end });
      const padding = bufferMinutes(event);
      if (padding === null) continue;
      addBuffer(rawBuffers, event, 'pre', new Date(start.getTime() - padding.before * MS_PER_MINUTE), start, now);
      addBuffer(rawBuffers, event, 'post', end, new Date(end.getTime() + padding.after * MS_PER_MINUTE), now);
    }
  }

  // Desired state: buffers shrunk out of the time Busy events occupy — a
  // buffer only pads free time — then overlapping or touching survivors
  // merged into single blocks
  const buffers = rawBuffers.map((buffer) => shrinkBuffer(buffer, busy, now)).filter((buffer) => buffer !== null);
  const desired = mergeBuffers(buffers);

  // Purge everything on the Block calendar that already ended — hand-made
  // events included, this is the one place the script touches them. Keeps
  // the calendar (and the managed listing below) from growing forever.
  let purged = 0;
  const pastEvents = listEvents(blockCalendarId, {
    timeMax: now.toISOString(),
    singleEvents: true, // a past instance of a recurring event dies alone
  });
  for (const event of pastEvents) {
    // timeMax matches on start time, so skip events still in progress
    const end = new Date(event.end.dateTime || event.end.date);
    if (end > now) continue;
    Calendar.Events.remove(blockCalendarId, event.id);
    purged++;
  }

  // Existing state: all future managed buffers, unbounded so orphans from
  // sources moved beyond the horizon still get cleaned up (the purge above
  // already handled the past)
  const existing = new Map();
  const managed = listEvents(blockCalendarId, {
    timeMin: now.toISOString(),
    privateExtendedProperty: `app=${APP_TAG}`,
  });
  for (const event of managed) {
    const props = event.extendedProperties.private;
    // Pre-merge deployments stamped source/role instead of key; the fallback
    // still matches their lone blocks, whose key is the plain buffer key
    existing.set(props.key || bufferKey(props.source, props.role), event);
  }

  let created = 0;
  let updated = 0;
  for (const [key, want] of desired) {
    const have = existing.get(key);
    existing.delete(key);
    if (have === undefined) {
      Calendar.Events.insert(
        {
          summary: want.summary,
          description: want.description,
          start: { dateTime: want.start.toISOString() },
          end: { dateTime: want.end.toISOString() },
          transparency: 'opaque', // Busy
          reminders: { useDefault: false }, // buffers shouldn't notify
          extendedProperties: { private: { app: APP_TAG, key } },
        },
        blockCalendarId
      );
      created++;
    } else if (
      new Date(have.start.dateTime).getTime() !== want.start.getTime() ||
      new Date(have.end.dateTime).getTime() !== want.end.getTime() ||
      have.description !== want.description ||
      have.summary !== want.summary
    ) {
      Calendar.Events.patch(
        {
          summary: want.summary,
          description: want.description,
          start: { dateTime: want.start.toISOString() },
          end: { dateTime: want.end.toISOString() },
        },
        blockCalendarId,
        have.id
      );
      updated++;
    }
  }

  // Leftovers: source deleted, un-tagged, moved, or declined since creation.
  // A block already in progress is left alone — a just-ended meeting drops out
  // of the source window above, orphaning its still-live post buffer; don't
  // delete time you're already inside. The past-purge reaps it once it ends.
  let removed = 0;
  for (const orphan of existing.values()) {
    if (new Date(orphan.start.dateTime) <= now) continue;
    Calendar.Events.remove(blockCalendarId, orphan.id);
    removed++;
  }

  console.log(
    `${desired.size} blocks desired: ${created} created, ${updated} updated, ` +
      `${removed} removed, ${purged} past events purged`
  );
}

/**
 * Padding in minutes for a tagged event, or null when the event isn't
 * tagged. The color tag alone gives the defaults; a "#buffer" description
 * tag works without the color and can override the padding.
 */
function bufferMinutes(event) {
  const match = (event.description || '').match(/#buffer\b(?:\s+(\d+(?:\s*\/\s*\d+)?))?/i);
  if (match === null && event.colorId !== TAG_COLOR_ID) return null;
  if (match !== null && match[1] !== undefined) return parsePadding(match[1]);
  // Default padding never exceeds the event's own length — a 15 min meeting
  // gets 15 min buffers, not the full default
  const duration =
    (new Date(event.end.dateTime).getTime() - new Date(event.start.dateTime).getTime()) / MS_PER_MINUTE;
  return {
    before: Math.min(DEFAULT_BUFFER.before, duration),
    after: Math.min(DEFAULT_BUFFER.after, duration),
  };
}

/** "45" → 45 min both sides; "15/60" → 15 before, 60 after. Throws on garbage. */
function parsePadding(text) {
  const match = text.trim().match(/^(\d+)(?:\s*\/\s*(\d+))?$/);
  if (match === null) throw new Error(`Bad padding "${text}" — use "30" or "15/60"`);
  const before = Number(match[1]);
  return { before, after: match[2] === undefined ? before : Number(match[2]) };
}

/** Record one wanted buffer, skipping empty ones and those already over. */
function addBuffer(buffers, source, role, start, end, now) {
  if (end <= start || end <= now) return;
  buffers.push({
    key: bufferKey(source.id, role),
    role,
    start,
    end,
    title: source.summary || '(untitled)',
  });
}

/**
 * Shrink a buffer out of the time Busy events occupy: a pre buffer keeps
 * only the free time immediately before its meeting, a post buffer the free
 * time immediately after. Returns null when nothing is left — a meeting
 * butted right against the source event leaves no room to pad.
 */
function shrinkBuffer(buffer, busy, now) {
  let { start, end } = buffer;
  for (const interval of busy) {
    if (interval.start >= end || interval.end <= start) continue; // no collision
    if (buffer.role === 'pre') {
      start = interval.end;
    } else {
      end = interval.start;
    }
  }
  if (end <= start || end <= now) return null;
  return { ...buffer, start, end };
}

/**
 * Merge overlapping or touching buffers into blocks: one calendar event per
 * contiguous run, keyed by its member buffers so the reconcile can diff it.
 */
function mergeBuffers(buffers) {
  const sorted = [...buffers].sort((a, b) => a.start - b.start);
  const desired = new Map();
  let block = null;
  const flush = () => {
    if (block === null) return;
    desired.set(blockKey(block.keys), {
      start: block.start,
      end: block.end,
      summary: blockTitle(block.start, block.end),
      description: `Buffer for ${block.titles.map((title) => `"${title}"`).join(', ')}`,
    });
  };
  for (const buffer of sorted) {
    if (block !== null && buffer.start <= block.end) {
      if (buffer.end > block.end) block.end = buffer.end;
      block.keys.push(buffer.key);
      if (!block.titles.includes(buffer.title)) block.titles.push(buffer.title);
    } else {
      flush();
      block = { start: buffer.start, end: buffer.end, keys: [buffer.key], titles: [buffer.title] };
    }
  }
  flush();
  return desired;
}

function bufferKey(sourceId, role) {
  return `${sourceId}:${role}`;
}

/** Title a block by its length: "30m buffer", "1h buffer", "3h 30m buffer". */
function blockTitle(start, end) {
  const minutes = Math.round((end - start) / MS_PER_MINUTE);
  const parts = [];
  if (minutes >= 60) parts.push(`${Math.floor(minutes / 60)}h`);
  if (minutes % 60 > 0 || minutes < 60) parts.push(`${minutes % 60}m`);
  return `${parts.join(' ')} buffer`;
}

/**
 * Stable identity for a block: its member buffer keys, sorted — so a block
 * is patched when only its times or sources' titles change, and replaced
 * when its membership does. A lone buffer's block key is its plain buffer
 * key. Hashed when too long for an extendedProperties value (1024 chars).
 */
function blockKey(keys) {
  const joined = [...new Set(keys)].sort().join('|');
  if (joined.length <= 1000) return joined;
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, joined));
}

function isDeclined(event) {
  const self = (event.attendees || []).find((attendee) => attendee.self);
  return self !== undefined && self.responseStatus === 'declined';
}

/**
 * Resolve a calendar name to its ID so no ID has to live in config;
 * "primary" and anything with an "@" is already an ID and passes through.
 */
function resolveCalendarId(nameOrId) {
  if (nameOrId === 'primary' || nameOrId.includes('@')) return nameOrId;
  const calendars = CalendarApp.getCalendarsByName(nameOrId);
  if (calendars.length !== 1) {
    throw new Error(`Expected exactly one calendar named "${nameOrId}", found ${calendars.length}`);
  }
  return calendars[0].getId();
}

/** Fetch all pages of Calendar.Events.list. */
function listEvents(calendarId, params) {
  const events = [];
  let pageToken;
  do {
    const page = Calendar.Events.list(calendarId, { ...params, maxResults: 2500, pageToken });
    events.push(...(page.items || []));
    pageToken = page.nextPageToken;
  } while (pageToken !== undefined);
  return events;
}

/** Run once by hand: grants auth, (re)creates the triggers, does a first sweep. */
function install() {
  for (const trigger of ScriptApp.getProjectTriggers()) {
    ScriptApp.deleteTrigger(trigger);
  }
  for (const calendarId of WATCHED_CALENDARS) {
    const email = calendarId === 'primary' ? Session.getEffectiveUser().getEmail() : calendarId;
    ScriptApp.newTrigger('reconcile').forUserCalendar(email).onEventUpdated().create();
  }
  // Safety net for missed trigger fires, and advances the horizon window
  ScriptApp.newTrigger('reconcile').timeBased().everyHours(1).create();
  reconcile();
}
