# Widget SDK 1 (first vertical slice)

Packages are UTF-8 folders with manifest.json, src/*.js, styles/tokens.json,
assets/*.txt or *.json, tests/*.json and README.md. System packages are immutable;
signed-in users clone to ~/.local/share/mvlos/widgets/<id>. Browser and Seafile
backing identities are distinct; a display path does not confer authority.

## Execution

JavaScript modules may import only relative src/*.js and @mvlos/widget.
Exports: render(input) returns a descriptor; event(input, eventID) returns null or
{type:'note.replace', text, expectedRevision}. Async entrypoints are unsupported.
Every invocation gets a fresh bounded QuickJS WASM VM in a dedicated worker.
No fetch, DOM, cookies, storage, host objects, npm, build hooks or timers.
Promise jobs drain at most 16 times; remaining work fails. All handles are disposed.
Limits: 48 files, 32 KiB/file, 128 KiB/source, 64 KiB/output, 256 nodes,
12 descriptor levels, 8 MiB VM memory, 256 KiB stack, 40 ms VM CPU,
3 s worker watchdog, 8 concurrent workers, 32 starts per second across the tab. Hidden/mobile desktops do not execute.

## Descriptor vocabulary

@mvlos/widget exports column(...children), row(...children), text(value,tone),
button(label,eventID), editor(). Tones: normal, muted, accent. No raw HTML,
URLs, arbitrary attributes, CSS or host functions. Spacing tokens: compact,
normal, roomy in styles/tokens.json (gap and padding).
The parent owns window/menu/theme controls. The editor is native, with immediate
host transactions, selection, IME and native undo; events cannot preventDefault
retroactively. Checklist transformations are package code with stale-result rejection.

## Capabilities and projections

note.read: input.note = {text,revision} for this widget's one bound note.
note.write: a revision-checked replacement of that note only.
weather.read: input.weather = {place,units,summary,hours,days} for the host-selected
place only. Geocoding is a trusted user-operated control, not a package API.
Errors are plain bounded messages, not raw fetch responses or host objects.
Default packages use existing instance authority. Fork activation requires explicit
real-data opt-in. Preview always uses mocks. Revocation/logout cancels pending work.
No navigation, clipboard, exports, logging, arbitrary RPC or model forwarding APIs.
Package grants never authorize forwarding private data to a model.

## Build and activation

Both defaults and forks use the same verifier, digest and loader. The digest covers
all accepted files plus the pinned SDK/QuickJS build identity. Imported dist/ and
build.json are discarded; snapshots are rebuilt and verified. Source saves never
activate. Build and preview first; explicit activation binds the digest and source
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
