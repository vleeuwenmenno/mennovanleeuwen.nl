# Widget SDK 1 / build identity 1.1 (first vertical slice)

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
button(label,eventID), editor(). Tones: normal, muted, accent. No raw HTML,
URLs, arbitrary attributes, CSS or host functions. Spacing tokens: compact,
normal, roomy in styles/tokens.json (gap and padding).
The parent owns window/menu/theme controls. The editor is native, with immediate
host transactions, selection, IME and native undo; events cannot preventDefault
retroactively. The host keeps one stable native editor even if descriptors are pending or fail.
Checklist transformations are package code bound to the displayed descriptor input snapshot;
stale buttons and results cannot act on a newer revision.

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
No navigation, clipboard, exports, logging, arbitrary RPC or model forwarding APIs.
Package grants never authorize forwarding private data to a model.

## Build and activation

Both defaults and forks use the same verifier, digest and loader. The digest covers
all accepted files plus the pinned SDK/QuickJS build identity. Imported dist/ and
build.json are discarded; snapshots are rebuilt and verified. Source saves never
activate. Initial build-1.0 snapshots need explicit rebuild/preview/activation for
the new build identity; imports never silently upgrade granted code. Build and preview first; explicit activation binds the digest and source
identity. Previous revision recovery requires the current installation digest,
so a stale device cannot silently roll back a newer installation. Configuration
and placement are not rolled back. Missing sources/runtime are not removals.

## Follow-up interfaces

Agenda, inbox, status and Minecraft still use the legacy registry in this slice.
Their future APIs must project typed results and bind per-resource handles to
account, instance, digest and revocation epoch. Calendar link/unlink, broader
catalog, TypeScript compilation, source package tests, agent browser authoring and
cross-device installation conflict UI are staged work, not implemented APIs.

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
