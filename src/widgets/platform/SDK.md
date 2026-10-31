# Widget SDK 1 / build identity 1.2

Packages are UTF-8 folders with manifest.json, src/*.js, styles/tokens.json,
assets/*.txt or *.json, tests/*.json and README.md. System packages are immutable;
signed-in users clone to ~/.local/share/mvlos/widgets/<id>. Browser and Seafile
backing identities are distinct; a display path does not confer authority.

## Execution

JavaScript modules may import only relative src/*.js and @mvlos/widget.
Exports: render(input) returns a descriptor; event(input, eventID) returns null or
{type:'note.edit', start, end, text, expectedRevision}. start/end are UTF-16 offsets
within the supplied window of the instance's note; inserted text is at most 32 KiB UTF-8.
Legacy note.replace remains supported only when the projection contains the full note.
Async entrypoints are unsupported.
Every invocation gets a fresh bounded QuickJS WASM VM in a dedicated worker.
No fetch, DOM, cookies, storage, host objects, npm, build hooks or timers.
Promise jobs drain at most 16 times; remaining work fails. All handles are disposed.
Limits: 48 files, 32 KiB/file, 128 KiB/source, 64 KiB/output, 256 nodes,
12 descriptor levels, 8 MiB VM memory, 256 KiB stack, 40 ms VM CPU,
3 s worker watchdog, 8 concurrent workers, 32 starts per second across the tab. Saturated work waits fairly (256 queued maximum, two per instance). Cancellation removes
queued jobs and terminates active workers without consuming future start slots. Invalid input
is distinct from capacity errors. Hidden/covered/mobile desktops do not execute.

## Descriptor vocabulary

@mvlos/widget exports column(...children), row(...children), text(value,tone),
button(label,eventID), editor(), action(label,handle,options), link(label,handle,options),
image(handle,alt), dot(handle), details(summary,...body), card(handle,...children).
Action/link options: hint, children, tone; action also accepts checked (native checkbox role).
Tones: normal, muted, accent, danger, success, warning. text also takes a third argument
{size}: 'display' scales the text with the widget's width (a big clock face; the longer the
text, the smaller it gets, so it always fits on one line) and 'headline' is the smaller line
under it. No raw HTML,
URLs, arbitrary attributes, CSS or host functions. Spacing tokens: compact,
normal, roomy in styles/tokens.json (gap and padding).
The parent owns window/menu/theme controls. The editor is native, with immediate
host transactions, selection, IME and native undo; events cannot preventDefault
retroactively. The host keeps one stable native editor even if descriptors are pending or fail.
Checklist transformations are package code bound to the displayed descriptor input snapshot;
stale buttons and results cannot act on a newer revision.

## Manifest

Fields (all strict, unknown fields are refused): schema 1, sdk 1, id (a-z, 0-9, -), name, entry
(src/*.js), settings.appearance, sizing {width, height} (integers 120 to 800), capabilities and
the optional phone.

- settings.appearance: "panel" (the usual card), "sticky" (tinted paper) or "bare": no
  background, border, tape or shadow, only the content over the wallpaper with a soft text
  shadow. The frame handle and menu still appear when you point at it.
- phone: true lets the widget run and show on a phone-sized screen (under 720px wide), full
  width in the scrolling column of notes and widgets. Missing or false: the widget stays hidden
  there, nothing runs, and Add widget on a phone does not list it. The ACTIVE revision decides:
  a fork that says false (or nothing) is hidden on a phone even if the built-in it came from
  says true. Make the layout fluid (the host gives it the phone's width, about 350px), keep
  taps at least 44px, and set false when it cannot work that narrow. phone is part of the digest.

## Capabilities and projections

note.read: input.note = {text,revision,offset,next?,continues?} for this widget's one bound note.
text is a host-owned window of at most 64 lines / 8 KiB; offset and next are absolute
UTF-16 offsets. continues marks a window whose first line already has preceding non-whitespace
content; it must not create a checklist item from that first fragment. Pages prefer
complete-line boundaries. Oversized lines use code-point chunks with forward progress;
whitespace-only indentation is split before its first content token where needed,
so checklist prefixes stay reachable without enlarging the window. The host's Previous/Next controls page through all content; packages
emit at most 64 checklist buttons. The native editor always uses the full note.
note.write: a revision-checked edit inside that window only. Both the note revision
and full bound text must still match; replacements of partial windows are refused.
Native edits use the same UTF-8 size policy (256 KiB for new notes, preserving
larger legacy notes and permitting 32 KiB growth per transaction without truncation).
The displayed view, input, page and source identity are one immutable presentation.
Shell notesHidden/coverage eligibility, document/mobile/minimized state, grants and
account identity are checked again at admission and completion, with layout-time
cancellation when eligibility changes.
weather.read: input.weather = {place,units,summary,hours,days} for the host-selected
place only. Device here stays browser-local; only explicit cities sync. Visibility-aware
refresh uses forecast age and a 15-minute timer, aborted while hidden. Account
hydration, instance/runtime revision and grant changes restart the refresh loop using
a stable lifecycle identity; ordinary renders do not. Results and errors remain
bound to that identity, so late replies cannot populate a different lifecycle. Geocoding is a trusted user-operated control, not a package API.
Errors are plain bounded messages, not raw fetch responses or host objects.
Default packages use existing instance authority. Fork activation requires explicit
real-data opt-in. Preview always uses mocks. Revocation/logout cancels pending work.
## Domain projections and explicit effects

agenda.read supplies agenda.state, today, now, days (label/key, tasks and events),
errors and page. Task fields: title, notes, due, time, allDay and opaque color/open/complete
handles. Event fields: title, time, calendar, location, start/end milliseconds, allDay,
color/open/meet handles, optional linked-note mark (glyph/title/open). The trusted calendar
and task domains own selected/hidden calendars, task-list preferences and recurrence.
agenda.act permits only the projected completion/open/meeting/linked-note actions.
No caller-supplied task patch, provider ref, calendar query or destination is accepted.

inbox.read supplies inbox.state, count, errors, page and sections (key/title/empty/total/items).
Items have title, repo, number, kind, draft, state, ago, source and an opaque open handle.
inbox.navigate permits those destinations and the fixed notifications page. Normal click
uses the existing Git availability check; modified and middle clicks use the original bound
provider URL. Provider URLs/refs are not included in the VM's projection.

status.read supplies status.state, down count, page and checks (name/address, enabled/down,
error/downSince, uptime/responseTime, sslDays/sslValid and opaque open handle).
status.navigate permits the selected updown check and fixed checks page only.

minecraft.read supplies minecraft.state, online/address, motd/version/software/difficulty,
latency, world (day/clock/phase), players (online/max/totalNamed/list) and page. Each player
has name, dimension, vitals and an optional image handle. minecraft.act permits the fixed
server window and copying the fixed server address after an explicit native interaction.
Package strings never become clipboard text or connection addresses. Head images are fixed
provider resources for validated Minecraft names; no package-provided image URL is accepted.

controls holds optional host-selected signIn/google/settings/open handles. error is a bounded,
scrubbed request error. All resource handles are ephemeral and type-checked in the trusted
renderer against account/connection identity, instance, source revision, grant and exact
presentation. A handle has no authority outside that presentation. Action capabilities require
the corresponding read capability; read-only packages keep display content with no actions.
There is no arbitrary resource lookup, RPC, navigation URL or clipboard/export API.

The host projects at most 8 agenda rows, 5 inbox rows per visible section, 12 status checks
or 12 player details per page. page = {total,shown,page,pages,truncated}; page is zero-based.
Previous/Next controls remain host-owned so every accepted item is reachable. Text fields are
bounded (16–1024 UTF-16 units depending on field), with a visible truncation suffix. Errors
are at most eight scrubbed 160-unit strings. Inbox/status payload schemas are checked before
projection; malformed or over-10,000-row sections fail explicitly. The existing 64 KiB input,
64 KiB output and 256-node limits still apply. Preview has synthetic data and no resource
handles. Reads refresh only while eligible, cancel on hide/revocation, and share caches only
inside the same account/connection authority. Agenda tasks use shared live-reader leases:
Tasks/Calendar can retain a read after a widget hides; losing the last eligible reader
aborts it and prevents late adoption. Logout/provider changes cancel the old read authority.

No arbitrary exports, logging, RPC or model forwarding APIs.
Package grants never authorize forwarding private data to a model.

## Clock

The clock is a built-in kind (clock) with no capabilities and no data. The host runs one timer
while the widget is eligible (a tick each minute, each second when the Seconds option is on;
nothing while hidden, covered or on a phone that does not show it) and passes input.clock:
{now, today, time, period, weekday, date, weekdayShort, dateShort, seconds, hour12, show, tone}.
time is "14:32", "14:32:07" or, in 12-hour mode, "2:32" with period "PM"; weekday and date are
in the person's language (31 October 2026); show is full, short or none (how much date to
draw); tone is normal or accent. Per-instance options (24/12-hour, seconds, date, accent colour
and tilt) live in the widget's menu and sync with its other settings. A custom widget (or a fork)
does not get input.clock: it sees input.custom {now, today}, a minute-resolution clock.

## Custom widgets

A custom widget is a seventh, open-ended kind of widget: any number of instances, each from
its own package folder (instance id custom-xxxxxxxx, kind custom). It is created in the
Widget Workshop: "New custom widget template" writes the starter below to a folder in your
browser files or Seafile, edit src/main.js in Xed, "Build & mock preview", tick the opt-in
and "Activate as new widget". That places it on the desktop. It then appears under
Add widget (desktop menu, Spotlight, All apps) and survives reload and sync through the same
installation records as the built-ins (12 live widget records in total per account, 480 KiB
budget). Closing it only takes it off the desktop; "Remove this widget" in the Workshop deletes
the installation and its saved state. A custom revision never runs until you grant that exact
revision for that instance (per session, like every other fork). A custom widget whose
installation is missing or unreadable stays on the desktop and says so.

The manifest id and name are the package's own (id: a-z, 0-9, -). The only capability is
custom.state, optional. input.custom is always {now, today} (host clock in milliseconds, and the local
date as YYYY-MM-DD). With custom.state it also holds state (any JSON, null until first saved)
and revision. event(input, eventID) may return null or
{type:'custom.replace', state, expectedRevision: input.custom.revision}; state serializes to
at most 4096 bytes of JSON and is applied only if the saved state still has that revision.
State is stored per instance, syncs with the account and is not readable by other widgets.
There is no text input, network, notes, domain data or other host access.

Starter package (src/widgets/packages/custom-template, also at /usr/share/mvlos/widgets/custom-template):

manifest.json
```json
{"schema":1,"sdk":1,"id":"daily-tally","name":"Daily tally","entry":"src/main.js","settings":{"appearance":"panel"},"sizing":{"width":240,"height":160},"capabilities":["custom.state"],"phone":true}
```

src/main.js
```js
import { column, row, text, button } from '@mvlos/widget';

// Daily tally: count things (glasses of water, pages read) per day. It keeps
// { day, count, total } in this widget's own saved state (custom.state, at most 4 KiB).
// input.custom = { now, today, state, revision }. Changing state is an explicit effect:
// event() returns { type: 'custom.replace', state, expectedRevision }, and the host only
// applies it if the state is still the one it was computed from.

function read(input) {
  const c = input.custom || {};
  const s = c.state && typeof c.state === 'object' ? c.state : {};
  const total = typeof s.total === 'number' ? s.total : 0;
  const count = s.day === c.today && typeof s.count === 'number' ? s.count : 0;
  return { today: c.today, count, total };
}

export function render(input) {
  const v = read(input);
  return column(
    text('Daily tally', 'accent'),
    text(String(v.count), v.count > 0 ? 'success' : 'muted'),
    row(button('+1', 'inc'), button('-1', 'dec'), button('Reset today', 'reset')),
    text(v.total + ' all time · ' + v.today, 'muted')
  );
}

export function event(input, name) {
  const v = read(input);
  let count = v.count;
  let total = v.total;
  if (name === 'inc') { count += 1; total += 1; }
  else if (name === 'dec' && count > 0) { count -= 1; total -= 1; }
  else if (name === 'reset') { total -= count; count = 0; }
  else return null;
  return { type: 'custom.replace', state: { day: v.today, count, total }, expectedRevision: input.custom.revision };
}
```

## Build and activation

Both defaults and forks use the same verifier, digest and loader. The digest covers
all accepted files plus the pinned SDK/QuickJS build identity. Imported dist/ and
build.json are discarded; snapshots are rebuilt and verified. Source saves never
activate. Earlier build-1.0/1.1 snapshots need explicit rebuild/preview/activation for
the new build identity; imports never silently upgrade granted code. Build and preview first; explicit activation binds the digest and source
identity. Previous revision recovery requires the current installation generation and active digest/source identity,
so a stale device cannot silently roll back a newer installation. Configuration
and placement are not rolled back. Missing sources/runtime are not removals.

## Follow-up interfaces

All six built-in folders use the same compiler/verifier/worker/renderer as forks.
Installation overrides, per-config counters and placement geometry/tombstones live in the
versioned widgets:state:v2 envelope. One-time legacy import waits for complete account/state
hydration; older clients cannot change canonical records after cutover. Account-scoped
writer/sequence journals and consumption watermarks in the same envelope make replay idempotent
across late tabs and reloads. All canonical persistence paths and receipt cleanup use one
origin-wide IndexedDB readwrite request scope for cross-tab exclusion. There is no Web Locks or
localStorage-only fallback: blocked transactional storage fails closed, retaining optimistic
memory and any durable journal; activation awaits a durable flush. Account changes cancel queued
writes and logout cleanup follows already active writers. Ordinary synced stores stay synchronous.
Pending placement remaps retain writer-local identity across moves, removals, replay passes and
reloads. Ordinary per-config counter ordering remains unchanged.
Writers never delete another writer's log; their own log is
removed only after a durable receipt. Receipts never evict old writers (256 maximum);
pending admission/replay is bounded to 1,024 operations, with at most 1,024 permanent placement
identity mappings. Capacity/conflicting-identity errors retain the journal. Unknown kinds,
unavailable sources and hidden widgets are recoverable, not removals. Revision recovery
changes no config, placement or note data. Cross-device conflicting generation/identity
changes reject stale recovery; same-revision activation retries are idempotent.

Calendar link/unlink and backlinks stay in the trusted menu/Notebook. The host also draws the
note's linked-event chips under a Sticky package's output (no package calendar operation or
authority). A package calendar operation, broader catalog, TypeScript/TSX compilation, execution
of source-defined tests, ClientCalls agent authoring and automatic conflict resolution remain staged (conflicts show a banner and the user decides).

## Runtime selection evidence

Pinned quickjs-emscripten-core and release-sync WASM: 0.32.0, with lockfile integrity.
[Upstream runtime documentation](https://github.com/justjake/quickjs-emscripten/blob/main/doc/quickjs-emscripten/classes/QuickJSRuntime.md)
documents memory/stack limits, interruption and pending-job execution. We use a
fresh context/runtime per call and a new worker per transaction. Production Vite
emits a static self-origin worker and a 503 KB WASM asset. CSP permits
wasm-unsafe-eval and self-origin workers; JavaScript unsafe-eval remains blocked.

The trusted descriptor renderer was exercised with native typing, IME, caret,
selection and undo. An iframe renderer would still need the same VM for bounded
CPU/heap and would add another protocol for input and theme. This slice chooses
the trusted renderer. An executable iframe comparison was not implemented.
