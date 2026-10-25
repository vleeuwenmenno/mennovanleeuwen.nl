# mennovanleeuwen.nl

A web desktop anyone can sign in to with GitHub, and my CV as a tiny operating system: a sticky
note, a terminal that actually works, and a dock with apps for projects, contributions, recent
activity, the CV itself and contact details.

The CV lives at **`/cv`** ([`src/os/cvMode.ts`](src/os/cvMode.ts)): there the CV, Projects,
Activity, Contact and Minecraft apps, the portfolio desktop icons, Spotlight's projects and links,
the GitHub activity notifications and the CV commands in the terminal exist, and the server sends
the CV's title and link preview. Everywhere else the site is a plain desktop with a welcome note.
Visitors at `/cv` see my persona (`menno@mvlos`); signed in, you get your own desktop with the CV
apps added. The desktop's user is the signed-in GitHub login (`alice@mvlos`, home `/home/alice`),
or `guest` ([`src/os/identity.ts`](src/os/identity.ts)).

Built with Vite, React and TypeScript. The desktop runs entirely in the browser; a small
Node server (no npm packages but `tldts`, the Public Suffix List) adds live status, GitHub sign-in and synced notes (see below).

## Develop

```sh
pnpm install
pnpm dev          # http://localhost:5173
pnpm typecheck
pnpm build        # static site in dist/
pnpm check:perf   # performance budgets and pixel snapshots (see Performance guardrails)
```

Dev servers reached through `pnpm dev:proxy` in its cookie mode (the Tailscale name) share one
origin, so their browser storage is shared too: the same account id on two scratch `DATA_DIR`s
uses the same `mvlos.u.<id>.` space (src/os/accountSpace.ts). That only matters in development.

## Look and themes

The design follows Omarchy: square windows with a 2px accent border on the active one, a solid
bar, one monospace face, and colours from Omarchy's own theme palettes
([`src/os/omarchyThemes.ts`](src/os/omarchyThemes.ts), generated from
`/usr/share/omarchy/themes/*/colors.toml`). Day is Flexoki Light, night is Tokyo Night, and
"auto" follows the OS. The sun/moon button in the bar toggles; right-click it (or the desktop)
for every Omarchy theme and accent overrides. `theme list` / `theme <name>` in the terminal too.

### Selecting text

Like a desktop, the chrome can't be selected: dragging across title bars, the dock, menus,
sidebars, toolbars, list rows, icons or a game, or double-clicking a label, highlights nothing, a
long press on it gets no text callout and a tap no grey flash. Text that is there to be read and
copied can: fields, the terminal, Zed and every Markdown preview, Agents' messages and tool output,
the mail being read (subject, people, the message), notes and stickies, a contact's card, a
read-only event's place and notes, PDF text, the Viewer, Preview's and Photos' info, Spotlight's
previews, answers and sums, the CV page, inline code and error messages. Ctrl+A selects the text
area you clicked in (or a field's text), never the whole page, and apps that select their own
items with it (Files, Photos, Archive) still do. Pictures and links on the chrome don't drag out
of the page; rows meant to be dragged still do.

Editable fields (inputs, text areas and rich-text editors) disable font ligatures and contextual
alternates so punctuation such as `http://host/path`, `//`, `..` and `...` remains visually
separate. This changes only font rendering: text values, selection and caret positions stay intact.

For developers it is one rule, under *Text selection* at the top of
[`src/styles.css`](src/styles.css): `body` is `user-select: none`, and fields, `code` and anything
with the `selectable` class (or `data-selectable`; `copyable` for an error or notice) opt back in.
Mark the element that holds the content, not each line. Ctrl+A and the picture drags are handled
in [`src/os/selection.ts`](src/os/selection.ts). So is a Firefox quirk: once a text field has had
the focus, a drag in selectable text inside a `user-select: none` page selects nothing, so for the
frame in which a press in selectable text starts a selection the page is selectable (an
`html[data-selecting]` rule), and the rules apply again right after.

## Workspaces and the dock

Like Omarchy, the desktop has workspaces ([`src/os/wm.tsx`](src/os/wm.tsx)): the numbers in the
top bar are workspaces 1 to 9, not windows. Exactly one is on screen; the others' windows are
hidden but keep running (a game keeps its state, a terminal its history). The bar always shows 1
to 5 and any later one with windows; the one on screen is underlined and empty ones are dimmed.
Click a number (or scroll over them) to go there, and right-click one for its windows. New windows
open on the workspace on screen. Sticky notes, the shortcuts note and widgets are part of the
desktop rather than windows, so they show on every workspace.

Super is Omarchy's key, but the system keeps it, so a web page never sees it; the site uses Alt:
**Alt+1…9** goes to a workspace, **Alt+Shift+1…9** moves the focused window there (and goes with
it, like Hyprland's `movetoworkspace`), **Ctrl+Alt+← →** steps through them. These work everywhere,
the terminal included, except that on a Mac a text field keeps Option+digit for typing characters.
**Ctrl+Space** opens Spotlight, and **Ctrl+K** (or Cmd+K) opens All apps — also from anywhere,
including the terminal. Settings → Spotlight can point Ctrl+Space at All apps instead, which gives
Ctrl+K back to Spotlight. Ctrl+Space is best-effort: some OSes and input methods keep that chord,
so the page never sees it, the same way Super never reaches a web page.

The top bar itself ([`src/os/TopBar.tsx`](src/os/TopBar.tsx), [`src/os/topbarPrefs.ts`](src/os/topbarPrefs.ts))
holds the MvL OS menu, workspaces, clock, search, activity, Minecraft status, theme and
notifications. Minecraft status is on by default away from `/cv`, and off on `/cv` (the opposite of
the earlier CV-only rule). Right-click the bar to **Unlock the top bar**, then drag a widget
to reorder it, or use *Show or hide* for each widget; **Lock the top bar** when you are done. A
click that does not move still activates the widget. The
layout is kept in this browser, and follows your account when you are signed in.
A window's menu (right-click its title bar) has *Move to workspace*, and dragging a window onto a
number in the bar moves it there. Each window's workspace is saved with the window layout; which
workspace is on screen is kept per browser. Phones have room for one workspace, so there the
numbers don't show and every window is reachable as if there were just one.

**One workspace per tab** ([`src/os/tabWorkspaces.ts`](src/os/tabWorkspaces.ts), on unless turned
off in Settings → Windows): every open tab of MvL OS in a browser gets a workspace of its own, like
monitors in Hyprland, and its browser tab title says which (`MvL OS · 3`). A tab owns its workspace
by holding a [Web Lock](https://developer.mozilla.org/docs/Web/API/Web_Locks_API) named after it
for as long as it is open; the browser lets go of it when the tab closes or crashes, so the other
tabs always know which workspaces are taken (a BroadcastChannel and a waiting shared request on
each taken lock tell them the moment that changes). The tab's workspace is kept in sessionStorage,
so a reload gets the same one back; a duplicated tab finds it taken and looks for another. A tab
that opens takes, in order: the workspace it had before a reload; the lowest workspace a closed tab
left windows on (*Adopt left-behind workspaces*; on the new tab page, `/?newtab`, only when
*…also as the new tab page* is on, since every Ctrl+T would otherwise take one over); the lowest
empty one; any other free one. When all nine have a tab, it shares them as before. The bar marks
the other tabs' workspaces with a dot; going to one is refused with a notification (a page can't
bring another browser tab forward), and the arrow keys and the scroll wheel step past them. Moving
a window to another tab's workspace sends it to that tab (the window layout is synced between
tabs), and this tab stays where it is. A window asked for that is in another tab (from the dock,
Spotlight, or an app that has one window, like Settings) offers to be brought over instead. This
needs *Last windows*, where the tabs share one window layout, and is off on phones. Other devices
are not involved: locks are per browser.

The dock keeps the pinned apps and launchers, and every open app that isn't pinned gets an item of
its own after them, past a thin divider, like macOS ([`src/os/Shell.tsx`](src/os/Shell.tsx),
`Dock`). So a minimized window can always be brought back, on a phone too, where the dock comes
back with the bar at the bottom. An app's dots show how many windows it has (with a count when
there is more than one), on every workspace. Clicking an app opens it or brings its most recent
window back, switching to that window's workspace; clicking again minimizes it, or with several
windows brings the next one forward. Right-click (or long-press) an app for its windows by title,
with their workspace. Its item goes when its last window closes. Notes and widgets never get one.

## Moving windows with a key

Like Hyprland, a window can be dragged by holding a key and dragging anywhere on it
([`src/os/Window.tsx`](src/os/Window.tsx), `modPressDown`; the choice is in
[`src/os/modDrag.ts`](src/os/modDrag.ts)). **Ctrl+left-drag** moves it, snapping and all, like
dragging its title bar. **Ctrl+right-drag** resizes it from the corner nearest the pointer when you
press: that corner follows the pointer and the opposite one stays put (there is no menu for it).
Settings → Windows picks the key: Ctrl (the default), Alt, or off. A phone has no keys, so it
never does this.

Ctrl+click means something in apps (adding to a selection, opening a link in a new tab), so a press
with the key only starts watching: within 4 px of where it went down, nothing has happened and the
click reaches the app whole. Beyond that the window takes the drag: the app is told the gesture is
off with a `pointercancel` on `window` (which ends a rubber band), it sees no more moves, the
browser's own drags and text selection are held back, and the click after the release is
swallowed. Files and Photos added to a selection with a box on Ctrl+drag over empty space; Shift+drag
does that now. A file or photo dragged with the key held moves the window too (copy with Ctrl+C and
Ctrl+V instead of Ctrl+drag). An app that uses the key with the mouse itself opts out: `ownsModifierDrag` in
its `AppMeta` (`src/os/apps.tsx`, set for Games) or `data-no-mod-drag` on an element (the
terminal's screen, while a program reads the mouse). A drag that starts over an iframe (the PDF
viewer) never reaches the page, so it can't be taken.

## Drag and drop

Things can be dragged wherever they make sense ([`src/os/dnd.ts`](src/os/dnd.ts)): desktop icons
(several at once, as a pile with a count), rows in Files, apps and launchers in All apps, rows
in Archive, and photos in Photos (see Photos below). They land on desktop folders and the desktop itself, Files windows (a folder, the
folder on show, a place in the sidebar, the Trash), the dock, and the windows of apps that show
files: Preview, Player, Omamp, PDF, the Viewer, Archive and Zed show what is dropped on them, and
a sticky note takes a launcher as a link. A message being written in Mail attaches the files dropped
on it (from the computer, Files or the desktop) and takes a launcher as its link in the text, and
the Calendar imports the events of a dropped `.ics` file (shown first, into the calendar you pick) and
Contacts the cards of a dropped `.vcf`, whether they come from the computer, Files or the desktop.
Within one library (or within this browser) files move;
between Seafile's libraries and this browser they copy, and Ctrl or Alt copies, Shift moves.
What a drop would do shows on the cursor (+ copy, → move, ↗ link or pin, ⏎ open, 🗑 delete), and
where it would land is outlined. Holding a drag over a folder for a moment opens it, in Files and
on the desktop, so it can go on further in. Names already there ask first: replace (Seafile keeps
the old one in its trash), keep both (the newcomer gets a number, `notes 2.txt`), or skip
([`src/data/fileDrop.ts`](src/data/fileDrop.ts), [`src/data/transferPlan.ts`](src/data/transferPlan.ts)).
Ctrl+Z on the desktop or in Files puts back what the last drag moved. Files from the computer
upload where they are dropped, and in Chrome a file dragged out of Files to the computer is
saved there. Launchers and apps dropped into a folder become `.desktop` files in it.
The Agents composer takes files from the computer, Files and the desktop as attachments (a
launcher is typed in as its address; a folder is turned away with a note, since there is nothing in
it to read), and the Terminal pastes the paths of files and folders onto the line (below).

For an app that wants drops (attachments, say), the contract is one hook on an element:

```ts
const ref = useRef<HTMLDivElement>(null)
useDropTarget(ref, {
  accept: (drag) => (drag.os || drag.items.some((i) => i.kind === 'file') ? 'copy' : null),
  drop: async (drag) => attach(drag.os ? await drag.files() : drag.items),
})
```

`drag.items` are the MvL OS items (`file` with its path, Seafile's `seafile://…` or a filesystem
path, and a `launcher` when it is a `.desktop` file; `launcher`, `app`, `entries` of an archive,
`icon`), `drag.os` says files from the computer, whose `File`s `drag.files()` gives at the drop,
and `drag.keys` the modifier keys. `accept` answers what a drop would do (`'move'`, `'copy'`,
`'link'`, `'open'`, `'trash'`) or null; elements inside the target can carry `data-drop="…"`,
and the target is then asked about that spot first (the folder under the pointer, say). The
innermost target that takes a drag gets it, its highlight is `[data-drop-over]` in CSS, and the
same target works for the browser's own drags, MvL OS's pointer drags and a finger.

## Editing content

Everything the site says lives in [`src/data/profile.ts`](src/data/profile.ts): headlines on the
sticky note, projects, contributions, skills and experience. The terminal's filesystem
(`~/cv.md`, `~/projects/*/README.md`, ...) is generated from the same file.

Markdown renders the same everywhere it shows (Zed's preview, Notebook, Spotlight and the Agents
app's answers), through one parser of our own in [`src/data/markdown/`](src/data/markdown):
CommonMark's blocks and inlines (emphasis nests in any combination, setext and ATX headings,
nested and loose lists, quotes, fenced and indented code, reference links, escapes and hard
breaks) plus GitHub's tables, task lists, `~~strikethrough~~` and bare URLs. Fenced code is
coloured for about 20 languages (TypeScript/JavaScript, JSON, shells, Python, Go, Rust, C-like
languages, CSS, HTML/XML, YAML, TOML, INI, SQL, diff, Markdown, Dockerfile). Since the Markdown
often comes from a model, raw HTML shows as text, only http(s), mailto and relative links become
links, and pictures load from https or `data:` images only. `pnpm check:markdown` runs the
parser's tests. Footnotes are not supported.

### Emoji shortcodes

`:rofl:`, `:+1:`, `:fire:`, `:flag_jp:` and about 1,900 other Discord, Slack and GitHub names turn
into their emoji ([`src/data/emoji/`](src/data/emoji)). Markdown shows them outside code (agent
replies, notes, previews, the terminal's `agents` view), and unknown names stay as written. In the
Agents message box and the Notebook editor, typing `:` and two letters opens a list of matching
names (arrows, Tab or Enter pick, Escape closes, a tap picks it on touch), and a finished `:name:`
followed by a space or punctuation is replaced at once. Code spans, fenced blocks, URLs and times
like `12:30:45` are never touched. Settings → Language & region turns the typing part off (per
browser); showing shortcodes in text is always on. The names are generated from emojibase's
GitHub and iamcal shortcode lists (MIT; skin-tone variants left out) into `data.ts`, a separate
chunk of about 17 kB gzipped that loads the first time a text or the box needs a name, so the
main bundle only carries the small matching code. `pnpm check:emoji` runs its tests.

### Visual blocks

A fenced block with the language `visual` holds a small JSON spec that draws as a picture in every
Markdown preview (Notebook, Zed, Spotlight, the Agents app's answers, READMEs and comments), so a
model or a note can show a diagram instead of describing one ([`src/data/visual/`](src/data/visual)):

````md
```visual
{"type": "grid", "pattern": ["PP", "PP"], "key": {"P": "icon:oak_planks Oak planks"},
 "via": "Crafting grid", "result": "icon:crafting_table Crafting table"}
```
````

- **Kinds.** `flow` (nodes and arrows with labels, laid out in ranks by our own layered layout in
  `layout.ts`; `direction` down or right, node shapes box, round, diamond and circle, `group` boxes
  nodes together), `grid` (rows × cols of slots, an arrow with `via` on it, the result with counts:
  a Minecraft recipe, cooking or smelting; several in `grids` for a chain; `pattern` and `key` as
  Minecraft writes them), `tree`, `timeline`, `chart` (bar, line or pie), `cards`, `table` and
  `scene` (a free drawing, below). A list of specs in one block draws them one under the other. The whole schema is the
  `VisualSpec` type in [`spec.ts`](src/data/visual/spec.ts).
- **Forgiving.** Small models write it, so comments, trailing commas, single quotes, unquoted keys
  and missing commas are fine, fields have aliases (`edges`/`links`, `from`/`source`), a missing
  `type` is guessed from the fields, edges may be strings (`"a -> b: label"`) and an edge to a name
  that was never listed makes that node. A spec that leaves nothing to draw shows what is wrong and
  in which field (`edges[2].to`), with the block as written under it, never a blank. While an
  answer is still streaming in, an unfinished block shows *Drawing…*. `validateVisual` and
  `parseVisual` are exported for the server side too.
- **Scenes.** `{"type": "scene", "title": "…", "caption": "…", "svg": "<svg viewBox='0 0 400 250'>…</svg>"}`
  is a drawing the model writes itself as SVG, for what boxes and arrows can't show (a machine
  setup, a room, a circuit). The SVG is untrusted, so [`svg.ts`](src/data/visual/svg.ts) reads it
  with its own small XML reader and keeps only an allowlist: the elements `g`, `rect`, `circle`,
  `ellipse`, `line`, `polyline`, `polygon`, `path`, `text`, `tspan`, `defs`, `linearGradient`,
  `radialGradient`, `stop`, `marker`, `pattern`, `clipPath`, `use`, `title`, `desc`, `image` and
  `style`, and only geometry, paint, text, marker, `id`, `class`, `transform` and `style`
  attributes. Scripts, `foreignObject`, animation, links, nested `<svg>`, event handlers and a
  DOCTYPE (its entities are never expanded) go with everything in them; `href` may only point at
  `#id` in the drawing (a `use` not at itself or at another `use`), `url()` only at `#id`, and a
  `<style>` or `style` keeps only rules of allowed properties, without `@import`, escapes or
  outside URLs. A new document is then written from that tree (never the model's text), and shown
  as an `<img>` of a `data:` URL, where no script runs and nothing outside loads even if the
  sanitizer missed something. Colours `accent`, `fg`, `bright`, `muted`, `bg`, `panel`, `border`
  and the theme's hues (`red` … `magenta`), bare or as `var(--accent)`, are the current theme's,
  and the drawing is redrawn when the theme changes; other colours stay as written.
  `<image href="icon:<slug>">` (or an `icons` list with x, y and size) places an icon library
  picture, fetched and put inside the drawing as a `data:` PNG; a missing one is a dashed tile
  with its first letter. Up to 120,000 characters and 3,000 elements; a drawing with nothing safe
  left shows what was left out. It zooms like a flow, with *SVG* and *PNG* buttons that save it
  with the theme's background.
- **Pictures.** Any item can be `"icon:<slug>"` (the account's icon library,
  `/api/agents/icons/<slug>`), an emoji (`"🍞 Bread"`) or `"app:<id>"` (an MvL OS app's icon), with
  `"4x Stick"` for a count. A missing icon falls back to the item's emoji, else its first letter in a
  tinted tile; grids list what each picture is under the slots, since a finger gets no tooltip.
- **Theme, touch and phones.** Colours come from the theme's variables (a scene may also name its own; charts use the accent
  hues in a fixed order). A big flow fits the width (down to half size, then scrolls); Ctrl+wheel and
  pinch zoom it, a mouse drags it, and − ⤢ + buttons zoom and fit. On a phone a flow that runs
  sideways runs down instead. Charts have a hover (or tap) tooltip, a legend for two or more series
  and a *Table* view. *Spec* and *Copy* show and copy the JSON.
- **Elsewhere.** The terminal's `agents` and shared answer links (`/s/<token>`) show a text
  version: `a → b` lines, grids as `[slots] ─ via ─▶ result`, trees with branches, charts as bars,
  a scene as its title, caption and `(drawing: its labels)`.
- **Cost.** The renderer is its own chunk (about 30 KB), loaded the first time a visual block shows;
  it draws once, and zooming only sets two styles. `pnpm check:visual` checks good and bad specs,
  the loose JSON, the text version, the layout, the scene sanitizer against a list of XSS tricks
  (handlers, `javascript:` and encoded links, `foreignObject`, outside `use`, CSS `url()` and
  `@import`, entities, CDATA, nested `<svg>`, animation) and that every example in the Agents
  prompt is valid.

## Data snapshots

`pnpm data` (`scripts/fetch-data.ts`) writes two files the site reads at runtime:

- `public/recents.json`: recent activity. The Activity app and `recent` merge it with the live
  GitHub events API (fetched from the browser, cached in `sessionStorage` for 10 minutes).
  Pepper's activity on git.mvl.sh only arrives this way, because Forgejo sends no CORS headers.
- `public/contributions.json`: a year of daily contributions for the graph in the Activity app
  and `heatmap`. GitHub's count comes from its contribution calendar; git.mvl.sh's is counted
  from the activity feed (commits, repos, releases, PRs, issues) because Forgejo's own heatmap
  also counts mirror syncs of GitHub repos, which would double count.

Refresh both before each deploy (`pnpm build:full` does it), or on a schedule in CI. Set
`GITHUB_TOKEN` there to avoid the anonymous API rate limit.

Live from the browser: GitHub events and stars, DNS lookups (Cloudflare DNS-over-HTTPS) and the
Minecraft server status for cloud.mvl.sh (mcstatus.io).

## Terminal

Commands live in [`src/terminal/commands.ts`](src/terminal/commands.ts). The filesystem is
read-only and in memory; only `/tmp` accepts writes (`echo hi > /tmp/x`), and those vanish on
reload. Pipes, `;`, `&&`, `$VARS`, tab completion and history all work. `ps` and `kill` operate
on the open windows. `open <name>` starts an app (`photos`, `mail`, `contacts`, `tasks`, `calendar`,
`files`, `agents`… and `open` alone lists them); a word with a slash or a dot, or the name of a file
or folder right there, is a path and opens that instead. `photos`, `mail`, `contacts` and `tasks`
are commands of their own too. `ls` takes several paths, like GNU ls: files first, then each folder
under a `name:` heading.

Files and folders dragged onto the terminal paste their paths, quoted for msh and separated by
spaces, onto the line, like real terminals do (Seafile's as `ls` shows them, through the mounts in
`/etc/fstab`). Files from the computer have no path, so the terminal asks to upload them into the
working folder (Seafile or this browser's) first, then pastes the new paths. With a full-screen
program attached (`ctx.attachStream`), the paths go to the program as a bracketed paste instead.
The quoting is in [`src/terminal/words.ts`](src/terminal/words.ts); `pnpm check:terminal-cmds`
tests it and the commands above.

Real tools live in [`src/terminal/extra.ts`](src/terminal/extra.ts) and run from the visitor's
browser: `curl`/`wget` (any site that allows cross-origin requests, e.g. `curl wttr.in/Amsterdam`,
never the visitor's own network), `whois` (RDAP), `git log`/`git show` on the real repos,
`htop`, `watch`, `cmatrix`, `df`/`free`/`nproc`/`lscpu`/`xrandr`/`ip` with the numbers the browser
shares, `jq`, `sha*sum`/`md5sum`, `figlet` and `lolcat`. With Seafile linked, `df` also lists its
mounts: the account's quota and usage (`/api/seafile/quota`), and each library's own size next to
what is left of the quota; `du` (`-a`, `-s`, `-c`, `-d`, `-h`, `-x`) adds up folders through the
mounts, Seafile's included.

`cmatrix` ([`src/terminal/cmatrix.ts`](src/terminal/cmatrix.ts)) is the film's rain: mirrored
half-width katakana with digits and a few symbols, a glowing head, a trail that fades through a
dozen shades into the background, characters that flicker while they fade, drops at their own
speeds. The flags follow the real one: `-a` the old ASCII look, `-C <color>` (green, red, blue,
cyan, magenta, yellow, white), `-r` rainbow, `-u 0-9` speed, `-s` screensaver (any key quits),
`-h` help; while it runs, `0`–`9` change the speed, `p` or space pauses, `!@#$%^&` change the
colour, and `q` or Esc quits. It paints a canvas through `ctx.paint` (a full-window area on the
alternate screen) rather than text: a frame redraws only the cells whose character or shade
changed, copied from a sheet of glyphs drawn once, with the heads and their glow on a second
canvas, so it keeps up with 144 and 240 Hz screens. The rain runs on time, not frames, so the
speed is the same at any refresh rate.

`/dev` behaves like one ([`src/terminal/devices.ts`](src/terminal/devices.ts)): `/dev/urandom` and
`/dev/random` give random bytes, `/dev/zero` NULs, `/dev/null` nothing (and swallows writes). The
real ones never end; here a read gives 64 KiB at most, so `cat /dev/urandom` stops. The disks
(`/dev/nvme0n1*`, `/dev/seafile/*`) answer `Permission denied` to reads and writes, as for a normal
user, and `ls -l /dev` shows `crw-rw-rw-` and `brw-rw----` with the major and minor numbers `lsblk`
uses. `open /dev/seafile/<library>` opens that library in Files. Bytes travel through pipes as
text with the invalid ones kept apart (Python's `surrogateescape`, [`src/terminal/bytes.ts`](src/terminal/bytes.ts)),
so `head -c 16 /dev/urandom | xxd` shows 16 bytes and `echo é | xxd` shows `c3a9 0a`. `head`/`tail`
take `-c` (GNU forms: `-c N`, `-cN`, `--bytes=N`, `-c -N`, `tail -c +N`) and several files, and
`xxd` (`-l -s -c -g -p -u -r`), `hexdump -C` and `od -An -tx1` dump bytes
([`src/terminal/bytecmds.ts`](src/terminal/bytecmds.ts)). `pnpm check:terminal-cmds` tests all of it.

`find` and `fd` ([`src/terminal/find.ts`](src/terminal/find.ts)(src/terminal/find.ts)) follow GNU findutils 4.10 and fd 10.2
over the site's filesystem: find's whole expression language (tests, `-printf`, `-ls`, `-exec … ;`
and `{} +`, `-ok`, `-prune`, `-delete` in /tmp, operators and its warnings and errors), fd's options
(smart case, globs, `-e`, `-t`, `-S`, `--changed-within`, `-x`/`-X`, `--format`, `-l`, ignore files),
and both tools' `--help`, `--version` and `man` pages. Tab completes their options.

`go <alias>` follows a link through the visitor's own [golinks](https://git.mvl.sh/vleeuwenmenno/golinks)
account (by default on https://mvl.sh). `go set <search url>` saves the account once: the
`…/r/%s?token=…` URL golinks shows after creating a token (a redirect URL for any alias, a site plus
a token, or a bare mvl.sh token work too). It is kept in localStorage, and synced like notes when
signed in ([`src/data/golinks.ts`](src/data/golinks.ts)). `go` alone shows the account, `go unset`
forgets it. Tab after `go ` opens a picker of your aliases under the prompt, like fzf, and Tab on
any other word with more than one match opens the same picker for commands, files and folders. It
narrows as you type; Tab and ↓ (Shift+Tab and ↑, Ctrl+N/P) cycle, → puts the pick on the line,
Enter does too (and follows a go link), Esc closes it.
Spotlight takes `go <alias>` too, and lists matching aliases as you type (the most used
ones after a bare `go `) from the golinks server's `/suggest`, asked straight from the browser so
the token never passes through this site's server.

### Tabs and selecting

A Terminal window has tabs, like Ghostty's or Windows Terminal's
([`src/apps/Terminal.tsx`](src/apps/Terminal.tsx), `TerminalTabs`). Each tab is its own shell
(`TerminalSession`): its own working folder, history position, environment, scrollback and
running program, and the tabs not in front keep running (a `watch` or `vtdemo` goes on drawing,
at its own size). The strip shows from the second tab on (or always, in the settings); each tab
is titled after what a program in it called itself, else what runs, else its folder, and the
window's title follows the front tab. Keys, ahead of the shell and of full-screen programs:

- Ctrl+Shift+T new tab (in the front tab's folder), Ctrl+Shift+W close it.
- Ctrl+Tab / Ctrl+Shift+Tab and Ctrl+PageDown / Ctrl+PageUp next and previous, Ctrl+Shift+1…9
  that tab (9 the last). Alt+1…9 stays with the workspaces. Browsers keep some of these for their
  own tabs (Chrome never hands a page Ctrl+Tab, Ctrl+PageUp/Down or Ctrl+Shift+T/W); there the
  strip, the menus and Ctrl+Shift+1…9 still work.
- The mouse: + or a double-click on the empty strip opens one, a middle click closes one, a drag
  moves one along the strip. The window menu and the right-click menu have *New tab* too.

`exit` closes its tab only; the last tab's closes the window. Closing a tab in which a program
runs asks first, and closing a window with more than one tab asks once ("Close 3 tabs?"), both
in the desktop's own dialog. The tabs, their folders and which one was in front are kept in the
window's props (`tabs`, `tab`), so a reload brings them back; what ran in them does not. A
request from another app (*Open in terminal*) runs in the front tab.

Selecting the scrollback (or a full-screen program's screen) leaves the selection in place until
you click elsewhere or type; a plain click puts the caret on the prompt. Ctrl+Shift+C copies it
(so does Ctrl+C with text selected, or the right-click menu), Ctrl+Shift+V pastes.

### Terminal settings

The Terminal has its own settings sheet ([`src/terminal/TerminalSettings.tsx`](src/terminal/TerminalSettings.tsx)),
opened from its window menu (Terminal settings…), its right-click menu, or `settings` at the prompt
(`settings system` opens the Settings app instead). The same settings, less the per-tab zoom,
are in Settings → Apps → Terminal, and the sheet's *Open in Settings…* goes there. They are kept in
this browser and synced like notes when signed in ([`src/terminal/prefs.ts`](src/terminal/prefs.ts)):
- **Text size**, separately for desktops and for phones (below the 720 px breakpoint, where
  windows fill the screen). Changes apply live. The single size saved before carries over to both.
- **Zoom** for one tab only, until it closes: Ctrl + / − / 0, Ctrl with the scroll wheel, or a
  two-finger pinch on a touch screen, with a badge showing the new size. It multiplies the text
  size. Full-screen programs (nano, htop, `agents`) redraw to the new rows and columns, which
  `stty size` prints.
- **Extra keys** on touch screens ([`src/terminal/ExtraKeys.tsx`](src/terminal/ExtraKeys.tsx)),
  like Termux's: Esc, Tab, Ctrl, Alt, Shift, arrows, Home, End and `~ | / -` above the keyboard
  while the prompt has it. Ctrl, Alt and Shift apply to the next key when tapped, lock when
  tapped twice, and apply while held; they also apply to letters typed on the keyboard (Ctrl, then
  c, is Ctrl+C). The keys go through the same handler as a real keyboard, so completion, history
  and full-screen programs get them as usual. The row can be turned off.
- **Tab bar**: from the second tab on (the default, like Ghostty), or always.
- **Startup file**: run `~/.mvshrc` when a terminal opens (on by default; see below).

### The shell, agents and skills

The shell is msh 2.0 ([`src/terminal/msh/`](src/terminal/msh)): a POSIX-ish parser and
interpreter. It supports if/for/while/until/case, functions, subshells, `$(…)`, `$((…))`, the
`${…}` forms, globbing, heredocs, redirects (`2>`, `2>&1`, `<`), `set -e/-x/-u/-o pipefail` and
builtins like `test`/`[`, `printf`, `read`, `source`, `eval` and `getopts`. `msh -c`, `msh file`
and `./script.sh` with a `#!/bin/msh` (or sh/bash) shebang run scripts. `man msh` shows the
reference ([`src/data/mshReference.ts`](src/data/mshReference.ts)), which the agents read as the
built-in `msh` skill.

**Aliases and `~/.mvshrc`.** `alias ll='ls -l'` gives a command another name; `alias` lists them,
`alias ll` shows one, `unalias ll` (or `unalias -a`) removes them. An alias replaces the first word
of a simple command, also after `;`, `&&`, `||` and `|`, in `if` conditions, functions and
subshells; not when the word is quoted or escaped, and not in scripts (`msh file`, `msh -c`), as in
bash. A value that is a pipeline or a list works too (the rest of the words are appended to it).
Each name expands at most once per command, so `alias ls='ls -l'` and two aliases naming each
other end instead of looping (the second one then reports "command not found"). Aliases belong to
one terminal tab (kept per environment in [`msh/interp.ts`](src/terminal/msh/interp.ts), next to
the functions); `type`, `command -v` and `which` say "aliased to", `help` lists `alias`/`unalias`,
and Tab offers alias names for the first word.

`~/.mvshrc` is run once when a terminal opens, in the tab's own shell, so aliases, `export`ed
variables, `cd` and functions it sets stay ([`src/terminal/startup.ts`](src/terminal/startup.ts),
`runRc` in the interpreter). It runs statement by statement: comments and blank lines are skipped,
a multi-line `if`/heredoc counts as one statement, a failing line prints `~/.mvshrc, line N:` and
its error and the rest still runs. It is silent otherwise, stops after 5 s, is skipped when the
account or files do not answer within 4 s, and the first command typed waits for it. A file that
sources itself (`source`, `.` or `msh ~/.mvshrc`) is refused with "already running, skipped".
There is no file until you make one (`nano ~/.mvshrc`, `echo "alias ll='ls -l'" >> ~/.mvshrc`);
`help` and the Terminal settings mention it. Where it lives follows home: in the browser's files
or Seafile once signed in (a normal file there, so Zed, Files and the terminal all edit it); signed
out, where home is read-only, `~/.mvshrc` is still a file the terminal can create, read and remove
(`nano`, `>`, `>>`, `rm`), but its text is kept in this browser
([`src/terminal/rcfile.ts`](src/terminal/rcfile.ts), a `synced()` value, so local without an
account). On the CV page home stays read-only and has none. The agents' `terminal` tool does not
run it. `pnpm check:msh-rc` tests all of this.

`agents` ([`src/terminal/agents/`](src/terminal/agents)) is the Agents app as a coding-agent CLI.
In a folder on Seafile, that folder becomes the thread's work folder:
- File tools ([`server/workdir.ts`](server/workdir.ts)) let the agent read, write, edit, list,
  glob, grep, move and delete inside the folder, and it follows the folder's `AGENTS.md` or
  `CLAUDE.md`.
- A `terminal` tool runs msh command lines in the user's own terminal.
- Changes wait for approval, which can carry a note for the agent. Shift+Tab cycles between
  asking first, accepting edits, and plan mode (read only until a plan is approved).
- `/threads <words>` searches earlier conversations across projects, including marked archives.
  Results show the title, project, date, first excerpt and thread id as plain text fitted to the
  terminal width. `/threads open <id>` resumes one; a unique id prefix from the last results also
  works. `/threads this <words>` searches the current thread, while `/threads this` repeats the
  last query there. These are deliberate user searches, independent of the model's tool groups;
  the same ownership, Spotlight exclusion and bounded search rules apply.
- Generated PNGs get an inline preview below their unchanged private URL, size/seed and metadata
  link. The interactive terminal samples two vertical pixels per `▀` cell using foreground and
  background RGB colours, at most 48 columns and 24 rows, shrinking tall pictures to fit.
  Terminals without truecolour use coarse grayscale density blocks. `/images art off` hides
  future previews; `/images art on` restores them. This CLI preference starts on and is kept for
  the account in this browser. Print mode, pipes, `TERM=dumb`, terminals below 24 columns,
  downloads over 3 MiB and invalid or oversized PNG dimensions skip art. Fetches use only the
  signed-in account's private image route, with a five-second deadline; a failed preview leaves
  the links and settings available. Resumed threads use the same preview rules.
- Prompt modes: `!cmd` runs a command, `# text` remembers something, `@./path` attaches a file. `#name[:weight]`, `$name` and `@name` mention a LoRA, skill and tool.
- While the agent works, Enter queues a message (shown over the prompt; the server sends it when
  the turn is done). ↑ in an empty prompt edits the last queued one, Ctrl+X removes it (or the last
  one), Ctrl+Enter sends it, or the next one, now (stopping the agent). While it asks for an
  approval or a form, just typing tells it what to do instead: Enter declines every waiting change
  with that message, or answers the form with it.
- A dropped stream reconnects by itself (for a minute) and an interrupted turn says so; Ctrl+R or
  `/retry` runs the last message again, and `/rewind` picks one of your messages to go back to.
  `/branch [message id]` continues in a new thread up to that message, or the last message when omitted; the original stays unchanged.
- `/share` shares the thread as a link and `/share last` its last answer, never expiring unless
  given `1h`, `1d`, `7d` or `30d` (`/share last 7d`); `/shares` lists the thread's links and
  `/unshare <id>` (or `/unshare` and a pick) stops one. See *Shared links* under Agents below.
- `/title` shows the thread's title, who named it and the titles it had before (`/status` shows
  those too), `/title regen` asks the title model for a fresh one, and `/rename` sets your own,
  which is then kept as it is. See *Titles keep up to date* under Agents below.
- `/compact` summarises the thread so far to free up the model's context window, and `/compact
  keep the API details` says what the summary should keep; while the agent works it waits in the
  queue. A rule across the screen marks the spot, `/summary` shows what was kept, and `/context`
  and `/status` say when it was compacted and at what point it does so by itself. See
  *Compaction* under Agents below.
- `agents -c`/`-r` resume a thread, `agents -p` answers once for pipes, and `/help` lists the
  slash commands.

`skills` ([`src/terminal/skills.ts`](src/terminal/skills.ts),
[`server/skills.ts`](server/skills.ts)) manages SKILL.md folders. They live in
`~/.agents/skills`, or a work folder's `.agents/skills` or `.claude/skills`, plus the built-in `msh`,
`skill-creator` and [`caveman-adhd`](https://github.com/vleeuwenmenno/caveman-adhd) (terse, ADHD-shaped answers on
request). `skills add owner/repo` installs from GitHub, and `/name` starts one. The
Agents app has the same work folders, permission modes, diff approvals and skills (Settings →
Agents → Skills).

**Always-on skills and rules** ([`src/data/agentSkillRules.ts`](src/data/agentSkillRules.ts),
[`server/agentSkills.ts`](server/agentSkills.ts), [`src/apps/AgentsSkillRules.tsx`](src/apps/AgentsSkillRules.tsx))
make a skill part of every conversation instead of something the agent reads when a task calls for
it, for example `caveman-adhd` for terse answers all the time. Set up in Settings → Agents → Skills:

- **Always on**, a switch on each enabled skill. The skill's whole SKILL.md goes into the system
  prompt, between `<active_skill name="…">` tags, with an instruction to follow it in every reply.
  This also works when the thread's Skills tool group is off.
- **Applies to**: Agents threads (on by default), Spotlight quick answers and the terminal's
  `agents` command.
- **Per project**: turn a skill on or off for the threads in one project, whatever the global
  setting is. The project's sidebar menu has *Always-on skills…*.
- **Rules**: *When* [every thread · in project X · mode is Quick/Deep · permission is Ask
  first/Auto/Edits allowed/Plan/Bypass · in quick answers/the terminal] *→* turn on skill Z, or add
  an instruction text (in `<user_instruction>` tags). A stored rule can have several conditions,
  and all of them must match. Rules are checked again on every message, so a thread switched to
  Plan picks up a Plan rule from its next message on. Rules are only data: there are no scripts and
  nothing runs.

The order is: always-on skills (where they apply), then the project's additions and removals, then
matching rules. A skill switched off in the list is never injected. Everything together is capped
at 24 KB per prompt. Skills that don't fit are left out (the prompt names them), and Settings warns
when the always-on skills add up to more than that. The context breakdown shows the always-on part
as its own row.

In a thread, the active ones show as chips above the message box. Tapping a chip turns that skill
or instruction off for this thread only, and tapping it again turns it back on. This is stored with
the thread (column `skills_off`), so it survives a reload, and a new thread can be set before its
first message. Saying "stop caveman" still works through the skill's own rules.

The config is saved with the account (state key `agentskills`) through
`PUT /api/agents/skill-config`, which refuses anything invalid with a 400. Limits: 20 always-on
skills, 20 rules, 2,000 characters per instruction, and conditions only from the fixed set above.
When the config is read, invalid entries are dropped. `pnpm check:agents-skill-hooks` covers all of
this.

**How complete it is (2026-10-11).** Everything above works end to end against a scripted
stand-in for Ollama and a mock Seafile. It has not yet run against real models, so the tool
descriptions and system prompt are untuned. Known limits:

- **Context.** A summary is only as good as the model that writes it: details it leaves out are
  gone for the agent (not for you: every message stays in the thread). The threshold works from an
  estimate (about 4 characters a token), and a model whose window size Ollama does not report is
  only compacted when it refuses a request as too long. A turn that is one huge message cannot be
  compacted at all.
- **Not in the TUI yet:**
  - Claude Code's undo/rewind, custom slash commands, hooks, MCP servers, subagents,
    background tasks and usage display
  - image paste (`@./path` attaches text files only)
- **Tried in the browser:** messages, approvals, forms, plan mode, `!`, `#`, `@`, `/status`,
  `/context`, `/model`, `/resume`, `-c`, `-p`, `ls`. **Not tried:** Esc interrupting a turn,
  messages queued while it works, `/export`, `/copy`, `/open`, `/delete`, `/archive`,
  `/projects`, `/tools`, Ctrl+O and Ctrl+L.
- **Rendering.**
  - The live block is rebuilt whole on each streamed chunk (the terminal then only redraws the
    lines that changed), and a long reply only shows its tail until it is done.
  - Markdown has no syntax highlighting. The terminal's markup nests now (bold in colour), but
    the TUI's text helpers still write it flat.
  - On phones, typing works, but Shift+Enter and Shift+Tab are hard to reach.
- **Work folders.**
  - Seafile only: not the browser's own files or `/tmp`.
  - `glob`/`grep` walk at most 5,000 files and read at most 400 (up to 1 MB each), so they are
    slow on big trees.
  - Edits do not check whether the file changed since the agent read it.
  - Files over 2 MB, and binary files, cannot be read.
- **Terminal tool.**
  - It needs an attached `agents` session, so turns started in the app do not get it.
  - Each command gets 60 s and returns at most 60k characters of output.
  - Interactive programs are refused, and prompts (rm's y/N) are answered no.
  - "Don't ask again" for a command lasts until the server restarts.
  - Read-only detection is a fixed allowlist; any `$(…)` asks.
- **A turn keeps running after `agents` closes.** Its terminal tool calls then fail until
  `agents -c` reattaches.
- **Skills.**
  - Install only from public GitHub repositories, and the app has no zip upload yet.
  - `allowed-tools` in the front matter is ignored.
  - Python/Node scripts cannot run (msh scripts can).
  - Your own skills need home on Seafile.
- **msh.**
  - No arrays, `[[ ]]`, C-style `for`, process substitution, job control (`&` runs in the
    foreground), aliases or traps.
  - There is no separate stderr stream: `2>` redirects or drops error messages.
  - Exec bits don't exist; the shebang decides whether a file runs.
  - The prompt is one line (multi-line input only in scripts).

`pepper` ([`src/terminal/pepper.ts`](src/terminal/pepper.ts)) simulates the Pepper CLI against a
pretend lab cluster (3 masters, 4 minions). Its grammar, outcome names and output layout follow
the real CLI; the cluster, states and timings are invented, and applies only last for the session.

Pressing P during the boot log lets the boot finish but stops short of the desktop, logging in
on a text console on "tty1" instead (the same shell, without a window manager); `exit` starts the
desktop. `/?newtab` is for using the site as a browser home or new tab page: it skips the boot log, closes
the terminals the last tab left open, and starts with one fresh terminal in front of the rest of the
saved desk. There, links (Spotlight, launchers, `open github.com`, `go`) replace the page like an
address bar would; elsewhere they open in a new tab. Settings → Links changes both. `reboot` and `shutdown` play the systemd
shutdown log ([`src/os/Power.tsx`](src/os/Power.tsx)); a reboot starts from the opening layout again.

### Streams and the VT emulator

A Terminal window can hand itself to a byte stream: a program somewhere else (SSH, next) whose
output is read by an xterm-compatible emulator ([`src/terminal/vt/screen.ts`](src/terminal/vt/screen.ts))
and drawn by [`VtView`](src/terminal/vt/VtView.tsx), while every key goes to it. It covers what
full-screen programs use: cursor movement, save and restore; erasing in the line and the display;
inserting and deleting lines and characters; scroll regions and origin mode; the alternate
screen; line wrap with xterm's pending wrap; tab stops and DEC line drawing; 16, 256 and
truecolour foreground and background; bold, dim, italic, underline, inverse, strikethrough and
overline; OSC 0/2 titles (the window's title follows) and OSC 8 links; bracketed paste,
application cursor and keypad keys, mouse reporting (X10, normal, button and any-event tracking,
SGR), focus events, cursor visibility and shape, synchronized output; the replies to device
attribute, status, cursor position, mode and size requests; and resizing to the window's real
columns and rows (lines are cut, not reflowed). Rows only redraw when they changed.

Keys are sent as xterm sends them ([`src/terminal/vt/keys.ts`](src/terminal/vt/keys.ts)): Ctrl and
Alt combinations, F1–F12, Home/End/PageUp/PageDown/Insert/Delete with modifiers, Shift+Tab, the
keypad in application mode, and the extra keys row on touch screens. Ctrl+C with text selected
and Ctrl+Shift+C copy, and Ctrl+V and Ctrl+Shift+V paste, instead. The left and middle buttons
and the wheel are reported when the program asks; Shift keeps the mouse for selecting text, the
right button keeps the menu, and on the alternate screen without mouse tracking the wheel sends
arrow keys (less, man). Ctrl with the wheel and Ctrl + / − / 0 still zoom, and the screen redraws
to the new size. When the stream ends, what it left on the normal screen stays in the scrollback,
in colour, and msh's prompt comes back.

A command gets the stream API as `ctx.attachStream()` (only in a terminal window, not in pipes),
which returns a port ([`src/terminal/vt/session.ts`](src/terminal/vt/session.ts)):

```ts
const port = ctx.attachStream()
port.write(bytes)                      // program output: Uint8Array (UTF-8) or string
port.onData((keys) => send(keys))      // keys, pastes, mouse and the emulator's replies, as text
port.onResize(({ cols, rows }) => …)   // the window changed size; port.size is the size now
await port.detached                    // settles when either side ends it
port.detach()                          // hands the window back to msh
```

Stop command in the right-click menu, closing the window, or the command returning also detach
it. A program can pin the size it wants with `CSI 8 ; rows ; cols t`, as xterm allows.

`vtdemo` (hidden, [`src/terminal/vt/demo.ts`](src/terminal/vt/demo.ts)) tries it without SSH:
`vtdemo play nvim` (or `less`, `top`, `nano`, `tmux`) replays a recorded session at its own pace
and pauses at each checkpoint (Space goes on, q quits), `vtdemo colors` shows every colour and
look, and `vtdemo keys` echoes what each key, paste, click and focus change sends (Ctrl+D quits).

`pnpm check:terminal-vt` ([`scripts/terminal-vt.ts`](scripts/terminal-vt.ts)) replays the recordings
headlessly and compares, at every checkpoint, the screen's text, colours and looks, the cursor,
the modes and the scroll region with what tmux showed at that moment; it also runs synthetic
sequences for each feature, the key, mouse and paste encodings, and the markup below.
[`scripts/terminal-vt-record.ts`](scripts/terminal-vt-record.ts) makes the recordings (in
[`src/terminal/vt/fixtures`](src/terminal/vt/fixtures)): it runs Neovim, less, top, nano and tmux
in a tmux pane of 80×24, catches every byte with pipe-pane, and asks tmux for its screen at each
checkpoint. One known difference is kept on purpose: erasing to the end of the line while the
cursor waits to wrap clears the last column, as in xterm (tmux leaves it).

**Why our own emulator and not xterm.js.** xterm.js is a full terminal with its own renderer,
input textarea, selection, scrollback and theme, in a canvas or WebGL. Everything msh does is DOM
in the same window: the prompt with its fzf-style picker, links, `sl`, figlet, the agents TUI,
the themes, text size and per-window zoom, and the extra keys. Using xterm.js would have meant
either a second renderer that only shows up for streams, with all of that bridged into it, or
rewriting msh as a byte stream. The emulator is about 1,200 lines (1,700 with keys, the port and
the renderer) without dependencies. It draws with the same font, colours (the 16 ANSI colours
follow the theme as `--ansi-0` … `--ansi-15`), zoom and selection as the rest of the terminal,
and runs in plain node for the check script.

**Markup.** Command output uses the terminal's markup ([`src/terminal/markup.ts`](src/terminal/markup.ts)):
`{c:green}…{/}` for a colour or a look (bold, dim, italic, underline, strike, inverse),
`{fg:#rrggbb}` and `{bg:#rrggbb}` (or `{fg:1}` for an ANSI colour of the theme), `{link:https://…}`
and `{anim:sl}`. Tags nest, so `{c:bold}{fg:#ff0000}bold red{/}{/}` works; a tag that is not valid
shows as text. `curl` of a page with ANSI colours (wttr.in) keeps backgrounds, bold, italic,
underline and inverse ([`src/terminal/ansi.ts`](src/terminal/ansi.ts)).

**Not done yet.** Reflowing wrapped lines on resize; double-width and double-height lines (DECDHL);
sixel and other images; the kitty keyboard protocol; OSC 52 (clipboard) and OSC 4 (palette) are
ignored; right-to-left text and grapheme clusters beyond combining marks (emoji ZWJ sequences
take more than two cells). Not tried on a real phone yet, only in the browser's phone emulation:
Android keyboards that send Backspace without a key event may not reach the program.

## Notes, launchers and sign-in (home page mode)

On phones, Notebook opens to a full-height searchable note list. Tap a note (or **+ New**) to
open its editor in a separate view; **← Notes** returns to the list without losing edits or search.
Trash uses the same list/detail navigation. Links from stickies open the requested note directly.
Desktop windows retain the side-by-side list and editor.

A note opens in **Preview** by default; a brand-new note (**+ New**) opens in **Edit**, since there
is nothing to preview yet. **Settings → Apps → Notebook** (also *Notebook settings…* in the
window's menu) sets *Open notes in*: Preview, Edit or Last used (the view you picked by hand most
recently). It follows the account ([`src/data/notebookPrefs.ts`](src/data/notebookPrefs.ts)). The
Edit/Preview switch in a note still works as before, and double-clicking a preview opens Edit.
Sticky notes on the desktop have their own editor and are not affected.

Anyone can write notes and add launchers: **Notebook** (dock) lists every note in Markdown, and
each one can sit on the desktop as a sticky (right-click the desktop → *New sticky note*). Stickies
get a random tilt and colour, both changeable from the sticky's hover bar or menu. **Settings**
(system menu, [`src/apps/Settings.tsx`](src/apps/Settings.tsx)) is laid out like macOS System
Settings: the account on top of a sidebar, then one pane each for appearance (mode, Omarchy themes,
accent), the dock, launchers, Spotlight, windows, links, notifications, go links, code hosts and
integrations; then, under an **Apps** heading, one pane per app with settings of its own, with the
app's dock icon ([`src/apps/AppSettings.tsx`](src/apps/AppSettings.tsx)); then sync, users and about.
Every account is linked in **Integrations**, one row each with a green dot and a line about what is
linked: calendars (Google Calendar and CalDAV, for Calendar and Tasks), contacts (CardDAV), Mail,
Immich, Seafile, OnlyOffice, Ollama Cloud and updown.io. The Apps panes keep only what is about the
app, and where an app needs an account they start with a small notice and a button that opens that
integration (*Accounts for Calendar are linked in Integrations*, or *Link a calendar account to get
started* when there is none). The Apps panes are Agents, Calendar (which calendars show, which are hidden everywhere, the view it
opens in and where new events go), Contacts (where new contacts go), Files (view, icon size, sort order, hidden files, sidebar, preview pane), Games (Pool's helpers,
sensitivity, computer and sound; Gladiator's sound and music; Empires At War's sound, battlefield,
camera and a summary of its key bindings, with a button into the game's Settings on the Keybinds
tab and another for the sound mix), Mail (when mail counts as read, remote content, the allowed senders, quoted text, signatures and replies, with a pointer to Notifications for new-mail alerts), Omamp (shuffle, repeat, equalizer and preset, visualizer, time, its windows), PDF (sidebar,
night mode), Preview (sidebar), Terminal and Weather (Celsius or Fahrenheit). Each pane reads and writes the very store the app uses
([`src/data/appPrefs.ts`](src/data/appPrefs.ts), [`src/apps/games/prefs.ts`](src/apps/games/prefs.ts),
through [`src/os/localPref.ts`](src/os/localPref.ts) for what stays in this browser), so an open
window follows a change at once and the other way round. Every field for a secret that belongs to another
service (API tokens, app passwords, a library's password) is a
[`SecretInput`](src/os/SecretInput.tsx): a text input masked with CSS and marked for password
managers to leave alone, with a show/hide button, because browsers fill a saved password into any
`type="password"` field and ignore `autocomplete="off"` there. Those apps' window menus have *… settings…*
to jump to their pane.
Settings → Spotlight chooses what **Ctrl+Space** toggles (Spotlight, the default, or All apps). All apps gives Ctrl+K (or Cmd+K) back to Spotlight. It also picks what the empty Spotlight shows (favourites, recently visited websites,
status, apps, your repositories) and how many recent items of each, which kinds of results it searches (your
contacts among them, and your mail after `mail:`; see *How the apps work together*), whether Enter on an unmatched query searches the
web or runs it in a terminal, the preview pane, and the web search engine. Recently visited websites
are the pages opened from MvL OS itself (Spotlight, launchers, `open`, `go`, links in apps), since a page
can't read the browser's history ([`src/data/siteHistory.ts`](src/data/siteHistory.ts)); go links are
kept by alias, never with their token, and the history can be switched off or cleared there.
Ctrl+K in Spotlight (or right-clicking a result, the menu key, Shift+F10) opens an actions panel
for the highlighted result, listing everything it can do with the keys for each. *Add to
favourites* there (or Ctrl+D) keeps it at the top of the empty box
([`src/data/spotlightFavourites.ts`](src/data/spotlightFavourites.ts)); Settings → Spotlight reorders
them. The terminal's `visited` lists the same history (`visited <text>`, `visited open <#>`,
`visited forget <#>`, `visited clear`).
Launchers are a URL, a name and an optional emoji (otherwise the site's own favicon). Notes, launchers, desktop icons, the dock order, the top bar and the open windows are kept per browser
in localStorage ([`src/os/synced.ts`](src/os/synced.ts)), with one window layout for phones and one
for bigger screens.
That state never crosses accounts, even with several tabs open while one of them signs out or in
as someone else (tabs share the browser's storage and its sign-in cookie)
([`src/os/accountSpace.ts`](src/os/accountSpace.ts)):

- **Which account.** Next to the sign-in cookie the server sets a readable one, `mvlos_uid` (the
  account's id), and clears it on signing out or when the session is no longer valid. A page knows
  at once, before `/api/me` answers, which account the browser is signed in as, and each tab takes
  that as its account when it loads.
- **A space per account.** Everything that belongs to an account is kept under its own prefix in
  localStorage, `mvlos.u.<id>.…` (a visitor's under `mvlos.visitor.…`): the synced state, terminal
  and agent history, the notification history, Agents' drafts and layout, Files' settings and
  places, push, the git app's last repository and drafts, what game windows keep (Empires'
  campaign and battle), Empires' multiplayer player, and high scores and Gladiator careers (synced:
  a visitor's are this browser's, a signed-in player's follow the account). A page only reads its
  own account's space, so nothing of another account shows, even from a cache. Responses behind
  a session (agent attachments, photos' originals, mail attachments, contact photos, mail icons,
  Files thumbnails, link previews) are `private, no-store`, so the browser never replays one after
  the account switches or the cookie goes; photo thumbnails are `private, no-cache` with an ETag, so
  every reuse is checked by the server first. Copies stored by older releases (`private, max-age`
  up to 7 days) are purged once per browser: the first app page or `/api/me` answer without the
  `mvlos_cache_purge` marker cookie (HttpOnly, SameSite=Lax, Secure on HTTPS, 400 days) carries
  `Clear-Site-Data: "cache"` and sets it ([`server/http.ts`](server/http.ts), `cachePurge`; bump
  `CACHE_PURGE_EPOCH` to repeat it). Only `"cache"`: the other directives would sign people out or
  wipe their local data and service worker. `/api/me` repeats it because a service worker may serve
  the page itself. With cookies blocked the purge just repeats on each load, which is harmless.
  `pnpm check:sync-accounts` covers it. What belongs to the
  browser stays in plain keys: the theme, motion, sounds, the dock's look, the workspace on screen,
  window-drag keys, the photo viewer's panel, the media player's volume, the browser's own location
  for Weather, and games' settings.
- **The guard.** Before writing to its space and before every request to the site's API, a page
  checks the cookie still names its account; if not, it writes and sends nothing more and reloads
  at once, as the account the browser has now. Requests say whose page they are from
  (`X-MvL-Account`); the server refuses one from a page of another account than the session's, and
  every change, synced state and the notification stream need it (a tab from before this asks for
  a reload). Only signing out and the service worker renewing its push subscription go without.
- **Push** subscriptions belong to the session that made them: signing out removes them, and one
  whose session ran out gets nothing. A page whose account hasn't turned push on in this browser
  (a visitor, or someone else) unsubscribes one still there. Empires only gives a multiplayer seat
  back for a kept token to the same account.
- **Signing out** clears that account's space. A session that just ran out doesn't: the page
  starts again as a visitor and the account's unsynced changes come back when it signs in again.
- **Moving in.** The first time a space is used, what the release before spaces kept in plain keys
  moves into it, if the old marker says it was that account's; later writes to those keys (by a
  tab still running the old release) are never read. A visitor signing in brings their synced
  state along into a new account's space, once. (A browser where the old release had already put
  one account's state under another's marker moves it as the marker says: that mix-up predates
  spaces, and nothing new can cause it.)

`pnpm check:sync-accounts` checks this against the real server and with tabs in memory.

A browser signing in for the first time takes the account's window layout
instead of saving its own opening windows over it. Desktop widgets are not part of the window
layout: they have a set of their own that follows the account (see *Widgets*).
Notes merge by note id, between devices and between tabs of one browser alike
([`src/data/notes.ts`](src/data/notes.ts)), each part on its own: the later edit of the text wins,
whether a note is in the trash goes by the later of its last trashing and its last restore from
either side (so trashing a note never throws away an edit made meanwhile elsewhere), notes added
on either side are kept once each, and a note deleted for good stays deleted (its tombstone is
kept for 90 days). Every change counts on past the note's own counters, in the browser and in
the agents' note tools on the server alike ([`src/data/noteClock.ts`](src/data/noteClock.ts)),
so a device whose clock runs behind doesn't lose its later edit.
Tabs merge independent note and widget changes: a tab merges what another
tab saved into its own value right before it saves, and only ever reads when it hears of another
tab's save. This is not an atomic transaction: near-simultaneous tab saves can still lose one
change if both read before either writes. Agent `update_note` uses last-writer-wins text updates
and can replace typing that the browser has not pushed yet. Older notes without edit/restore
counters use their live copy's `updated` time as evidence of a restore, so a stale trash copy
cannot undo an old-version restore. Old-version edits and restores cannot be distinguished.
The first-layout exception ends when this browser receives or successfully pushes an account
layout; later remote layouts do not replace window changes that have not been saved locally.

Signed in, launchers are files: freedesktop `.desktop` files in your home, as on Linux
([`src/data/launchers.ts`](src/data/launchers.ts), [`src/data/launcherFiles.ts`](src/data/launcherFiles.ts)).
Those on the desktop are in `~/Desktop`; the ones for the dock, All apps and Spotlight only are in
the hidden `~/.local/share/applications`. Home is Seafile's when it is mounted on `~`, else the
files kept in this browser. A launcher file looks like this:

```ini
[Desktop Entry]
Type=Link
Name=GitHub
URL=https://github.com/
Icon=🐙
X-MvL-Id=1a2b3c4d
```

`Icon=` is an emoji or a picture's address (without one, the site's favicon), and `X-MvL-Id=`
keeps the dock and Spotlight's favourites pointing at it when the file moves. One that opens an
MvL OS app instead has `Type=Application`, `X-MvL-App=calendar` and, optionally,
`X-MvL-Props=path=~/Work;`. The desktop and Files show a launcher as itself (its name and icon,
opened with a double-click), never as `GitHub.desktop`; *Show hidden files* in Files shows the
file's own name, and its menu has *Edit the file in Zed*. Renaming one changes its `Name=` (and
drops its translations, `Name[nl]=`, so the new name shows in every language); the file keeps its
name. The terminal shows them as the files they are: `ls ~/Desktop` lists `GitHub.desktop`, `cat`
prints it and `open GitHub.desktop` opens what it points at. The format is read without a library
([`src/data/desktopEntry.ts`](src/data/desktopEntry.ts)) and strictly: a file that is not a desktop
entry, a program to run (`Exec=` alone) or an address that is not http(s) is shown as a plain file.
Writing changes only the keys it sets, so comments, other groups and keys MvL OS does not know stay.

Settings → Launchers lists them all, to add, edit, reorder and remove, and moves a file between
the two folders with its *Desktop* switch. Spotlight, the dock and All apps read the same two
folders; a launcher dragged into another folder stays a working launcher there but leaves the
dock.

Launchers are kept in a list synced like notes: in this browser for visitors (who have no home,
so for them that is all they are), and through the server when signed in, so every device has
them. Without Seafile, home is kept in this browser alone, so there the two folders' `.desktop`
files *are* that list ([`src/data/launcherStore.ts`](src/data/launcherStore.ts), through
[`src/data/browserfs.ts`](src/data/browserfs.ts)): writing, renaming, moving or deleting one there
(from the terminal, Files, the desktop or Settings) changes the list, and the other devices show
the same files. One moved out to another folder becomes a plain file of this browser and leaves
the list; a `.desktop` file moved in joins it. With Seafile as home they are real files in Seafile,
which every device sees anyway: the list is turned into those files once (the ids done are kept in
`~/.local/share/applications/.mvlos-migrated`, so a launcher deleted since does not come back),
and nothing is taken out of it.

Signing in with GitHub (system menu → *Sign in with GitHub*) syncs all of that through the server
and turns Spotlight into a code search over GitHub and any linked Gitea/Forgejo instances
([`server/search.ts`](server/search.ts)):

| Query | Finds |
|-------|-------|
| `bolt` | your repositories (and from three letters, issues and PRs) |
| `#123` | issue or PR 123 in the repos you pushed to last |
| `repo#123`, `owner/repo#123` | that issue or PR, also outside your own repos |
| `#text`, `repo#text`, `repo#` | issues and PRs matching text (half-typed words too), or a repo's open ones |
| `repo@text`, `@text` | branches, with their last commit and pull request |

Tab completes the highlighted result (`owner/repo`, then type `#` or `@`); Ctrl+Enter copies a
clone command, link or branch name. Enter opens a repository, issue or pull request on the web;
its actions panel (Ctrl+K or right-click) has *Open in Git*, which shows it in the Git app instead.

### The Git app

**Git** ([`src/apps/git/Git.tsx`](src/apps/git/Git.tsx)) browses the same repositories, and takes
part in their conversations: everything on your GitHub account (also through your organisations) and on the
Gitea/Forgejo instances you linked. The list on the left filters by name, owner or organisation and
host, grouped by owner with your own first, and shows the language, when it was last pushed and
whether it is private. Without "Allow private" in Settings → Code hosts only public GitHub
repositories show, and the list says so. A repository has four tabs:

- **Overview**: description, stars, forks, open issues, default branch, licence, topics, the clone
  addresses to copy, and the README rendered with the site's Markdown renderer. Its relative links
  and images point into the repository on the host; the common HTML in READMEs (logos, badges,
  `<details>`) is turned into Markdown first, since the renderer never renders HTML.
- **Pull requests** (open, merged, closed or all) and **Issues** (open, closed or all), a page at a
  time with *Load more*. A pull request has *Conversation*, *Commits* and *Files changed*; an issue
  shows its conversation.
- **Commits**, per branch (a picker lists them), grouped by day. A commit shows its message, author,
  parents (click to walk back) and its changed files.

Changed files are unified diffs, one collapsible box per file with line numbers and the additions
and deletions tinted from the theme; a long line scrolls inside its box. Binary files and diffs
too large to send (over 96 KB for a file, 2 MB in all) say so with a link to the host's page, as
does anything past GitHub's limits (300 files).

A conversation ([`Timeline.tsx`](src/apps/git/Timeline.tsx)) reads like the host's own page: the
description, then in the order they happened the comments (marked when edited), reviews (approved,
changes requested or commented, with their comments on lines listed under them as `file:line`),
the commits pushed in between as one compact block per push (short hash and first line, each
opening the commit), and one-line events: closed, reopened, merged (with its commit), force-pushed,
title changed, labels, assignees, review requests, branch deleted and mentions from other issues
and pull requests (which open in the app). The first 300 entries show; past that a link goes to
the host. Below it is a box to **add a comment**: Markdown with *Write* and *Preview*, Ctrl+Enter
(⌘+Enter) sends, and the new comment appears at once. The description and the comments **you
wrote** have an *Edit* button that opens the same editor with *Save* and *Cancel*. What you type is
kept as a draft per pull request or issue for as long as the tab is open (also across a reload,
where the browser allows sessionStorage), and leaving one, or closing the window, with text that
wasn't sent asks first. Writing to GitHub needs "Allow private" in Settings → Code hosts (the
default sign-in can only read); without it the box is greyed out with a pointer there. A linked
Gitea/Forgejo token needs the `write:issue` scope, and says so when it lacks it. Anything else
(reviewing, merging, closing, labels, a new issue or pull request, checks) is a button with an
arrow-out icon that opens the host's web page.

A wide window keeps the list beside the open repository with breadcrumbs above it; a narrow window
or a phone shows one view at a time with Back (Alt+← with a keyboard). The window takes a `route`
prop (`github/owner/repo`, `…/pull/12`, `…/issue/4`, `…/commit/<sha>`, a linked instance as
`forge:<id>`; see [`route.ts`](src/apps/git/route.ts)), which is how Spotlight opens it; without
one it reopens the repository you had open last in this browser. Signed out, it asks you to sign
in. Open it from All apps, Spotlight, the dock or `open git` in the terminal.

The server side is [`server/git.ts`](server/git.ts): a fixed set of `GET /api/repos/...` routes
(repositories; a repository with its README; branches; pull requests, one with its timeline, its
commits and its files; issues and one with its timeline; commits and one with its files), and three
that write: `POST …/issues/:n/comments` (a comment, on an issue or a pull request),
`PATCH …/issues/:n` (the description) and `PATCH …/issues/comments/:id` (a comment), each taking
`{ body }` as JSON (at most 65,536 characters, GitHub's limit). Every part of the path is checked
(host id, owner, name, number, hash, branch, comment id) and each route answers only its own
methods, so it is no open proxy. Before an edit the server reads the item or comment from the host
and refuses unless its author is your login there; writes need a signed-in user, pass the same
cross-site check as the site's other changes, and GitHub ones need the write scope before GitHub is
asked. A refusal from the host comes back as what to fix (sign in again with private repositories
allowed; a token with `write:issue`). Timelines come from GitHub's and Gitea's issue timeline APIs
(Gitea before 1.20 has none: its comments and reviews are used instead), with the pull request's
commits for logins and its review comments for the reviews. It goes through the same code host sources as Spotlight
([`server/forges.ts`](server/forges.ts)), so tokens, rate limits and the address checks for linked
instances are shared. GitHub's and Gitea's answers are turned into one shape there
([`server/gitShapes.ts`](server/gitShapes.ts), types in
[`src/data/gitTypes.ts`](src/data/gitTypes.ts)); Gitea's diffs come as a `.diff`, which is split
into files on the server. Answers are kept a minute per user; Reload in the app asks the host
again, and a write forgets that repository's answers so the next read is fresh.

Your repositories include those of every organisation you are in: GitHub's own list
(owned, collaborator and organisation repositories) plus the most recently pushed hundred of
each organisation, so typing an organisation's name (`acme`) lists its repositories too. Lists are
kept a few minutes (GitHub 5, Gitea/Forgejo 15) and refreshed in the background; an issue, pull
request or branch from a repository the list lacks refreshes it at once (at most once a minute),
and signing in again starts over. Settings → Code hosts lists your GitHub organisations and
whether the site can read them. Organisations can restrict OAuth apps (GitHub's default for new
ones): until an owner approves the site, only their public repositories show. The *Grant access*
button opens GitHub's page for the site's OAuth app, where owners click *Grant* and members
*Request*; coming back to the tab checks again. GitHub hides an organisation that restricts the
app from the site altogether when your membership is private, so it only shows up on that page.
Sign-ins from before "Allow private" asked for `read:org` see only public memberships, and get a
*Sign in again* button.

Signed in, the dock is yours too ([`src/os/dockItems.ts`](src/os/dockItems.ts)): right-click a
dock icon to remove it, and right-click (or Shift+Enter) an app, launcher or repository in
Spotlight or All apps to pin it. An open app that isn't pinned offers *Keep in dock* on its own
dock item, or drag it in among the pinned ones to pin it at that spot. Settings → Dock lists what
was taken off, to add it back, and restores the default dock. Everyone can still drag dock icons
to reorder them. Dropping a launcher or an app (from All apps) on the dock pins it there, a file
dropped on an app's icon opens in that app if it opens that kind of file, and anything dropped on
Trash goes in the trash.

Anyone with a GitHub account can sign up for a desktop of their own, up to `MAX_USERS` accounts
(default 100). Over the cap, or with sign-up closed, a new account gets a "We're full" (or
"Sign-up is closed") dialog instead; existing accounts and admins can always sign in. GitHub accounts whose numeric id is in
`ADMIN_GITHUB_IDS` (comma-separated, default `46482143`) are admins (the id never changes, a login can be renamed and taken by someone else; the old `ADMIN_USERS` is retired and grants nothing): Settings → Users lists the accounts (counts and
sizes only, never their contents), bans, signs out and deletes them, and opens or closes sign-up.
Keys set on the server (`OLLAMA_API_KEY`, `UPDOWN_API_KEY`, `OPENAI_API_KEY`) are only used for admins; everyone
else saves their own in Settings → Integrations.

Users choose the addresses of their Gitea, CalDAV, Seafile, OnlyOffice and search servers, so the
server only reaches public addresses for them, also after redirects
([`server/egress.ts`](server/egress.ts)); admins may use internal ones. Each request connects to
exactly the addresses that were checked, so a host whose DNS answer changes in between (DNS
rebinding) cannot reach the server's network either; TLS still checks certificates by name. No
firewall rule is needed for this. Don't add a subnet rule on a network the site shares with other
services (a reverse proxy's): it would cut those off too.

Gitea/Forgejo instances are linked from Settings → Code hosts, in a window of their own, with a personal access token (read access to
repository, issue, user and organization). Tokens are stored encrypted (AES-256-GCM) in SQLite
(`node:sqlite`, no extra dependency) under `DATA_DIR` (default `./data`, a volume in compose).

The database also holds plaintext user data (synced state, notes, agent conversations, notifications,
tasks, account and photo metadata), so the server keeps it private on every start, for existing
installs too: `DATA_DIR` is set to `0700`, and `mvlos.db` (with its WAL files) and `secret.key` to `0600`,
whatever the umask. This matters for bind mounts and local runs, where other users on the machine could
otherwise read them. Windows has no POSIX modes and is left alone. `pnpm check:data-perms` verifies it
(fresh and pre-existing loose modes; CI runs it).

Setup:

1. Create a GitHub OAuth app (GitHub → Settings → Developer settings → OAuth Apps) with callback
   URL `https://<your site>/api/auth/github/callback`. Local dev needs its own app with
   `http://localhost:5173/api/auth/github/callback`.
2. Put `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` in `.env`. Optional: `ADMIN_GITHUB_IDS`
   (comma-separated numeric GitHub ids; find yours at `https://api.github.com/users/<login>`), `MAX_USERS` (the starting cap; Settings → Users changes it), `PUBLIC_URL` (the site's
   address, e.g. `https://mennovanleeuwen.nl`; set it in production, since without it the server
   takes `Host` and `X-Forwarded-*` from each request, and logs a warning at startup), `SESSION_SECRET` (otherwise a random key is generated once into
   `DATA_DIR/secret.key`), `GITHUB_SCOPES` (what "Allow private" in Settings → Code hosts asks
   for, default `read:user repo read:org`; sign-in itself only asks for `read:user`). Which scopes a sign-in asks for can't be set from a link: Settings
   makes a same-origin POST to `/api/auth/github/scope`, which sets a one-time, sealed, HttpOnly cookie (10 minutes, tied to that
   account) used by the next `/api/auth/github/login` and cleared by it; `?repo=` on the login URL is ignored.

Without the OAuth settings, sign-in is simply off and everything else works as before.

**Google Calendar** attaches to the GitHub sign-in (system menu or Settings → Integrations → Calendars) for the
Calendar app, the Agenda widget and the clock: your calendars, shared ones included, with Google's
refresh token stored encrypted next to the Gitea tokens ([`server/google.ts`](server/google.ts)). It
needs `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` from a Google Cloud OAuth client (type *Web
application*) with the Calendar API enabled, the scopes `calendar.readonly` and `calendar.events`
(plus `openid` and `email`), and the redirect URI `https://<your site>/api/google/callback` (and
`http://localhost:5173/api/google/callback` for development). Publish the consent screen to *In
production*: in *Testing*, Google expires the access after seven days. The Calendar scopes are
"sensitive": until Google has verified the app, everyone connecting sees Google's "unverified app"
screen and at most 100 accounts can connect (verification asks for the privacy page,
`/privacy.html`). The consent in progress is tied to the account and session that started it (a sealed,
HttpOnly, ten-minute cookie, and a one-time entry in the server's memory, so a copied cookie cannot be replayed): finishing it while another account is signed in, from another session,
after a sign-out, or with an altered or expired cookie is refused before any token is requested or
stored (`pnpm check:google-oauth`). Accounts connected before
the Calendar app stay read-only until connected again (Settings → Integrations → Calendars → *Allow editing*).

**CalDAV** calendars (Fastmail, Nextcloud, iCloud and others) work next to Google: Settings →
Integrations → Calendars → add an account with its server URL (Fastmail's is filled in), username and an app
password, stored encrypted ([`server/caldav.ts`](server/caldav.ts)). Read-only is enough to look;
the Calendar app needs read-write to change things (adding the same account again replaces its
password). The calendars are found from the URL, and events are fetched by date range with the
server expanding repeating events, so everything shows both sources together.

The **Calendar** app ([`src/apps/calendar`](src/apps/calendar)) shows the switched-on calendars by
day, three days, week, month or year. Drag on an empty spot to make an event (into another day to make one that runs over days: in the week
views from the time you press to the time you let go, in the all-day row and the month as an all-day event;
backwards works too), drag an event to
move it, drag its bottom edge to change its length; click one for a read-only card beside it (when,
place, call link, calendar, guests with their answers, notes, linked notebook notes; *Edit* or `E`/`Enter`,
*Delete* or `Del`, `Esc` or a click outside to close, a ⋯ menu with the right-click menu's items; a sheet
from the bottom in a narrow window; also what opens when another app sends you to an event), and double-click
it, or press *Edit*, to change its title, time, place,
notes, calendar and guests (picked from your contacts, invited by email by Google or the CalDAV
server; *Email guests* writes to them all). For one occurrence
of a repeating event it asks whether the change is for that one or the whole series. The sidebar
has a *Birthdays* calendar under Contacts: your contacts' birthdays and anniversaries as all-day
events with the age they turn, read-only, on until switched off there; opening one opens the
contact. A `.ics` file dropped on the calendar (from the computer, Files or the desktop), or opened in it
from Files, the desktop, Spotlight, a Mail attachment or the terminal's `open file.ics`, is imported: its
events (title, time in its own zone, place, notes, how it repeats) are listed first, then made in the
calendar picked, without their guests so nobody gets an invitation from you. Events the calendar has
already, by their UID, are skipped, and the notice says how many (the UID is kept when the event is made,
`POST /api/calendar/known` asks the server which ones a calendar has). The reader
([`src/apps/calendar/ics.ts`](src/apps/calendar/ics.ts)) is forgiving: a file that never closes its event,
a UTF-8 or UTF-16 text (BOM or not, [`src/data/decodeText.ts`](src/data/decodeText.ts)), lowercase names, `VALUE=DATE-TIME`, a
quoted TZID, `X-WR-TIMEZONE` for times with no zone, and extended ISO dates (`2026-10-15T14:00:00+02:00`).
When nothing can be imported the notice says why (`1 event found, but its start time couldn't be read (...)`).
Calendars can be **hidden** in Settings → Apps → Calendar (*Show in MvL OS*, one switch per calendar, grouped by account, with the
Contacts birthdays and the task lists too; also *Hide everywhere* in the right-click menu of a calendar in the Calendar's sidebar). That is
stronger than unticking one in the sidebar, which only filters it from the views: a hidden calendar is left out everywhere, so the
duplicates of Google calendars that Fastmail also lists can go. Gone are the sidebar, the views, every calendar picker (the event editor, where new events
go, the import), the Agenda widget, the clock, reminders, and the Agents app's calendar tools. A note's link to an event in a hidden calendar
still finds it. The ids are synced with the account (`calendar-hidden`, [`src/data/calendar.ts`](src/data/calendar.ts)); the server reads them
too ([`server/calendars.ts`](server/calendars.ts)). A CalDAV task list that the server never named (Fastmail's `DEFAULT_TASK_CALENDAR_…`) shows as *Tasks*.
With no calendar linked the Calendar says so, with a button to Integrations, and keeps the file for when one is. `pnpm check:ics` covers the reader. Changes go
through [`server/calendars.ts`](server/calendars.ts): Google's API, or the event's own iCalendar
text on the CalDAV server, written back with its ETag so other apps' properties stay.

**Mail** ([`src/apps/mail`](src/apps/mail), [`server/jmap.ts`](server/jmap.ts)) reads and writes mail
over [JMAP](https://jmap.io) (RFC 8620 and 8621): Fastmail, Stalwart and other servers that speak
it. Settings → Integrations → Mail links an account with an API token (for Fastmail: Settings →
Privacy & Security → Manage API tokens, with *Mail* and *Submission* access) and, for anything but
Fastmail, the server's address, where the session is found through `/.well-known/jmap`. Fastmail's tokens
all start with `fmu1-`: anything else is refused before it is sent, and a refusal from the server comes
with its own short reason. The token is
checked once, stored encrypted and never sent to the browser: the server makes every JMAP call,
through the same egress checks as the other integrations, batched with back-references. IMAP and
SMTP are not supported. The app has mailboxes with unread counts, conversations (a list drawn only
where it shows, loading more as it scrolls), the reading pane, search (words, or `from:`, `to:`,
`cc:`, `subject:`, `has:attachment`, `is:unread`, `is:flagged`, `after:2026-01-31`,
`before:2026-12-31`, across every mailbox but Trash and Junk), flags, archive, move (also by
dragging a conversation onto a mailbox), junk, delete to Trash and, from Trash only and after an
in-OS question, for good. Writing is plain text with attachments from the computer or from Files
(Seafile); every change is saved as a draft after a pause, and Send submits it with the chosen
identity (`EmailSubmission/set`, moved to Sent once the server has taken it). A PDF attachment
opens at a click in MvL OS's PDF window, a picture in Preview, and audio or video in Player
(titled with the file's name, its Download saving it), never in a new browser tab: they are read
through this site with the session (`/api/mail/<account>/blob/…`, only for the account's owner;
PDF.js reads the bytes of the download, which is always `application/octet-stream`; pictures,
audio and video of a few known types come inline, and audio and video with byte ranges for
seeking; every answer has `nosniff` and a sandboxing CSP). The chip's download button, its right-click
menu and *Download all* still download. Other attachments (Office files and the rest) download as
before. Attachments save to Files too. Keys: `j`/`k` (or the arrows) to move, Enter to open, `e` archive, `#` delete, `!` junk,
`s` flag, `u` read or unread, `r` reply, `a` reply all, `f` forward, `c` compose, `/` search,
Ctrl+Enter to send (a setting). In a narrow window or on a phone it shows one pane at a time: mailboxes, list,
conversation, each with a way back.

Mail draws its icons itself ([`src/apps/mail/icons.tsx`](src/apps/mail/icons.tsx)): thin line
drawings in the text colour, so they follow the theme. Mailboxes get one by their role (Inbox,
Drafts, Sent, Archive, Spam, Trash) or, for Fastmail's role-less Snoozed and Scheduled, by name;
other folders get a folder. The reading pane's actions (Archive, Delete, Junk or Not junk, Move
to, Mark unread, Flag, More) work the way Fastmail's do: an icon whose name slides out beside it on
hover or keyboard focus, and every name shows when the pane is at least 780px wide (a container
query in [`mail.css`](src/apps/mail/mail.css)). Every button also has a tooltip and an
`aria-label`. Touch screens have no hover, so there More starts with the same actions by name, and
it does the same in a narrow pane. Junk, Move to and Mark unread are always in More too: below
360px (a small phone, or a reading pane squeezed by a small window) their buttons give way, so
More always fits. Buttons are at least 40px on coarse pointers.

Senders show as their contact's photo, if they have one. Otherwise they get their organisation's
logo (as in Fastmail), and failing that their initials. The logo comes from this site,
`/api/mail/icon/<domain>`, for signed-in users only
([`server/mailicons.ts`](server/mailicons.ts)). Logos are looked up per organisation domain, its
registrable domain (`anwb.nl` for `service@verzekeren.anwb.nl`, `example.co.uk` for
`a.b.example.co.uk`), never the sender's full host and never their address. That domain comes
from the Public Suffix List (the `tldts` package, the server's only npm dependency), ICANN
suffixes only, so `x.github.io` counts as `github.io` and `victim-1.info.nl` as `info.nl`. So a
sender who gives every recipient a host of their own can't learn from the lookup who opened the
mail or when, and the sender's servers never see the reader. The server tries the domain's BIMI
logo first (the `default._bimi` TXT record's SVG). After that it tries the site's own icons
(apple-touch-icon, `<link rel=icon>` with their sizes, `/favicon.ico`) and keeps the largest
square one, checking the real size from the bytes, not the Content-Type. The site's HTML and the
SVG check are read with `indexOf` and short, anchored patterns, and tags over 4 KB are skipped,
so a hostile page can't stall the server ([`server/preview.ts`](server/preview.ts), shared with
Spotlight's link previews).

The server limits these lookups:

- Every fetch goes through the egress checks: public addresses only, also after redirects, and
  web ports only.
- DNS (addresses and the BIMI record) is asked of a resolver with its own deadline (2 to 2.5
  seconds a try, two tries), and is cancelled for real when the lookup ends. This also holds for
  every other egress check ([`resolveHost`](server/egress.ts), in place of the system's
  `getaddrinfo`; `localhost` is still 127.0.0.1).
- Every answer that isn't read (a redirect, an error, a page that isn't HTML) is cancelled at once.
- Each picture is limited to 256 KB and 5 seconds. The whole lookup is limited to 15 seconds,
  after which everything it is still fetching is cancelled. Its turn stays taken until that has
  happened.
- At most four lookups run at once and 50 wait. More than that, or a wait over 20 seconds, gets a
  503, and the avatar keeps its initials.
- Each user gets 60 new lookups a minute (cached answers don't count). After that they get a 429.
- IP addresses and local names are refused.

Found logos are cached in `DATA_DIR/mail-icons` for 30 days, missing ones for 3 days, and lookups
that ran out of time for an hour. The cache keeps at most 2000 domains and 100 MB, and the oldest
go first. It is tidied at startup, hourly and every 50 new entries, which also removes expired
entries, files without their other half and leftover temporary files (never while a logo is being
written: writes and tidying take turns). The browser keeps a logo
for a week, and a missing one for a day. Logos are served with `nosniff` and a sandboxing CSP,
so an SVG opened directly runs nothing. Addresses at personal mail services (Gmail, Outlook,
iCloud, Proton, Ziggo and so on) keep their initials, since those logos say nothing about the
person.

In the avatar the logo is clipped to the same circle as the initials. A square, opaque logo (an
app icon) fills it edge to edge. Any other logo sits whole and slightly inset on the theme's
raised surface (`--bg-light`). The app works out which kind it is from the logo's shape and the
transparency of its corners. A thin ring in the theme's border colour keeps a dark logo visible on
a dark theme. The initials stay underneath until the logo has loaded, so the row doesn't shift,
and they stay for good if it fails. `pnpm check:mail-icons` checks the SVG check, the domain rules,
the allowance, the queue, the time limit and the cache's tidying; add `--network` for a live
lookup. `pnpm check:egress` checks which addresses count as private, IPv6 forms that carry an
IPv4 address included (mapped as `::ffff:7f00:1` or `::ffff:127.0.0.1`, compatible, NAT64, 6to4).

Several conversations can be selected at once, as in Files and Photos, and as in Fastmail's list:

- **Checkboxes:** a sender's picture turns into a checkbox on hover or keyboard focus. Ticking it
  selects that conversation without opening it (Shift for the range from the last one), and
  clicking anywhere else on the row opens it as before. While anything is ticked, every row shows
  its checkbox, and selected rows are tinted with the accent bar on the left.
- **Selection bar:** the list header becomes a bar with a select-all checkbox (indeterminate while
  only some are selected), how many, the actions as icons with their names on hover, and ×. Next
  to the list, the header's checkbox selects every conversation loaded.
- **Keys and clicks:** Ctrl or Cmd+click takes one in or out, Shift+click or Shift+↑/↓ a range,
  Ctrl+A every conversation loaded, and Esc none.
- **Touch screens:** a long press starts selecting, taps then add and take away, and the checkbox
  spot is a 40px target.

With two or more, the reading pane also says how many, with Archive, Delete, Mark as junk or Not
junk, Mark as read or unread, Flag or Unflag, and Move to…. The keys above, the right-click menu on
a selected row and dragging a selected row onto a mailbox (the drag shows how many) act on all of
them. A selected conversation is all its messages, and each action is one request, one
`Email/set` on the server. The selection stays when new mail comes in and goes with a change of
mailbox or a search.

HTML mail is made safe on the server by an allow-list sanitiser of its own
([`server/mailhtml.ts`](server/mailhtml.ts): no scripts, event handlers, forms, frames, SVG,
`javascript:` links or CSS expressions; every tag balanced and every attribute re-escaped) and then
shown in an iframe sandboxed without scripts or same-origin, under a Content-Security-Policy that
allows nothing but its own styles and pictures. Remote images and CSS backgrounds are held back
until *Load images* (or the remote-content setting, see Mail settings below); tracking pixels
stay out either way. Links open in a new tab without an opener or referrer, with the real address
as their tooltip. Inline (`cid:`) pictures come along as `data:` URIs, or (big ones) through
short-lived sealed links that need no cookie. Quoted text, in HTML and plain text alike, is folded
away (or open, by setting). Calendar invitations (a `text/calendar` part or an `.ics` file, iMIP REQUEST, REPLY or CANCEL,
[`server/imip.ts`](server/imip.ts)) show as a card with what, when, where and the organiser, and
are answered from it (see *How the apps work together*). Senders and recipients show as your
contacts, with their photos; mailto: links in HTML mail open the composer (in a new tab, as every
link in a message does, since the message's frame runs no scripts).

**Mail settings** (Settings → Apps → Mail, or *Mail settings…* in Mail's sidebar and window menu;
[`src/apps/mail/MailPane.tsx`](src/apps/mail/MailPane.tsx)) are kept in the synced state `mail`
([`src/data/mail.ts`](src/data/mail.ts)), so they follow you between devices, and an open Mail
window follows a change at once. *Reading*: mark as read when opened (the default), after 2, 5 or 10
seconds (leaving sooner keeps it unread) or never; the default for remote content (see below); and
whether quoted text starts folded or open. *Writing*: the account Mail opens on and, per account, the
identity new messages are from (when there are several); a plain-text signature per identity (empty:
the one the mail server keeps for it), with a switch each for new messages, replies and forwards,
added above any quote after the usual `-- ` line; what `r` does (reply, or reply all; `a` is
always reply all); and whether Ctrl+Enter sends. *Notifications* points to Settings → Notifications
→ Mail, where the switch is.

Remote content has three modes: *Ask* (blocked, with a bar offering *Load images*, *Always for
this sender* and *Always for @domain*), *Allowed senders* (loaded for the addresses and domains on the
list, blocked for everyone else) and *Always load*. The server decides, from the synced state, so
remote content stays out of the HTML until the mode, the list or a *Load images* says otherwise;
tracking pixels stay out in every mode. The list shows when each entry was added, with *Remove*, a
search box from eight entries, *Add sender or domain…* (an in-OS prompt, checked) and *Clear all*
(after a question). Choosing *Always for this sender* while the mode is *Ask* switches it to
*Allowed senders*, since that is the mode that uses the list.

While mail notifications are on (Settings → Notifications → Mail) or Mail was used in the last half
hour, the server keeps a JMAP EventSource open per account (and polls every two minutes for servers
without one): new unread mail in an Inbox becomes a notification, pushed to devices when no page is
in view, and open Mail windows update at once. `pnpm check:mail` tests the sanitiser against hostile
mail and everything above against a stand-in JMAP server ([`scripts/mail-mock.ts`](scripts/mail-mock.ts),
which also runs on its own with `pnpm mail:mock` for trying the app). For other apps,
[`src/data/mail.ts`](src/data/mail.ts) has `composeMail({ to, cc, subject, body, attachments })` and
`openMail(id)` (and `openMailByMessageId(id)`), and hooks Contacts, Calendar and Tasks take:
`setSuggestProvider` (who the recipient fields suggest after your contacts: recent
correspondents), `setPersonHandler` (a click on a sender's or recipient's name), `setInviteHandler`
(answering invitations, and what the card says about them) and `registerMessageAction` (the
message menu's *Make task from this email* and *Create event from this email*, `task` and
`event`). [`src/os/pimLinks.tsx`](src/os/pimLinks.tsx) plugs them in.

**Tasks** ([`src/apps/tasks`](src/apps/tasks), [`server/tasks.ts`](server/tasks.ts)) is a to-do app laid
out like Apple's Reminders, for signed-in users. Its lists are the task lists of the CalDAV accounts in
Settings → Integrations → Calendars (the collections that take VTODOs: Fastmail's and Nextcloud's calendars, and
iCloud's reminders lists as far as iCloud still serves them over CalDAV; lists moved to Apple's newer
Reminders are not), and lists kept on the site itself, in SQLite, for accounts without CalDAV (those
start with one, *Reminders*). Above the lists, grouped by account, are the smart lists *Today* (due
today or overdue), *Scheduled* (by day), *All*, *Priority* and *Completed*. A task has a title, notes,
a due date with or without a time, how it repeats, a priority (none, low, medium or high: iCalendar's
9, 5 and 1, as Apple writes them), a link and subtasks. Type a new one at the top with its date at the
end ("Call mum tomorrow 9am", "Report fri !!", "Plan next week", "Pay rent on 31 oct"): what was read
shows beside it before Enter, with an × to keep the words as typed
([`quickAdd.ts`](src/apps/tasks/quickAdd.ts)). Tick the circle to complete a task; a repeating one
moves on to its next date instead (DUE, and DTSTART with it, one occurrence fewer for a counted rule),
the way Apple's Reminders and Thunderbird do, and is completed for good when its rule runs out. Click
a task for its details; right-click (or long-press) for its due date, priority, list, *Subtask of the
one above* and Delete (its subtasks go with it). In a list, drag a task by its handle into your own
order, kept as Apple's `X-APPLE-SORT-ORDER` so Reminders on an iPhone shows the same: the moved task
gets a number between its neighbours', and only when there is no room is the list numbered again.
*Show completed* adds the done ones (the newest 200 per list). Lists are made on a CalDAV account
(MKCALENDAR, for VTODOs only) or on the site, renamed and recoloured (PROPPATCH) and deleted; a
collection that holds events too is a calendar, and Tasks never deletes it. On a phone the sidebar is
the first screen and a list opens over it.

Changes work like the Calendar's: in the task's own iCalendar text, written back with its ETag, so
whatever else is in there (alarms, other apps' properties) stays. A task that changed elsewhere
between reading and writing (412) is read again and the change made once more on the new text; when it
changed yet again, the app says so. Tasks on the site are kept the same way, as each task's VTODO text
(tables `task_lists` and `task_items`), so one set of code handles both.

In the **Calendar** app, tasks with a due date show on their day, all day or at their time, with a
ring to tick them; dragging one changes its due date and opening one opens it in Tasks. The sidebar's
*Tasks* section switches lists on and off (the same switch as *Show in Calendar* on a list in Tasks).
The **Agenda** widget lists today's open tasks, overdue ones included, under Today.

**Reminders** for tasks come through the notification hub (Settings → Notifications → Tasks): at a
task's own alarms (VALARM, set in Apple's Reminders, say) when it has any, otherwise by the Tasks
app's settings (⚙ in its sidebar): when a timed task is due or 5 to 60 minutes before, and in the
morning of an all-day one at a set time (9:00 to begin with) in the browser's time zone. The watcher
looks every minute, reads the lists again every five minutes (at once after a change made here) and
sends each reminder once, up to an hour late after a restart. The settings are synced state `tasks`
([`src/data/taskPrefs.ts`](src/data/taskPrefs.ts)), which the server reads like `notify`.

**Google Tasks** is not included: the Google sign-in for the calendar has no Tasks scope (it would
need `tasks` added to the OAuth client, another sensitive scope for Google to verify).

**For other apps** ([`src/data/tasks.ts`](src/data/tasks.ts)): `createTask({ title, notes, due, url,
listId })` makes a task and answers it, in `listId` or else the list picked under *New tasks* in the
Tasks settings (or the first CalDAV list); `due` is a day ("2026-10-14") or an ISO time, and
everything but the title may be left out. `openTask(id)` opens the Tasks app on a task, with its
details. Mail's *Make task from this email* makes its tasks on the server instead
(`/api/pim/task-from-mail`), with a `message:` link back to the message in `url`. Underneath is `/api/tasks`: `GET` (`?fresh=1` past the cache), `POST {list?, task}`, `PATCH
{ref, task, list?}` and `DELETE {ref}`, `PUT /api/tasks/order`, and `POST`, `PATCH` and `DELETE` on
`/api/tasks/lists`.

```sh
pnpm check:tasks   # Against a stand-in CalDAV server: discovery, changes that keep other apps' properties, repeating tasks, a 412, order, lists, reminders sent once, quick add
```

`node scripts/tasks-mock.ts 8800` runs the stand-in ([`scripts/tasks-mock.ts`](scripts/tasks-mock.ts))
on its own, with user and password `mock`, to link from an admin account (admins may use internal
addresses) while trying the app.

The **Status** widget shows your [updown.io](https://updown.io) checks: up or down, uptime, the
last day's response time and certificates that expire within two weeks
([`server/updown.ts`](server/updown.ts)). It uses updown's *read-only* API key, from
`UPDOWN_API_KEY` on the server or saved in Settings → Integrations (stored encrypted).

**Seafile** comes into Files: Settings → Integrations links one account with its URL, username
and password (and a 2FA code if it has one). The password is used once; the server keeps only the
token Seafile hands out, encrypted, which shows up in Seafile's Devices as the site
([`server/seafile.ts`](server/seafile.ts)). Every library is under Seafile in Files' sidebar. The
primary library (My Library unless you pick another) is home unless you switch that off: Places'
Desktop, Documents, Downloads and so on are its folders, and the desktop shows its Desktop folder.
Text, code and config open in Zed and save back with Ctrl+S; pictures, video, audio and PDFs open in
the Viewer; `.ics` (also `.ical`, `.ifb`) and `.vcf` (`.vcard`) files open in Calendar and Contacts and
bring up their import dialog (see Calendar and Contacts), from Files, the desktop, Spotlight, the
terminal's `open` and a Mail attachment's menu; *Open with* has Calendar or Contacts for them too, and Zed for the raw text; the rest downloads. Encrypted libraries ask for their password in the window and lock
again after the minutes set in Settings (the password is never stored). Seahub's API sends no CORS
headers, so it goes through the server; files themselves go straight between the browser and
Seafile's file server, with links the server hands out. The sidebar's sections and items can be
dragged into another order and hidden (right-click, or *Customize sidebar*), synced like the dock.

**/etc/fstab** decides where Seafile shows up, for Files and the terminal alike
([`src/data/mounts.ts`](src/data/mounts.ts)). `seafile /mnt/seafile seafile` puts every library in a
folder of its own, `UUID=<library id> /home/<you> seafile` makes one home (Settings' *Use as home*
and primary library write that line), and a bind line such as
`/mnt/seafile/Photos/2024 /home/<you>/Pictures none bind` maps a place somewhere else (an older
fstab's `/home/menno` is read as your home). Until anything
edits it, the file is written from the older settings. Signed in, you can `sudo nano /etc/fstab`, `sudo
mount` and `sudo umount` (visitors are not in sudoers); Files' Home, places, breadcrumbs and Seafile
section follow at once, and the site's own home is at `/srv/site` while Seafile is on `~`. In the
terminal ([`src/terminal/fs.ts`](src/terminal/fs.ts)) `ls`, `cd`, `cat`, `grep -r`, `find`, `fd`,
`tree`, `touch`, `mkdir`, `cp`, `mv`, `rm` (into Seafile's trash; in a library without history it
asks first, unless `-f`), `tee`, `>` and **nano** ([`src/terminal/nano.ts`](src/terminal/nano.ts),
GNU nano 8.2's keys on an alternate screen) work
across the mounts; before a command runs, the Seafile folders and files it names are fetched.

**Without Seafile**, signed in, `~` is kept in this browser ([`src/data/browserfs.ts`](src/data/browserfs.ts):
one IndexedDB database per account, so another account on the same browser never sees it), laid
over the site's own home so README.md, games/ and the wallpapers stay readable. The terminal,
Files, Zed, the desktop, Preview, Player, Omamp, the PDF viewer, the Viewer and Archive (ZIPs) read
and write it, and copying or moving between it and Seafile carries the bytes over
([`src/data/fileOps.ts`](src/data/fileOps.ts)). Clearing the site's data deletes it, which is said
wherever it shows: a strip in Files, *Browser only* in Zed's status bar, the terminal's welcome and
`df`, Settings → Account (with a Delete). Once Seafile is home it is mounted on `/mnt/browser`
instead, and MvL OS offers to copy it into Seafile folder for folder. Unpacking archives and
OnlyOffice need the file in Seafile.

**What needs you** ([`src/os/alerts.ts`](src/os/alerts.ts)) shows the way macOS lists *Finish
setting up* in System Settings: "Set up file storage" (signed in without Seafile as home), an
update to restart into, or a failing sync. Settings lists them under your name and badges the pane
to go to, the dock badges Settings (or All apps), and the notification center keeps them on top
under *Needs attention* until they are dealt with.
`mount`, `findmnt`, `lsblk -f` and `man fstab` describe the table, read-only libraries mount `ro`,
and encrypted ones answer `Required key not available` until `fscrypt unlock` gets their password.

Pictures open in **Preview** and video and audio in **Player**, from Seafile or the site's own
files. Preview fits the picture to the window and zooms with its buttons, the keys (+, −, 0 for
actual size, 9 to fit), Ctrl+wheel or a pinch, towards the pointer; dragging or scrolling pans when
zoomed in, and the page never scrolls. It rotates (R, L), goes through the folder's other pictures
(arrow keys, or the thumbnail sidebar with S), shows an inspector (I), runs a slideshow (Space) and
goes full screen (F). Player takes the video's shape when it opens and has QuickTime's floating bar:
a timeline to hover and scrub with what is buffered, play and skip, volume, speed, loop, picture in
picture and full screen; it hides while playing. Keys: Space or K, J and L, the arrows, M, F, 0 to
9, comma and full stop for single frames, < and > for speed. Seafile's thumbnails come through the
server ([`server/seafile.ts`](server/seafile.ts)) for Files' grid and Preview's sidebar.

**Videos** (mp4, m4v, mov, webm, mkv, ogv) show a frame from themselves, with a ▶ and their length,
in Files' grid, list and gallery, on the desktop, and in Photos when Seafile made no thumbnail
([`src/data/videoThumbs.ts`](src/data/videoThumbs.ts)). Seafile is asked first (it makes them only
with `ENABLE_VIDEO_THUMBNAIL` and ffmpeg on its server, and stops being asked after three refusals);
otherwise the browser makes one: a hidden, muted video, never played, reads the file's header through
`/api/seafile/stream` (same origin, byte ranges) or a blob for files kept in this browser, seeks a
tenth of the way in (a second into short clips) and keeps that frame as a small WebP. Only tiles on
screen ask, two at a time, and scrolling away or closing the window stops the work. Frames are kept
in IndexedDB per account (at most 2,000 or 50 MB, the least recently shown going first), so each is
made once per browser; a video that gives none shows its icon and is left alone for a day. Encrypted
libraries answer no byte ranges, so there only videos up to 64 MB get a frame. Settings → Apps →
Files → *Video thumbnails* switches it off.

Files' toolbar has the sidebar button at its left end and the **preview pane** button at its right
end ([`src/apps/FilesPreview.tsx`](src/apps/FilesPreview.tsx)). The pane, on the right of the list,
shows the selected file (the one last clicked, with several selected) with the same code the apps
use: pictures as in Preview, video and audio through Player's addresses (with controls, muted and
not playing by themselves), Markdown as Zed's preview renders it, code and text with the same
highlighter (the first 200 KB or 2,000 lines), a PDF's first page with pdf.js, and the top level of
a ZIP (or of a tar in Seafile) as the Archive app reads it. Office documents are never opened there,
since that would mean loading OnlyOffice in the pane: they, and files of any other kind, show their
icon, details and *Open*. Under every preview are its name, kind, size, date (and a picture's or a
video's dimensions, a PDF's pages) and *Open*, which opens it as a double-click does. The arrow keys
move the preview along with the selection, after a short pause so a held key reads nothing on the
way. The splitter beside the pane drags its width (a double-click resets it), kept with the other
Files preferences. Settings → Apps → Files → *Preview* switches the pane off altogether, says
whether new windows start with it shown, and whether showing or hiding it in a window sets that
(*Remember when I show or hide it*, on by default) or only changes that window. The Trash and phones
have no preview.

Uploads go straight from the browser to Seafile's file server: drop files or whole folders from the
computer on a Files window (a folder, its empty space or the sidebar) or on the desktop, or use
*Upload files* / *Upload folder* in Files' menus. Three go at a time; a panel in the corner shows the
lot's progress and time left and each file's own, with cancel, retry and *Show in Files*. Files of
16 MB and up go in 8 MB chunks and carry on where they stopped after a retry. Names already in the
folder ask first: replace (Seafile keeps the old version), keep both, or skip.

With Seafile linked, Files' **Trash** is Seafile's (Settings → Integrations → Seafile can switch
that off): each library's own trash, from its history. Restore one item or several at once, open a
deleted folder and restore from inside it, and empty the trash of what is older than 3, 7 or 30
days, or all of it. *Keep deleted* sets how long the library keeps its history (7 days to forever,
or not at all); a library without history has an empty trash, and deleting from it says it is for
good. With Seafile as home, the desktop shows the Desktop folder's files and folders
next to the site's own icons; *Show the site's icons* (the desktop's menu, or Settings) leaves just
Seafile's. Right-click the desktop for New (folder, text file, sticky note, widget, launcher),
uploads and paste.

PDFs open in **PDF**, on Mozilla's [pdf.js](https://mozilla.github.io/pdf.js/) (loaded only when a
PDF opens, and left out of the offline cache): the pages one under the other in their own scrolling
area, drawn as they come into view, with text to select and search (Ctrl+F marks every match;
Enter and Shift+Enter go through them). A sidebar shows the pages or the table of contents; type a
page number to go there; fit width, fit page, or zoom with Ctrl+wheel or a pinch towards the
pointer; rotate (R), night mode, full screen (F) and download.

With **OnlyOffice** added (Settings → Integrations → OnlyOffice: the document server Seafile uses
and its `ONLYOFFICE_JWT_SECRET`), Word, Excel and PowerPoint files (and OpenDocument, CSV, RTF) open
in OnlyOffice's editor in a window; read-only libraries and old formats open to view. The server
signs the editor's settings like Seahub does and takes OnlyOffice's saves at
`/api/office/callback` ([`server/office.ts`](server/office.ts)): a sealed ticket says which file,
OnlyOffice's signature is checked, and the new version goes into Seafile (its history keeps the old
one). The document server must reach that callback: on a public site it does by itself; elsewhere
set `OFFICE_CALLBACK_ORIGIN` to an address it can reach. **New Document**, **New Spreadsheet** and
**New Presentation** make a blank file in Documents (or a folder picked with *New documents go here*)
and open it; they are in Spotlight and All apps, and can go on the dock and the desktop.

ZIP files open in **Archive**, browsed like folders without unpacking them: only the archive's table
of contents is read ([`src/data/zip.ts`](src/data/zip.ts)), and from Seafile just the end of the file
(a Range request), so a big one opens at once. Columns sort by name, size, packed size, how much was
saved and date; the search looks through the whole archive. Ranges go through the site's server
(`/api/seafile/raw`): Seafile's file server sends no CORS headers on 206 answers. It handles like
Files: click, Ctrl/Shift+click, Shift+arrows, Ctrl+A or a rubber band select; Back, Forward and Up
(Alt+arrows, Backspace, the mouse's buttons) go through its folders; right-click has the menu
(*Extract here*, *Extract to…*, *Copy path*, *Properties*; on empty space, sorting and the archive's
own). A double-click opens a folder or saves a file to your computer, unpacked in the browser.
Rows dragged by their name onto a Seafile folder (in Files, its sidebar, or on the desktop) unpack
there; dragging elsewhere on a row draws the rubber band.

Tar archives open there too, plain (`.tar`) or gzipped (`.tar.gz`, `.tgz`), read by our own code
([`src/data/tar.ts`](src/data/tar.ts): ustar, GNU long names, pax headers) and Node's zlib, never
by a native archiver. Tar has no table of contents, so the server lists one
(`/api/seafile/archive`): a plain tar header to header with Range requests, skipping the data in
between (a few reads, however big it is); a gzipped one only by reading it through from the start,
streamed and never stored, so only up to 2 GB packed and 64 GB unpacked. Listings are kept for ten
minutes. A file is saved from a tar through `/api/seafile/archive/file`; links are listed, not
unpacked. Bzip2, xz, 7z and rar are left out on purpose: they would need native code (with a
history of security holes) or whole downloads.

**Extract** unpacks everything, or the selected rows, into a Seafile folder (a
folder named after the archive, next to it, unless you choose another), with *keep both*, *replace*
or *skip* for names already there; Files' menu has *Extract here* and *Extract to…* on archives. The
server does the work ([`server/unzip.ts`](server/unzip.ts)): it reads only the chosen files' bytes
from Seafile (a gzipped tar: once through), unpacks each to a temporary file, checks its size (and a
ZIP's CRC; paths with `..` are refused, and a file that grows past its stated size is stopped),
and uploads it (Seafile's upload makes the folders). Stored and deflated files unpack;
password-protected entries and other methods are reported and left out. The terminal's `unzip`
does the same with Info-ZIP's options and output (`-l`, `-v`, `-p`, `-z`, `-d`, `-x`, `-o`, `-n`,
and its `replace …? [y]es, [n]o, [A]ll, [N]one, [r]ename` question); `tar` lists and unpacks tars the GNU tar
way (`tar -tvf`, `tar xzf a.tgz -C out member`, `-k`, `-O`).

Each of Files' places (Home, Desktop, Documents, Downloads, Music, Pictures, Videos) can be pointed
at any folder of any library: right-click it → *Choose folder…*; a place left alone is the
same-named folder of the primary library. The desktop follows Desktop, and new Office files go to
Documents. Right-click a Seafile folder's empty space for New (folder, text file, document,
spreadsheet, presentation), Upload, View, Sort, and Seafile (copy a share link, open it in
Seafile's own web interface, the library's trash, lock now).

The mouse's Back and Forward buttons, and the browser's own Back, go back in the focused window
(Files a folder, Preview a picture, Archive up a folder) instead of leaving the site.

Questions (delete this? empty the trash?) are the desktop's own dialogs, never the browser's.

**Agents** is a research assistant on [Ollama Cloud](https://docs.ollama.com/cloud), for
signed-in users ([`server/agents.ts`](server/agents.ts), [`src/apps/Agents.tsx`](src/apps/Agents.tsx)).
Add an API key from ollama.com in Settings → Integrations (stored encrypted), or set
`OLLAMA_API_KEY` on the server (admins only). Each thread is *Quick* (a search or two, a short answer) or *Deep*
(searches from several angles, reads the sources with web fetch, and writes a structured answer
with citations), on any of Ollama's cloud models that can call tools. Turns run on the server and
stream to the window, with the model's thinking folded under each reply; Stop ends one. Answers stay
plain by default: a thread's model, workflow, sampling and file names are named only when the user
asks about them or is changing them, so swapping the model or the LoRA is one short paragraph rather
than a tour of the settings, and nothing ends with an offer of further work. When a diagram, recipe,
chart or comparison says it better, the model draws one with a `visual` block (see *Visual blocks*
above; the prompt's short guide is [`src/data/visual/prompt.ts`](src/data/visual/prompt.ts)), making
the icons it needs first with `gpt_image` (`mode=icon`, after checking `list_icons`) and naming them `icon:<slug>`. The
composer holds the mode, the model, which tools the thread may use and attachments: text files, PDFs (their text, read in the browser with
pdf.js) and pictures, from Seafile, Photos, this computer, a drop (from the computer, Files or the desktop) or a paste.
**From Photos…** opens a read-only picker for connected Seafile and Immich libraries: browse albums
and months, search album names, select photos, then Attach. It reads the original PNG, JPEG, WebP
or GIF through the authenticated Photos proxy, not the thumbnail. Images keep the normal 5 MB per-file,
10-attachment and combined payload limits; unsupported originals (including HEIC and RAW) show an error.
Cancel leaves the draft and attachments unchanged; a failed download adds nothing. These are normal
image attachments for vision and, after sending, supported still-image sources for image-to-image.
The **context-window ring** is in the thread's top bar, by the ⋯ menu, not next to Send, so a thumb
aiming for Send cannot hit it. It stays usable while a reply is being written. It opens the
breakdown of what fills the window (with *Compact now…*) under the top bar; the ring again, the ✕
in the panel's corner (which stays at the top while the breakdown scrolls), or Esc closes it, also
while it loads or shows an error, and on a phone or touch screen a tap anywhere outside it does too.
The panel takes about a third of the window's height at most and scrolls within itself. The top bar
follows the width of its own pane, not the screen: wide enough for the title to keep room it is one
row, otherwise (a phone, or a narrow window with the sidebar open) the back button, title, ring and
⋯ are the first row and the chips (folder, Images, mail, permission) the second, wrapping further
for a long folder name or every chip on. `pnpm check:agents-context-bar` covers this in a browser
(scratch Vite server, mocked API).
Its tools: web search
(Ollama's own by default; Settings → Agents → Web search switches it to SearXNG, Brave Search, Kagi,
Tavily or any JSON search API described by a URL template, headers and result paths, with keys
stored encrypted, see [`server/websearch.ts`](server/websearch.ts)) and Ollama's web fetch, your notes, your calendars (below), your code hosts, Seafile (list, search by name, read), Seafile
changes (each one waits for *Allow* in the window, since a page the agent read could have asked
for it), `update_todos` (a plan for long jobs, shown as "3/12" over the composer; while items are
open a turn may run up to 150 rounds, and it keeps going on the server when the window closes, until
Stop) and `remember`/`update_memory`. A group with nothing behind it yet is greyed in that menu and
says why (Mail before an account is linked, Calendar before one is connected, Work folder before one
is chosen, Terminal outside the `agents` command); it can be switched off but not on. Memory is yours (every thread) or a project's (that
project's threads), filed by the agent under category paths such as People/Family or Work/Tools;
the Memory view shows it as a tree to search, add to, edit, move and forget. Projects group threads
in the sidebar: drag them into order, drag threads into or out of them, fold them; threads in and
out of projects can be pinned. The agent can manage projects too (list, create, rename, move the
thread), asking first. When it needs a decision or details it asks with `ask_user`: a small form in
the conversation (choice, multiple choice, yes or no, text, number, rating, date, or text to read;
several questions at once), and its turn waits for the answers. Each question type is one renderer
in `FIELDS` ([`src/apps/Agents.tsx`](src/apps/Agents.tsx)) and an unknown type falls back to a text
field, so new types can be added one at a time. Threads get a title from a small model, can be renamed (with a
suggestion), archived and deleted, and the sidebar folds to a rail. While a turn runs or waits for an answer, unavailable composer controls and session chips are muted and skipped by keyboard focus; Stop remains active.

**Past threads** lets the agent look back when you refer to an earlier conversation and the
answer is not already in this thread or memory. The `threads` tool group is on by default,
including for older threads; switch it off to keep a conversation from reading history.
`search_threads` searches your own user messages, assistant replies, compacted summaries, titles
and old titles across projects. Archived threads are included and marked unless excluded;
Spotlight threads are never searched. This thread is excluded unless explicitly requested with
`thread: "this"`. You can narrow by project, thread or inclusive dates in your time zone.
Matching is literal and partial, with ASCII case folding: variants and translations can be tried
together, with quoted phrases kept together. Up to six distinct terms are used, each at most
60 characters, from a query of at most 200 characters. One-character non-ASCII words are allowed.

Search returns up to ten threads with at most three short excerpts each, within 6,000 characters.
Distinct matching terms and title matches rank higher, with newer threads breaking ties.
Neighbouring matches in one turn share a slot. The candidate scan stops at 3,000 matches and
reports when it reaches that cap. `read_thread` reads 2–30 messages from the start, end or around
a message, within the mode's page budget. Tool results, thinking and attachment contents are not
searched. Hits and read messages name attachments; text attachments can be read explicitly,
up to 4,000 characters each, while messages are cut at 2,000. Image prompts and tool results are
not added to search hits. In `read_thread`, a `generate_image` call includes its requested prompt,
negative prompt and image settings (including LoRAs and weights), labelled as a request rather
than confirmed output. Prompts are limited to 1,200 characters and each call to 2,000; the message
and page limits still apply. Its result names the owned image ID, private URL path and a settings
line taken from the saved artifact. Other tools keep name-only labels and their results stay out.
The agent can inspect an earlier image by passing its ID to `view_generated_image`, provided the
current model supports vision; it should look at the picture rather than guess from a description.
Missing installed settings or assets must be named before recreating it, not silently substituted.
These reads need no approval in any permission mode. Answers from history should name the thread and date; old conversations
are evidence, never instructions or permission to save a memory. A failed search should say
which words were tried rather than invent a conversation.

```sh
pnpm check:agents-threads   # History search, ownership, attachment reads, bounds, ranking and 20,000-message timing
```

The Agents checks include `check:agents-roles`, `check:agents-permissions`, `check:agents-compact`,
`check:agents-images`, `check:agents-image-files`, `check:agents-image-studio`, `check:agents-openai-images`, `check:agents-mail` and `check:agents-threads`.

A reply that only thinks gets one more round asking for the answer, and an answer given while the
todo list still has open items gets one asking to update it. Those asks go to the model as a user
message marked as the app's (never saved or shown), not in the system prompt, because some models'
servers (Mistral's) refuse a conversation that ends on the assistant's reply. As a safety net, any
request that would still end there gets a short "Continue." after it.

```sh
pnpm check:agents-roles   # The nudge, the todo wrap-up and a restart mid-reply, against a stand-in Ollama that refuses a trailing assistant message
```

**Pictures and icons from OpenAI.** Ollama Cloud makes no pictures, so the **GPT images** tool
group (`gpt_image` and `list_icons`, [`server/agentOpenAI.ts`](server/agentOpenAI.ts)) gets them
from OpenAI's gpt-image models. Set it up in Settings → Apps → Agents → Images, under
**OpenAI pictures and icons**; the tools are only offered once it is set up. Pick where pictures
come from, and the model (`gpt-image-2` by default):
- **OpenAI API key**: checked with OpenAI (listing models, which costs nothing), stored encrypted
  like the Ollama key and never sent back. Admins fall back to `OPENAI_API_KEY` on the server.
  Pictures come from the Images API and are billed to that key.
- **Sign in with ChatGPT**: uses the ChatGPT plan instead of a key, through the Codex CLI's sign-in,
  done the way [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) does it. It is
  unofficial: OpenAI does not permit it for hosted apps and could restrict or ban the account. A
  note says so next to the option, and an in-OS dialog says it again before the sign-in starts;
  the server also refuses to start one unless the dialog was accepted. The sign-in is OAuth with
  PKCE at auth.openai.com, with the Codex CLI's public client (`app_EMoamEEZ73f0CkXaXp7hrann`) and
  its only registered redirect, `http://localhost:1455/auth/callback`. Nothing listens there on a
  hosted site, so the browser ends on a page that does not load: copy that address and paste it
  back into Settings within 15 minutes. Its `state` must match, and the code is exchanged on the
  server. The tokens stay on the server, encrypted, and are refreshed there (before they expire,
  and once more when the backend refuses one). Pictures come from the ChatGPT Codex backend
  (`chatgpt.com/backend-api/codex`): its `/images/generations` route, or the Responses API with the
  `image_generation` tool where that route is missing. **Sign out** forgets the tokens.

`gpt_image` makes one of three things:
- A **picture** (square, landscape or portrait; low, medium or high quality; optionally transparent).
  It is kept with the tool's result like a sent picture, so it shows under the call (thumbnail, full
  view, Open in Preview, Download) and is still there when the thread is opened again. The model is
  told it was shown, never given the bytes. The result gives it an id (`gpt:<12 hex>`, kept on the
  attachment as `ref`) to draw from it again.
- An **infographic** (`mode: "infographic"`): one picture like the explainers ChatGPT makes, high
  quality and landscape (1536 × 1024) unless the model asks for medium, low or portrait. The tool
  description teaches the model to write the prompt as a layout: a title banner, the scene, each
  labelled part with a short caption and an arrow, a numbered "How it works" strip, the style, and
  every text in quotes and short. It counts as one picture.
- An **icon** (`mode: "icon"`): a small square symbol in one fixed flat style on a transparent
  background, drawn at low quality and stored at 256 px in the account's **icon library** under a
  slug (`a-z`, `0-9`, `_`, `-`, like `diamond_pickaxe`). Asking for a slug that exists returns the
  stored icon without drawing, unless the agent passes `regenerate`. The result gives the model the
  reference `icon:<slug>` to use in diagrams, recipes and other visualizations. The tool tells the
  model to check `list_icons` first, reuse slugs and keep names generic.

**Drawing.** A picture or infographic shows while it is drawn: a dotted frame in the picture's
shape (theme colours, breathing gently unless reduced motion is on) with "Drawing… 37%" under it.
gpt-image says nothing about how far it is, so the percentage is an estimate from the time alone
(`drawingPercent` in `AgentsGptImage.tsx`): steady up to 90% at a typical time for the quality and
size (`expectedMs` in `server/agentOpenAI.ts`: 20 s low, 45 s medium, 90 s high, 1.3 times for the
large sizes, 10 s more with references), then slower, never 100% before it is done. The Images API
(and the Codex routes) are asked to stream two rough previews (`stream`, `partial_images: 2`;
`image_generation.partial_image` / `image_edit.partial_image`, and
`response.image_generation_call.partial_image` on the Responses API); each one fills the frame as it
comes, served from memory at `GET /api/agents/threads/<id>/gpt-preview/<callId>` until the picture is
done. The drawing is kept as a pending image job of the turn (with its estimate and how long it has
run), so a window that opens the thread halfway shows it too, and the agents terminal UI says
"Drawing picture…". Stop aborts the request to OpenAI; a stopped or failed picture is not counted.
Where a route will not stream (the Codex direct route answering 400 to it), it is asked again
without, remembered until the server restarts, and the window shows the frame and estimate only.

**References.** `references` (up to 4 picture ids, 8 MB each, 16 MB together) lets the model draw
from pictures in the thread: one the user sent (`attachment:<message>:<n>`, the id is in the
picture's attachment tag the model reads) or an earlier gpt_image picture (`gpt:<id>` from its
result, or `attachment:<message>:<n>` of the tool result). Only pictures of the same thread, read
from what is stored; URLs and paths are refused. With an API key they go to `/v1/images/edits` as
`image[]` parts; on Sign in with ChatGPT to the Responses API as `input_image` items, with the
tool's `action` set to `edit`.

**Edit.** Each made picture has **Edit…** under it and in its full view. It asks "What should
change?" in an in-OS dialog and sends a normal message, `Change the picture "<name>" (gpt:<id>):
<change>`, which the agent answers by drawing it again with that picture as a reference. A message
rather than a direct call, so the agent still has the original prompt in view and can keep
everything else the same, and the change is in the thread like any other request. It is offered
while GPT images is on in the thread and the thread is not answering.

`GET /api/agents/icons/<slug>` serves an icon of the signed-in account as a PNG (404 when there is
none), and `GET /api/agents/icons` lists them. Settings shows the library: each icon with its slug
and description, **Redraw** (from the saved description) and **Delete**.

Each picture or new icon counts against a daily cap per account (`OPENAI_IMAGES_PER_DAY`, default
40, over the last 24 hours; reused icons are free), and against the storage quota. Pictures run
without asking in every mode except Plan. `OPENAI_URL`, `OPENAI_AUTH_URL` and `CHATGPT_CODEX_URL`
point at stand-ins for testing.

```sh
pnpm check:agents-openai-images   # API key, pictures kept with results, streamed previews (served while drawing, joined halfway, Stop aborts), infographic defaults, references to the edits route and Responses input_image, the icon library, the cap, and the ChatGPT sign-in (risk gate, PKCE, pasted callback, refresh, retry, Responses fallback, a route that will not stream), against fakes
```

**Image generation.** In Settings → Apps → Agents → Images (also the app's settings),
enter your ComfyUI URL and optional bearer token, then **Save & discover models**. Select a preset
and installed model, and save again. Connections belong to the signed-in account; secrets are
stored encrypted and are never returned to the browser or model. Internal/LAN ComfyUI addresses
are allowed only for admins, using the same DNS-pinned network guard as other integrations for
non-admin accounts. The server must be able to reach ComfyUI; browsers never connect to it directly.

**Image Studio.** Generate by hand, without an agent: **Image Studio** at the top of the Agents
sidebar (also the rail icon, the sidebar's right-click menu, and **Open Image Studio** in
Settings → Agents → Images). It works without an Ollama key, as it needs only ComfyUI. It is laid
out like Diffu's Generate page. In a wide window it has three columns:
- **Left**: the model. A quick pick lists every installed checkpoint and diffusion model by family.
  Under it are the workflow, the model with its text encoder and VAE (Auto or Manual, as in
  Settings), the Raw/Turbo variant for Krea2 and Z-Image, and a custom VAE for checkpoints. A
  family card follows, with the rules the workflow follows, where the settings came from, and
  warnings (unsupported, v-prediction). Then come LoRAs (preview, trigger words that a click adds
  to the prompt, weight 0–2 by slider or exact number) and embeddings (+/− for the prompt or the
  negative prompt). After those: the prompt with a token estimate (characters for the
  long-context encoders), the negative prompt, a source picture, and the size. The source is one
  of your generated pictures or an upload from this device, converted to PNG in the browser; it
  sets the size and a 0.6 strength. The size has 1:1 to 21:9 buckets, width and height with a
  shape lock and swap, and a batch of 1–8.
- **Middle**: the picture as it is made, using the same block grid as a thread. Under it are its
  actions: **Use these settings**, **Send to chat…** (into a new or recent thread's message box),
  **Refine…**, **Edit area…** (inpaint or remove), **Upscale…**, **Download** and **Delete**.
  Below them is the Studio's history.
- **Right**: **Generate**, which turns into **Queue** while a picture runs, and **Cancel**. With the
  reason it cannot run yet, if any (with **Copy all**). Then the queue, the seed (−1 random, Roll,
  Last, Lock), steps, CFG, sampler and scheduler from ComfyUI's live list, denoise for a source,
  clip skip, and a hires pass with an optional upscale model.

In a window under 1000 px, or on a phone, the middle column comes first with the prompt above
it. **Parameters** and **Advanced** open the two side columns as drawers, and Generate sits in a
bar at the bottom, clear of the home indicator.

The family rules are shared with the server (`presetRules`/`applyPresetRules` in
`src/data/modelFamilies.ts`):
- Only diffusion models get a separate encoder.
- Turbo workflows hide the negative prompt and fix CFG at 1.
- Clip skip and embeddings are for SD 1.5/SDXL checkpoints only.
- Diffusion models (so Krea2 always) take model-only LoRAs.

A new model on an untouched form takes its recipe straight away: model_details' Civitai example
consensus when there is one, else the family's defaults. If you changed the sampling by hand
since then, the Studio asks under the model heading: **Apply recommended settings** or **Keep
current**. The form follows the account (synced, so it also works without browser storage). The
history is the server's: Studio pictures live in a hidden per-account thread that no thread list,
search or Spotlight shows.

Runs go to `POST /api/agents/images/studio/run` (NDJSON: start, progress, image, done or error).
It plans with the same function as generate_image: the same graph builder, catalog and asset
checks, quota and one-job lock. It needs no approval card, like Generate another. A batch runs
one picture after another, with a fixed seed counting up by one. Closing the request cancels
only the Studio's own queued prompt. The other routes are:
- `GET /api/agents/images/studio`: the thread and whether ComfyUI is connected.
- `GET /api/agents/images/studio/images?scope=studio|all&before=`: the history, or every picture
  of the account for picking a source.
- `GET /api/agents/images/studio/embeddings`.
- `POST /api/agents/images/studio/upload`: PNG, up to 12 MiB.
- `DELETE /api/agents/images/studio/images/<id>`: Studio pictures only.

```sh
pnpm check:agents-image-studio   # Family rules, the form's request and validation, and the endpoint against a stand-in ComfyUI: owner only, graphs per family, batch, uploads, history
```

**Edit an existing image (image-to-image).** In a generated image's **Options → Edit image…**,
Agents adds a named source chip and starts an edit prompt in the message box; describe the change
and send. Picking another source replaces the chip; existing draft text is kept. An attached
picture can also be edited: attach it with a request such as “use this image, change the sky”, or
choose **Edit image** from a sent message's Options. Images must be enabled in Tools. The CLI uses
the same server tools: ask to edit an earlier image or attached picture; no ID copying is needed.
`list_generated_images` discovers current generated artifacts (including branches), `read_thread`
provides earlier owned image IDs, and `list_image_attachments` discovers persisted attachments in
this or an explicitly named owned thread. `view_generated_image` can inspect either source kind
when the conversational model supports vision. Attaching a picture alone does not request a job.

**Localized editing.** On a generated image, choose **Options → Edit selected area…**.
For a sent upload or Photos attachment, use its message’s **More → Edit selected area: filename**;
the original owned attachment is used directly, with EXIF-oriented dimensions read when it loads. Describe
the replacement and denoise (default 0.65), then **Paint edit area**. **Apply mask** saves an owned
mask and starts inpainting; cancel before applying discards the selection without starting a job.
To erase something instead, leave the instructions empty and choose **Paint area to remove** (when
the backend has LaMa, see below): **Remove area** saves the mask and removes it.
The backend capability is checked first. The app uses the source image's recorded diffusion
components/sampling when available; otherwise it uses current image settings. For a saved mask,
the CLI/model can call `generate_image` with `operation: "inpaint"`, `source_image_id`, `mask_id`,
and a prompt. Select an uploaded source with `list_image_attachments` and reuse its exact
`attachment:message:index` ID; select a mask whose `source_image_id` matches that ID. The agent makes
masks itself with `make_image_mask` (below); `list_image_masks` lists up to 20 masks in this or an explicitly owned thread.
Masks are bound to one source, remain private, count toward account storage, and are retained
with surviving branch artifacts. Attachment source IDs keep resolving through owned copies
in surviving branches, including branches of branches, after the original thread is deleted. At most eight unused mask uploads are kept per thread;
new uploads prune older unused masks. Canceling during upload discards an unused completed upload
when its response arrives. Referenced masks cannot be deleted separately. Again reuses the recorded source and mask with a fresh seed;
Retry replays the direct action. Approval cards identify the mask and working-size preservation.

**Automatic masks and object removal.** Asked to "remove the cyclists on the left, keep Marisa", the
agent does the whole edit without questions: `make_image_mask` selects the object by words, then
`generate_image` erases it. `make_image_mask` takes `source_image_id`, `target` (what to select:
1–4 comma-separated phrases of up to 80 characters, one thing each, like `"cyclist, bicycle"`),
optional `exclude` (what must stay, 0–4 phrases, subtracted), `grow` (pixels, 0–64, default 12),
`threshold` (0.05–0.95) and `hand_off`. It runs one fixed graph on the owner's ComfyUI: LoadImage →
the text-prompted segmenter once per target phrase → MaskComposite add (the union) → GrowMask; the
same for the `exclude` phrases → GrowMask (4 pixels past the target's growth, so no ring is left
around what stays) → MaskComposite subtract; then MaskToImage → SaveImage. Each phrase's own
selection is saved as well, and the result's `phrases` gives its coverage, so the agent sees what
each one caught; a phrase that finds nothing is reported in `note` and does not sink the mask while
another phrase finds something. The agent is told to name what people ride, push or hold
(`"cyclist, bicycle"`, `"rider, horse"`, `"stroller"`) so no empty bike is left, and to exclude what a
kept person rides too (`"woman in a light blue shirt, red bicycle"`). Segmenter nodes unload their
model after running: each node in a graph holds its own copy, and three SAM3 copies ran a 16 GB
GPU out of memory. The segmenter is ComfyUI-RMBG's `SAM3Segment`
(SAM3 reads the words itself), or `SAM2Segment` (SAM2 with GroundingDINO) when SAM3 is absent or
fails at run time, for example when GroundingDINO breaks on a newer transformers release. Each
segmenter's inputs come from the schema the backend advertises: inputs this app understands get its
values, any other input gets the advertised default or first choice, never one that looks like a
URL or a download entry (newer RMBG releases require a
SAM3 `model_name`, which is filled in this way), and a segmenter with a required input it cannot fill
(a link) is skipped without blocking the other. The
server reads the result back, makes it a clean binary mask at the source's size and keeps it as an
owned mask, so its `mask_id` works with inpaint and remove unchanged. The result carries the
`mask_id`, `coverage_percent`, a `bbox` in pixels and the mask and source links. Nothing found
(0%) is an error that suggests another word; over 60% comes with a warning to use `exclude` or a
tighter target. It uses the same egress, credentials, storage quota, one-job-per-account lock and
cancellation as generation, accepts no graphs or model names, and validates its text before any
upload. It runs without an approval card in every mode except Plan, which refuses it like other
image writes. When the nodes are missing it says so and the agent asks for a painted mask instead.

`generate_image` with `operation: "remove"`, `source_image_id` and `mask_id` erases the mask's white
area with LaMa (ComfyUI-RMBG's `AILab_LamaRemover`: LoadImage + LoadImageMask (red) →
AILab_LamaRemover → ImageCompositeMasked through the original mask → SaveImage), at the source's
full size (at most 4096 pixels per side), with no prompt, model or sampler. LaMa's own preprocessing
blurs and grows the mask, so its output is composited back through the binary mask: the smoothing
stays inside the white area and black pixels stay the source, to within one level (ComfyUI works in
floats). The mask PNG and source preview routes are `private, no-store`, like generated images. Diffusion inpaint stays for "replace X with Y". `list_image_models`
reports `automatic_masks` and `lama_remove`, and the catalog `autoMask` and `remove`, with the reason
when either is unavailable. `view_generated_image` also takes a `mask_id` to check a mask next to its
source with vision before an edit, when the agent is unsure (for example that it covers the person
and their bike); the rule against vision right after generating is unchanged.

Every `make_image_mask` attempt is kept, including empty and oversized ones, with its target,
exclude, coverage and box, for as long as the thread (or a branch that shows it) exists. A thread
keeps up to 40 agent masks: beyond that the oldest ones nothing refers to are pruned, and a mask a
generation used or a result card in any thread or branch shows is never pruned or deleted, so the
cap is exceeded when all of them are. They count toward storage like painted ones, their recorded
details included. `list_image_masks` lists
them with `made_by` (agent or user) and a status: used (a saved picture was made with it), ready
(the newest for its source), rejected (empty, or oversized and replaced) or superseded. In the
chat each mask shows as its picture with the selection tinted in the theme accent, what it
selected, and **Edit mask**. The picture loads from `/api/agents/image-masks/<mask_id>/source`, which
finds the owned source when shown, also an attachment whose original thread was deleted and only a
branch copy remains; cards saved earlier load the same way. **Edit mask** which opens the mask editor preloaded with it. Saving there keeps a new
mask and puts it in the message box ("Continue with my edited mask"), so the agent carries on with
it when you send. Cancelling while it saves, or opening another editor, drops that save and deletes
its uploaded mask. When automatic masking fails twice, or you ask to fix the mask yourself, the
agent calls `make_image_mask` with `hand_off`, the card offers **Open mask editor**, and the agent
waits for your message. In the Agents terminal each mask is a line with its target, coverage,
status and link.

Opaque 8-bit RGB and RGBA PNG masks are accepted. A mask saved from the editor is first rounded to
pure black and white (white where the RGB average is at least 128), because browsers that guard
against canvas fingerprinting, such as Brave, nudge the pixels the editor reads back.
RGB channels must be equal and either black (0) or white (255); transparency is rejected.

**Mask editor integration.** `src/apps/AgentsMaskEditor.tsx` is a reusable standalone modal.
Pass `sourceUrl` (authenticated same-origin HTTP(S)), `sourceName`, EXIF-oriented `width` and
`height`, `onCancel`, and `onApply({ mask, width, height })`; optionally `initialMaskUrl` (a saved
same-origin mask of the same size to start from) and `applyLabel`. The caller closes the editor after
applying. Cancel never calls `onApply`; changing the source or dimensions starts a fresh mask.
The editor checks the loaded dimensions and accepts at most 8192 pixels per side and 16,777,216
pixels total. The exported PNG is opaque and binary: white edits, black preserves; the preview
uses the current theme accent. Empty masks and exports above 8 MiB report an error.

Brush/erase work with mouse, pen and touch, at fitted display sizes. Focus the canvas to move its
cursor with arrows (Shift moves farther) and paint a dot with Space. Ctrl/Command+Z undoes and
Ctrl/Command+Shift+Z (or Y) redoes, also as buttons. **Invert** swaps selected and kept, **Grow** and
**Shrink** move the edge by 4 pixels, **Hide mask** shows the picture underneath (painting pauses), and
Reset clears everything, the starting mask too. Escape cancels. Undo stores at most 512 steps / 32,768 points,
with a clear limit message instead of unbounded snapshots. Preview resolution is capped at
1600 pixels per side; export retains source dimensions. The component itself performs no uploads.
Its caller persists the mask only on Apply. The server validates opaque binary RGB PNG pixels,
nonempty selection, source binding, dimensions and the 8 MiB mask cap before backend uploads.
The synthetic browser check is `node scripts/agents-mask-check.ts http://127.0.0.1:<dev-port>`.
`server/agentImageInpaint.ts` supplies the pure graph composition and mask-format validation for
integration. `assertInpaintNodes` checks the discovered schemas before uploads; `inpaintGraph`
accepts a server-built img2img graph and source/mask references, retains its preset and LoRA
chain, and adds matched mask resizing, latent noise masking and a final pixel composite.
Only the working-size image is preserved outside the resized mask, not the original-resolution
source. `node scripts/agents-image-inpaint.ts` checks all six preset graphs without a GPU;
`node scripts/agents-inpaint.ts` checks the real HTTP/approval lifecycle against mocked services.
Run them as `pnpm check:agents-image-inpaint` and `pnpm check:agents-inpaint`.
`pnpm check:agents-image-source-branches` (`node scripts/agents-image-source-branches.ts`)
checks attachment identity retention and Again inputs across img2img, refine and upscale branches.
For keyboard/touch, attachment editor, EXIF export, cancellation, preloaded-mask tools and mask
card browser checks, start a scratch Vite server and run `node scripts/agents-mask-check.ts http://127.0.0.1:<port>`.
`pnpm check:agents-images` also runs `scripts/agents-auto-mask.ts`: `make_image_mask` and LaMa removal
against a mocked ComfyUI (graphs, SAM2 fallback, exclude, coverage limits, mask history and status,
ownership, missing nodes and Plan mode).

`generate_image` accepts `source_image_id` and optional `denoise` (0.1–1; default 0.65). Lower values
preserve more source structure; higher values allow larger changes. Without `operation: "inpaint"`
and its matching `mask_id`, this changes the **whole image**, and unchanged regions are not guaranteed. All six existing presets use Diffu's matching LoadImage → ImageScale →
VAEEncode → KSampler path, with the same encoder/VAE, LoRA and sampling validation as text-to-image.
The live catalog must support LoadImage, VAEEncode and ImageScale's lanczos/center options; otherwise
editing is refused. Custom model weights remain unverified even when their catalog names match.

With a source, omitted dimensions follow its aspect ratio, using a 512-pixel longest edge for SD1.5
or 1024 for the other presets. Dimensions round to multiples of 64 and clamp to 256–1536; maximum
area remains 1536 × 1024. Providing one dimension derives the other from the source ratio; two
explicit dimensions set the requested shape. **Lanczos resize and center crop never stretch the
source**; grid rounding can trim edges and extreme ratios can crop substantially. Source, final
size, model, settings and denoise appear in approval when enabled, with a source thumbnail. Existing
permission modes, silent success, progress and cancellation apply. Results and image observations
record source ID/name/original dimensions, resize policy and actual denoise/settings. Generate
another reuses that source and settings with a fresh seed. Branches retain attachment source IDs
through owner-scoped aliases to their copied messages, including branches of branches. Deleting the
parent keeps Generate another working while a surviving branch holds the source; deleting every
copy makes that source unavailable. Aliases count toward storage quota and are removed with their
copied messages. `pnpm check:agents-image-source-branches` covers this retention and owner isolation.

Source validation is a bounded structural and dimension preflight, not a full image decode. Corrupt
compressed pixels may still be rejected by ComfyUI; upload, prompt and decoding failures are reported
as errors, with no successful image result.
Sources are read only from the owner's persisted artifacts/attachments, never model-provided
paths, URLs or base64. Supported sources are still PNG, JPEG and WebP, at most 20 MiB for generated artifacts or 8 MiB for attachments, 8192 pixels
per side and 16 megapixels (attachment upload limits still apply). EXIF orientation is honored when sizing the source, matching ComfyUI's loader. Malformed EXIF
and animated inputs are refused. Original bytes are held through
approval and generation, and the original artifact is never changed. Uploads use unpredictable
unique names, no overwrite, and the configured guarded ComfyUI connection. ComfyUI has no standard
input-delete endpoint, so uploaded source files remain in its input folder: admins can remove
`agents-source-*` files **only after their jobs finish**. Cancellation deletes only this job's
queued prompt; it never globally interrupts ComfyUI or deletes another job's inputs.

Every image model field opens the same **model browser**, in account settings and session
settings: checkpoints/diffusion models, text encoders and VAEs. It shows the installed catalog as
folders, with breadcrumbs and a folder sidebar, search across all paths, filenames (the full identifier in the details pane),
a current-selection marker and details for the selected file. Slash and backslash separators both
form folders, but the original identifier is sent unchanged to ComfyUI. Folder/name/extension are
shown; sizes, compatibility claims and thumbnails are not invented: a row shows artwork, size and
base model only when the backend's metadata supplies them, and a file icon otherwise. Each picked
model is a compact row (thumb, name, path when it differs, **Change…**). Arrow keys move through rows,
Right opens a folder, Left goes to its parent, Enter selects a row, and **Use selected** or
a double-click confirms. Escape cancels and returns focus to the picker. On phones, folder rows
and breadcrumbs replace the sidebar. The workflow picker lists the six supported presets as
compact cards; selecting one does not imply that an arbitrary installed model supports it.
These dialogs sit in the desktop's layer, so the OS dropdowns and confirm dialogs open above them.

**Automatic asset recommendations** are shared by account settings, session settings, the CLI
and generation. New empty model, encoder and VAE selections mean automatic; existing nonempty
selections remain manual, so an upgrade or workflow/backend change never silently replaces them.
**Use recommended assets** explicitly opts all three fields into automatic mode; each field also
has its own **Auto | Manual** switch (Auto clears the manual choice, Manual opens the browser). Automatic encoder/VAE choices
follow the selected workflow. Known incompatible manual choices are flagged and refused before
generation; unknown custom names remain manual with an unverified-compatibility warning.

Recommendations follow Diffu's family/style detection and asset rules: Krea2 requires an explicit
Raw/Turbo family hint, Qwen3-VL 4B, and a Qwen Image/Krea2 VAE. Z-Image uses Qwen 3 4B and a
Z-Image VAE or the documented Flux 1 `ae.safetensors` fallback; that fallback is never recommended
for Krea2. See the [ComfyUI Z-Image example](https://comfyanonymous.github.io/ComfyUI_examples/z_image/).
SD 1.5/SDXL use complete checkpoints. Video, Flux, Anima and other recognized unsupported
families are excluded. Exact canonical encoder/VAE names rank ahead of variant names; model
weights are not ranked by supposed quality, precision, filename order or hardware assumptions.
One clear family match is selected automatically. Equally plausible matches show choices instead
of picking arbitrarily; a manual current choice is preserved. Missing or unknown assets show
installation/selection guidance. Catalog/name hints do not verify the tensors in custom weights.

**A preset is the recipe; the checkpoint only runs it.** Steps, CFG, sampler, scheduler, size,
whether a negative prompt exists and which text encoder family is needed all come from the preset
together with the thread's and account's settings, so one file serves more than one recipe: Krea2
Raw (52 steps, CFG 3.5, euler / simple) and Krea2 Turbo (8 steps, CFG 1, euler_ancestral / beta) run
the same Krea2 diffusion model, and Z-Image and Z-Image Turbo likewise. A Krea2 file whose name and
metadata say neither raw nor turbo matches neither preset on its own; discovery says the variant is
unknown and that the preset decides, rather than guessing. Diffu keeps exactly that as a user
choice (`inferKrea2Variant`), so a file can be registered as turbo there. The agent's guidance
follows the same line: what will actually run is the thread's `selected` settings from
`list_image_models`, a file name is a hint, and a checkpoint is never called a turbo build or not
one, nor credited with detail or handling that came from its name.

Optional LoRA Manager family labels enrich at most one 50-item page (1 MiB, three seconds),
matched by exact category and relative path. Plain ComfyUI falls back to conservative filename/
folder hints. This does not download or scan an entire model library. Automatic intent is stored
as an empty string, while resolved filenames are computed from the current installed catalog
on discovery and again before generation. Backend changes cannot reuse stale automatic choices;
manual files missing from the new backend remain visible and require user action.

**Session image settings** are available from **Images** in the conversation toolbar (including a
new thread), or `/images` in the Agents terminal. Both open the same browser and settings dialog.
A thread may override its preset, model, text encoder, VAE, LoRAs, width, height and seed. Fields marked
*Account default* follow later changes to the account; dimensions without an override follow the
chosen preset's size. **Use default** removes one override; **Use all account defaults** clears the
thread's overrides, even when ComfyUI is offline. Empty seed means a fresh random seed each time.
These settings persist with the thread across restarts, affect only that thread, and never include
backend URLs or credentials. Generation still follows the thread's existing permission mode.
Changing settings affects subsequent tool calls; an already submitted job keeps its captured settings.

The CLI also supports `/images show`, `/images reset`, and
`/images set {"width":768,"height":1024,"seed":42}` to merge explicit overrides into this thread.
`/images set {"model":"","clip":"","vae":""}` enables automatic session recommendations;
`/images show` reports resolved values, automatic/manual state and guidance. Removing overrides
with `/images reset` restores account inheritance, including its automatic intent.
A workflow/model change can be supplied together in that JSON; separate diffusion workflows also
need a compatible installed `clip` and `vae`. Krea2 preset IDs are `krea2_raw` and `krea2_turbo`. Unknown fields, unsupported presets and absent models
are rejected by the shared server. Opening `/images` before the first message creates the session.
The model can discover effective settings through `list_image_models`; it cannot reconfigure the
backend or persist session settings. Explicit supported model/components, sampling and
width/height/seed on `generate_image` override the session only for that call. Use `/images` to change the saved model or workflow.

**LoRAs** are discovered from ComfyUI's `LoraLoader` and `LoraLoaderModelOnly` nodes.
The optional LoRA Manager adds base-model hints and trigger words from one bounded page, joined
by exact folder and filename. Discovery never guesses a trigger word or downloads a model.
`list_image_models` includes query-filtered `options.loras`, matching `loraHints` and the thread's
current list in `selected.loras`. Match the LoRA's family to the preset, for example SDXL with
`sdxl` or Krea2 with a Krea2 preset; unknown base models mean compatibility is unverified.

Save a list with `/images set {"loras":[{"name":"style.safetensors","weight":0.8}]}` using an
exact installed identifier. The thread’s Images dialog shows the saved list and lets you change
weights or remove entries before saving. Up to five LoRAs run in list order; weights are finite numbers from
0 to 2 and default to 1. `generate_image` accepts the same `loras` list for one image without
saving it; an empty list disables LoRAs for that call. `/images reset` clears the saved list along
with the other thread overrides. Each image uses this app's own graph, so LoRAs in a separate
ComfyUI workflow never run here. Diffusion presets prefer the model-only loader and leave the
text encoder untouched; checkpoint presets patch both model and text encoder. If only the other
loader exists, the graph uses it instead. Approval cards show a **LoRAs** row, and saved generation
metadata records each identifier and weight; older images without that field still open normally.

**Mentions in a message** work in the app and the CLI:

- `#name` or `#name:0.8` selects an installed LoRA for this thread. Exact identifiers win;
  otherwise a unique, case-insensitive filename or filename without its extension is accepted.
  Repeating a LoRA updates its weight rather than adding it twice. Unknown or ambiguous names
  produce an application context note with nearby installed names and leave the list unchanged.
- `$name` attaches a skill's instructions anywhere in a message. `/name` still works at the start.
- `@name` points at a tool for this turn. Its group and on/off state appear in the context note;
  a mention does not enable a group or bypass permissions. Use the Tools menu or CLI `/tools`.

Typing a sigil at the start of a token opens suggestions. Type to filter, use Up/Down to select,
and Enter or Tab to accept; in the app, Right accepts too when the caret is at the end of the word
(further in, it moves the caret as usual), the same for `#`, `$`, `@` and `/`. Escape closes the
list. App suggestions also accept mouse or touch. LoRAs load lazily from the signed-in account's
backend, only those ComfyUI reports as installed. Each row shows the LoRA's own title, its folder
dimmed and its base model; a pane beside the list shows the highlighted one's preview, base model,
trigger words, tags, folder and size when LoRA Manager supplies them (its first 50 LoRAs), and
otherwise what the file name says, with a plain placeholder for the picture. On a phone the first
tap on a row opens that detail under it and a second tap (or **Use**) inserts it. The preview
comes through this server from the account's own ComfyUI, never straight from the browser: owner
only, PNG, JPEG or WebP checked by its bytes, at most 384 KB, cached in memory for 10 minutes
(8 MB in all). A disconnected backend shows where to connect it. Names with spaces use quotes, such as
`#"styles/Soft light.safetensors":0.8`, which suggestions insert automatically. Message text stays
as written; one clearly labelled application context attachment records what resolved, with skill
instructions in their own attachments. Resolution handles at most 20 distinct mentions and five
skills per message. The CLI keeps `# ` followed by text for remembering a fact and `@./path`,
`@/path` or `@~/path` for attaching a file; bare `@name` now refers to a tool.

Ask “Generate an illustration of a blue bird” in either Agents or the `agents` terminal session.
The **Images** tool group controls discovery, generation, vision inspection and image learning/profile tools. When it is on, the agent's system prompt also gets Diffu's image-generation guidance (model families, prompting style, negatives, sampling and size); when it is off, that section is left out. Generation runs
without an approval card in every mode except Plan, which cannot generate. To approve each image
first, turn on **Ask before generating images** in Settings → Agents → Images (off by default);
then every mode that can generate shows the resolved settings for approval, Bypass included (also
for LaMa removal), and non-interactive `agents -p` declines as usual. Both interactive and print output include a private image URL. `/open` opens the
thread in the app, where the image has a thumbnail, full-size view, **Open in Preview**,
**Download** and **Save to Files…** (on the card, in its right-click menu, and in the
full view). The link requires the owner's signed-in session; sharing a thread does not publish
its generated images.

**Save to Files…** saves the PNG itself into your Files, through the same folder picker and upload
path as Mail's Save to Files. The entry names where it saves: **(Seafile)** when Seafile is linked
(the picker then also offers **This browser**), **(this browser)** when only the browser's own
files can be written; with neither, it is not shown. The name comes from the prompt and the image's
short id (`a-lone-lighthouse-at-dusk-8f3a2c1d.png`, or `image-8f3a2c1d.png` without a prompt), the
same each time; when that name is taken, it offers a numbered one (`… 2.png`) and never replaces the
file that is there. A failure says what it was: a read-only, locked or encrypted library, Seafile's
quota, this browser being full, Seafile no longer linked, or the picture deleted with its thread.
The recorded settings are not saved next to it; **Download settings** under *Generation settings*
still gives them as JSON.

On a later explicit request, the agent can save an existing image with `save_generated_image`,
in the app or the `agents` terminal. Images and Seafile changes must both be on, and Seafile must
be linked; ComfyUI need not be connected. The tool takes an image ID from any of your own threads,
an exact library ID or unambiguous library name, and a full `.png` file path such as
`/Desktop/18+/picture.png`. It copies the original PNG bytes internally, without sending them
through the model, and keeps the generated artifact. The approval card identifies the image,
Seafile account, library, path, byte count and replacement choice. Ask first, Auto and Accept edits
ask before saving; Plan refuses and Bypass runs without a card.

`list_generated_images` gives the agent exact image IDs and filenames from the current thread,
including after compaction and in branches, without needing a thread ID. It returns up to ten
images per page, newest first, with short prompt excerpts and a cursor for older images, within
6,000 characters. “Save these pictures” should use that list, rather than guess an earlier thread
ID. The agent also receives the current thread ID and the specific reason if saving is unavailable:
Images off, Seafile changes off, Seafile not linked, or Plan mode. These choices are not changed
for the user. Older stored tool lists keep their normal group migration; no new group is needed.
If a turn runs out of tool rounds, the agent is told that saving remains enabled and can continue
in the same thread on the next user message.

The parent folder must exist. The agent can discover it with `seafile_list`, or use
`seafile_mkdir` to create a folder you explicitly requested. It must ask when “Desktop” could
mean different libraries, this browser or the host computer. Once the Desktop destination is clear,
it should stay there, without probing unrelated locked libraries or asking for the same decision
again. A request to save under a named folder also requests its creation if absent; the normal
write approvals still apply. Separate saves can be batched in one tool round. Server tools cannot write browser-local
Files or the host Desktop; the manual Save to Files action remains available for browser storage.
An existing filename is refused unless you requested replacement and the tool sets `overwrite`.
The destination and linked account are checked again after approval. Seafile can rename a new
upload if another writer takes its name during transfer; the result reports the actual path and
a warning, rather than claiming the requested path was written. Nothing is automatically deleted
or retried. Results include the library, filename, byte count, PNG type and a private file link.
Transfers are limited to 20 MiB and 45 seconds, honour Stop, and report Seafile permission, lock,
authentication and storage errors. Cancellation cannot undo a file already accepted by Seafile;
check the destination before retrying an interrupted or unconfirmed upload. Saving does not change
the rule that a successful generation ends its turn silently.

After approval, the app reserves the resolved output aspect ratio in a larger responsive image
frame (up to 640 px wide). A themed 7×7 matrix of cubes animates while generation is active and
visible. Hidden windows/tabs and offscreen frames pause it; reduced-motion users get a static
matrix. The finished image uses exactly the same frame dimensions. Stop retains the existing
cancellation behavior; errors replace the pending status rather than leaving a fake progress image.

**What the agent will write.** Agents never filters a prompt, but the model reading it can still
refuse: Diffu gets away without saying so because its catalog is the only place adult material is
optional, while Agents talks to cloud models that decline an explicit request on their own. So the
system prompt states it: a prompt here goes to the user's own ComfyUI and nowhere else, adult
content is written when asked for (exact words and tags kept, no softening, euphemisms, warnings or
moralizing), and a refusal by the model is reported as the model's, never as a rule of the app. The
one limit, stated there too, is sexual content involving minors. Every thread gets that stance,
not only image ones; the **CONTENT AND REFUSALS** section carries the image-specific detail while
Images is on. A model or provider that filters on its side is out of the app's hands: switch the
thread's model in Settings → Agents. Agents itself talks only to Ollama Cloud, so the local
uncensored models Diffu can point at through its own providers are not reachable from Agents yet.

Successful image generation ends the turn without any assistant follow-up text or automatic vision
call. The app displays the image and settings; the CLI displays its private link. Tool batches that
include generation execute in order: after the first successful image, later calls receive explicit
skipped results, preserving the conversation protocol without running hidden work. Existing todos
remain for later turns; failed generation still follows the normal error/explanation flow.

On a later user turn, `view_generated_image` can inspect the latest image in the current thread,
or an explicit image ID from any of your own threads. It sends actual PNG bytes through Ollama's
`images` message field to the thread's selected vision-capable model in a dedicated bounded inspection
call, then returns that model's visual analysis. A text-only model is told to switch to a vision-capable
model; a URL alone is never presented as visual inspection. Input is limited to 8 MiB, instructions
to 2000 characters, and the call to 45 seconds with bounded output. Account ownership is checked
before reading bytes; omitting the ID still selects the latest image in the current thread. Existing
images remain inspectable after disconnecting ComfyUI. An empty or reasoning-only answer gets one
retry with thinking off and a larger answer allowance, within the same 45-second deadline. If that
also returns no text, the result names the model and says inspection failed; it does not blame the
image or contradict the model's vision capability. Inspection never silently generates, downloads models, changes settings, or guarantees an accurate diagnosis.

The initial presets follow Diffu's small ComfyUI workflow builders: SD 1.5 (512 px) and SDXL
(1024 px) use a complete checkpoint with its text encoder and VAE; Z-Image and Z-Image Turbo use
an installed diffusion model, a compatible `lumina2` text encoder and a separately selected VAE.
Z-Image Turbo uses 8 Euler/simple steps, CFG 1 and only a positive prompt; Z-Image uses 20 steps and CFG 4;
SD 1.5 uses 20 steps/CFG 7 and SDXL uses 25 steps/CFG 7, preferring DPM++ 2M/Karras.
A recognized Pony checkpoint follows Diffu’s 12 steps/CFG 5.5 recommendation. Sampler/scheduler
preferences fall back only to supported installed options. Choose the family that matches the actual model:
Krea2 Raw uses a separate diffusion model, `krea2` text encoder and VAE with 52 Euler/simple steps and CFG 3.5. Krea2 Turbo uses the same loader types with 8 Euler ancestral/beta steps, CFG 1 and zeroed negative conditioning (positive prompt only). These are text-to-image workflows; prompt enhancement, image-to-image and LoRAs are not included. Matching model, encoder and VAE files must be installed and resolved automatically or selected manually; filenames alone do not establish compatibility. Discovery reads only the ten required classes via ComfyUI's
`/object_info/{node_class}`, avoiding unrelated custom-node catalogs. Responses are limited to
1 MiB per node and 4 MiB total, with a 30-second discovery deadline and specific errors for
oversized metadata. Required models, nodes and sampler options are checked before submission. Flux, custom workflows,
image editing and model downloads are not included in these presets.

**Image observations** are short, cautious interpretations of evidence: your words about an image
or a vision model’s concrete defect report. The agent is told not to save its own guesses about
an image unless you explicitly ask. Notes may be wrong; they are never a ranking or a “best settings”
list. A profile holds the lasting preferences; observations supply evidence for it. Saving is on by
default, and writes do not ask for approval by default. Turn on **Ask before
saving an observation** in **Settings → Apps → Agents → Images** to make each write ask first,
except in Bypass; Plan never writes observations. Declining leaves the observation unsaved and
existing notes unchanged. This approval setting has no effect while saving is off. Turn off
**Save image observations** in **Settings → Apps → Agents → Images** to stop new notes and updates. This removes `save_image_learning` from the available
tools and rejects stale calls; it does not delete existing notes, stop their review before generation,
or change style profiles. Turn it back on to resume saving. Notes stay with your account on this
server under **Memory → Images/Learnings**, scoped to the backend and components (including the
LoRA list and weights). They are not published or sent elsewhere for storage; relevant notes are
read by your configured agent during later image tasks.

**The Observations overview** (**Settings → Apps → Agents → Images → Observations → Open…**, or
**Overview with filters and profiles…** under Memory's **Images/Learnings**) shows them readably.
Style profiles sit beside the list (above it, folded, on a phone): each with its name, full
description, observation count, when it last changed and the threads that pin it; pick one to see
only its observations. Each observation is a card: the picture as a thumbnail (tap for the full view;
“Gone” when its thread was deleted), the task, a source badge (**Yours** for your feedback,
**Vision** for a vision model's, **Automatic check** for the quality check's, **Agent’s own guess** for an unverified suggestion), its profile,
the date and the note in two lines. Opening a card shows the evidence quote, a settings line
(workflow · steps · CFG · sampler/scheduler · model file · LoRAs and weights), size and seed, and the
prompt behind **Show prompt**. Upscale observations show their operation and upscale model, with
each installed model kept distinct in the model filter. Filter by profile, source and model, search task and note; the count
says how many the filter hides. Delete one card, or select several and delete them; the OS dialog
asks first and says it removes the observation only, never the picture. With a keyboard: arrows,
Home and End move between cards, Enter opens one, Delete deletes it. Memory's own list shows each
observation as the same compact card instead of its stored text. A note in neither the structured
form nor the stored text format (an old or hand-edited one) shows as stored, marked **Unreadable**.
The overview reads `GET /api/agents/images/observations`: the newest 200 of the account's
observations, parsed, and every profile; it is read-only, and deletes use the memory route.

**Image learning and named style profiles:** a profile is the durable description of a look, shared
across your threads and projects. The agent is told to create one when a look to keep first appears
and update it as the look or feedback evolves, rather than accumulate per-image notes. Its description
should cover the look, prompting style and vocabulary, settings it tends to want, and traps, not a
list of images. A project-scoped memory note is for preferences specific to that project, with the
usual permission to remember them. Profiles organise preferences and evidence in the existing
account Memory store, under **Images/Profiles** and **Images/Learnings**. They are not a single
global “best settings” ranking. A profile's preferences have room for depth (up to 1,200 characters,
with a live count in the editor), so one the agent wrote can be edited by hand without being cut
short. Style profiles live in **Settings → Agents → Images → Style profiles** (every profile, whether you

confirmed it or the agent suggested it, its observation count, and New / Edit / Reset / Delete) and
in each thread's **Images** dialog, which pins one profile to that thread with a dropdown and offers
the same quick edits. Reset keeps the preferences and forgets the observations; delete removes the
profile and its observations. Both ask first. Changes save immediately. Deleting a profile clears its thread
pins. Ordinary image defaults and other memories are unchanged. The Memory view can inspect and
forget individual observations or profiles; structured evidence cannot be overwritten by its generic
text editor. Use the profile panel or image learning tools for typed edits.

CLI equivalents: `/images profile` lists profiles; `/images profile select <id|none>` pins one;
`/images profile save {"name":"My style","description":"My preferences"}` creates a user profile
(add `"id":123` to edit/rename). `/images profile reset <id>` forgets that profile’s observations;
`/images profile delete <id>` deletes it and its observations. `/memory` lists the full recorded
settings and evidence, `/memory rm <id>` forgets one record, and `/memory reset-images` forgets
all image observations while retaining profiles, preferences and image defaults.

The Images tools include `read_image_learnings`, `save_image_learning` and `save_image_profile`.
Reading returns at most 20 one-line profile summaries (name, up to 360 characters of description,
note count across backends and last touched time), the selected profile’s full description, and five
relevant observations (at most 12 KB of observation JSON). Each observation has a human-readable
settings line with preset, steps, CFG, sampler/scheduler, model, encoder/VAE and LoRAs with weights;
it does not repeat the stored prompt JSON. Notes are clipped to 240 characters and quotes to 160,
with their evidence message IDs and image IDs retained. Current-thread evidence quotes are limited
to 200 characters. User/vision evidence ranks ahead of unverified suggestions; old suggestions stay
readable. Full settings, prompts, notes and quotes remain unchanged in Memory storage. The user can
pin a profile, or the agent can
choose `profile_id` for one generation and explain why in `profile_reason`. There is no automatic
keyword classifier assigning styles. Profiles guide the agent’s validated per-call choices; they do
not silently replace saved account/session manual model selections. Explicit user requests take
priority. `read_image_learnings` can browse recipes across models within a chosen profile using
`all_models`; each recipe keeps its workflow and model/component settings, with long filenames
clipped to 160 characters in the settings line. Within each source tier, task/style words
only rank relevance of observations, never quality. No thumbnail, successful render or agent opinion
establishes which recipe the user likes best.

Before an image submission, the agent sees the relevant observations once per turn for its profile
and operation (generate, refine, hires or inpaint). Discovery (`list_image_models`) covers the
thread's profile for plain generation; `read_image_learnings` covers the profile and operation it
read, or every operation with `all_models`. If the agent calls generation without that, the call
returns `status: "review_once"` with the evidence (notes first), `submitted: false` and a note that
this is not an error; the next call submits. Changing components, LoRAs or the seed asks nothing
more; another profile or operation shows its own evidence once. A turn shows evidence at most twice:
after that every call submits and the server logs a warning, so it can never loop. Evidence counts as
shown once the next model call has gone out with it; a compaction in between folds it away, so it is
shown again. Evidence results (discovery, a read, a review) stay whole for the rest of their turn,
however many calls follow them, and
further calls in a gated batch are skipped with a note to call them again. Nothing carries over
between turns, so Retry, Rewind and clipped old results never hide it. The evidence lists earlier
vision reports and only those user messages that reply to or name an image of the thread (any of its
images, not only the latest five), as context, not as items to resolve. Upscale and removal skip the
review. Chat and terminal show it as "Showed image learnings; nothing submitted yet".
Failed validation can still be explained without submitting a job.

Learning is deliberate and evidence-based. On a later turn, user feedback or a concrete defect report
from `view_generated_image` can support `save_image_learning`, filed under the relevant profile.
Repeated feedback belongs in the profile description rather than another per-image note. The tool
still accepts an unverified suggestion for an explicit user request; this is guidance, not a server
claim that it can determine whether every interpretation is worth keeping. A new record references
a current-thread generated artifact;
its actual parameters and image ID are copied by the server, never supplied as invented settings.
Sources distinguish **unverified suggestion**, **vision observation**, and **quoted user feedback**.
Feedback/vision quotes must match an actual later message in that thread; vision must refer to the
same image. The agent’s note is explicitly an interpretation, including when feedback is negative
or mixed. The server verifies provenance, not whether an interpretation accurately understands
human taste. Updates change only note/task and preserve the original artifact/evidence; new feedback
gets a new record, so a successful job cannot overwrite confirmed evidence. Agent-created profile
preferences remain suggestions; user-edited preferences are protected against agent overwrites.
Observation writes use the account approval setting described above. Style-profile writes still
ask in Ask first/Auto/Edits allowed, are refused in Plan, and run in Bypass.

Records are owner-scoped and segregated by a private backend identity derived from the configured
endpoint and credentials, plus profile and exact model/component identifiers. Neither credentials,
hostnames nor that private identity are included in learning context or Memory text. Changing endpoint
or credentials isolates earlier recipes; restoring them restores that namespace. Replacing weights
behind the same identifiers cannot be detected: reset affected observations when doing so. Profiles
can retain separate recipes for several backends/models without mixing them. Older artifacts without
backend provenance cannot be retroactively assigned a guessed namespace. Existing notes retain
parameter/evidence snapshots if their source thread is later removed, until the user forgets them.

Limits: 20 profiles, 100 image observations and 1000 total memories per account; names 80 characters,
preferences 4,000 (tools, API, CLI and the profile editor, with a live count), task/style 160 and
notes/evidence quotes 500. Storage quota includes structured

records. Image memories are excluded from general system prompts and retrieved only through image
tools. No automatic quality scoring, background experiments or extra generation occurs. Technical
failures remain in tool history; durable quality-failure observations require an artifact. Successful
generation still ends silently, so learning happens on a later user turn, never as hidden follow-up.

**Per-generation tuning:** the agent can now select `preset`, `model`, `clip`, `vae`, `loras`, `steps`,
`cfg`, `sampler` and `scheduler`, as well as size and seed. Before this change, sampling was fixed
and the agent could only adjust prompt, size and seed. Precedence is explicit per-call value,
then session asset/size/seed override, then account assets and Diffu-grounded sampling/preset
size defaults. Sampling changes apply only to the current image; there is no silent save or import
of personal Diffu tuning presets. Empty asset strings opt that call into automatic selection.
For checkpoint workflows encoder/VAE are embedded, so separate component overrides do not
replace them. Changing the workflow does not erase explicit manual asset choices: supply matching
components or empty strings if moving to another family.

`list_image_models` reports effective settings, family recommendations, supported installed sampler/
scheduler options and up to 40 filenames per category (queryable, maximum 100). The agent is told
to discover once, prefer recommended defaults, preserve explicit user choices and tune only when
requested or clearly needed. Steps are integers from 1 to 80; CFG is finite from 0 to 20, with CFG
fixed at 1 for both Turbo workflows. Only the listed KSampler options are accepted. Denoise stays
1 for text-to-image; arbitrary graphs, backend settings, model downloads, batch generation,
prompt enhancement, LoRAs and upscaling are not tool options.

**Model details (`model_details`)** give the agent a recipe per model instead of one per preset.
It is a read-only Images tool, with no approval card: `name` (an exact installed identifier) returns
the facts for that checkpoint, diffusion model, LoRA or embedding, and `kind` + `query` searches the
installed ones by name, tag or base model (up to 10 matches, each with its base model and tags).
The facts come from three places:

- **LoRA Manager** (optional, on the account's ComfyUI): base model, tags, auto tags, trained words,
  usage tips (a LoRA's recommended strength), notes and its Civitai IDs and file hash. All three
  lists are paged (100 a page; at most 30 pages, 3000 records read and 16 MiB per list, each bound
  on its own), cached for 30 minutes per backend (a minute when any page after the first failed, was
  malformed or timed out, keeping what it read; only a missing first page means LoRA Manager is absent), and joined to ComfyUI's installed names by exact folder and file name only.
- **Civitai** (when **Look up model details on Civitai** is on): the version's base model, trained
  words and description (HTML stripped, 3000 characters), the model page's description (1500), two
  or three short example prompts, and the settings its example pictures agree on: the most common
  sampler and schedule, the median steps, CFG and clip skip, and the usual size. A1111 names map to
  ComfyUI's (`DPM++ 2M` + `Karras` and `DPM++ 2M Karras` both become `dpmpp_2m`/`karras`, `Euler a`
  becomes `euler_ancestral`), and only when that sampler is installed and this app runs it;
  otherwise the consensus says it is unmapped. Lookups go by Civitai version ID, else by file hash,
  only to `https://civitai.com` (a redirect anywhere else is refused, not followed), with a 5 second
  timeout and a 1 MiB cap. Answers are cached in the database for 7 days, and a confirmed 404 ("not
  on Civitai") for a day; timeouts, 5xx, 429, 401 and 403 are not cached and the lookup says it is
  partial or failed.
  Anonymous answers are shared; answers fetched with an account's key are kept under an HMAC of
  that account and key (never the key itself), so no other account or key is served them.
- **Family defaults** (`src/data/modelFamilies.ts`), keyed by base model: Illustrious and NoobAI
  (Euler a or DPM++ 2M Karras, about 26 steps, CFG 5, clip skip 2), Pony (needs score tags),
  SDXL, SD 1.5, Krea 2 turbo and raw, Z-Image and Z-Image Turbo (CFG 1, few steps). Flux, Anima and
  MiniMax H3 are reported as not supported here.

The result's `recommended` block (preset, sampler, scheduler, steps, CFG, clip skip, size) says its
`source`: `civitai_examples` with how many pictures agree, `family_default`, or `user_saved` for a
size the thread saved. The Civitai consensus wins over the family default, and the user's explicit
request wins over both. For a raw/turbo split (Krea 2, Z-Image) the thread's preset decides the
variant, and example settings from the other variant (turbo steps on a raw preset, or the reverse)
are not used; a note says so. LoRAs get a recommended strength (usage tips, then their own weight in the
example pictures: a resource entry with their Civitai version ID, or a resource or `<lora:NAME:w>`
tag whose name is their file; none when that cannot be told), their trained words, and whether they match the selected model's family. The
agent calls `model_details` once before the first generation with a model or LoRA it has not used
in the thread. `list_image_models` also gives every listed model and LoRA its base model, family
and top tags (`assetFacts`), so the agent can pick a model by style. The model browser's details
pane shows the same facts (`GET /api/agents/images/model-details`), and chat and the terminal show
one line per call: model, family, recommended settings and source.

`generate_image` takes `clip_skip` (1 to 4, checkpoints only; `CLIPSetLastLayer`). A
**v-prediction** checkpoint (NoobAI v-pred and its merges) gets `ModelSamplingDiscrete` with
`v_prediction` and `zsnr` automatically, but only on affirmative evidence about that file or
version: "vpred"/"v-pred" in the file name (its stem, never its folders), the Civitai version name, a plain statement in the
version's own description, or LoRA Manager's base model label. Eps evidence there ("eps",
"epsilon", "not v-pred", even in a sentence that also mentions v-pred) always prevents it, since running an eps model as v-pred ruins every
picture. The model page, model title and model tags never apply it; when they mention v-pred,
`model_details` only adds a note. The server decides this, never the tool call, with the same
detector and cached Civitai facts as `model_details` (and, like it, none of them while Civitai
lookups are off). When detection is wrong, the model browser's
details pane has **Prediction: Auto / v-pred / eps** for each checkpoint (diffusion-model workflows
never apply v-prediction, so they have no such setting, and a v-pred diffusion model is reported as
unsupported): your setting, saved per
account and per model file in the image settings, wins over detection, and `model_details` reports
it as `source: user_override`. The agent cannot change it. Without that node the model is
reported as unsupported and generation is refused, as it would render garbage.

**Quality check** (**Check images and retry once if clearly broken**, on by default). After each
generated, refined or inpainted picture the server checks it: first the pixels (almost all black,
white or one flat colour, or noise across the whole frame, on a sampled grid of rows and columns;
pictures under 64 pixels a side are skipped, and above about 4 megapixels only vision judges), then, if those pass and one of the account's models can see pictures, one capped call
to the cheapest of them (the safety check model, the quick model, the title model, then the
thread's own) with a fixed rubric that returns a score, `very_bad` and defects. Only broken output
counts as very bad: melted faces or anatomy, mush, noise, a clearly wrong subject. Style and
mediocre quality never do. A fine or mediocre picture ends the turn silently as before. A very bad
one comes back to the agent with `quality: { very_bad, score, defects }` and one retry allowed:
it tells the user in a sentence what was wrong and what it changes, and generates once more with
better settings (the model's recommended ones, another sampler, more steps, a CFG fix, another
model of the same family). The server allows one automatic retry per user message and refuses a
third generation; if the retry is broken too, the agent explains instead. A retry counts as fixed
only when the same kind of check that flagged the first picture passes it; a vision check that
fails or times out is inconclusive, and the retry's result keeps the first attempt's defects. After
a retry that is broken too or could not be confirmed, the agent gets one more reply without tools
to tell the user (any tool call in it is dropped and the turn ends there), and the chat card and terminal say "Retried once; couldn't confirm the new image
is fixed" with the first picture's defects. Very bad results and
retries that fixed one are saved as image observations with the source **Automatic check** (while
saving is on and observations do not ask first). Upscales and LaMa removals are not checked.

**Settings → Agents → Images → Model details and quality** holds both switches and an optional
**Civitai API key** (stored encrypted like the ComfyUI token, sent only to civitai.com as a Bearer
header). Civitai lookups send the model's Civitai ID or file hash, never prompts, pictures or the
ComfyUI address. Without a key, Civitai hides NSFW example pictures, so some models have fewer
example settings. The Overview card says "checks pictures" while the quality check is on.

Approvals show the complete resolved model/components, prompt, negative prompt, dimensions,
steps, CFG, sampler/scheduler and seed. Those settings are frozen before approval; changing saved
settings while waiting cannot widen the approved cost. Changing backend credentials invalidates
the plan and requires a new call. Bypass retains its explicit no-approval behavior.
The tool result, app’s **Generation settings** details, CLI output and private downloadable JSON
record the actual settings, including prompts. Metadata survives restarts with the image; older
images may have no metadata. Reproducing a result also requires the same backend/model weights.

Poor output is not always a sampling problem. A wrong VAE/encoder or Raw/Turbo mismatch can
break output; a compatible VAE swap is not a guaranteed quality improvement. Start with the
recommended workflow, a known compatible model and a fixed seed. Ask for one controlled change
(e.g. “keep this model and seed; use 32 steps and CFG 4.5”) and compare its recorded settings.
Higher steps cost more and are not automatically better, especially with distilled Turbo models.
These defaults are supported starting points, not GPU-tested quality guarantees for custom models.

Model browsers and account/session selectors use the available window width, with aligned controls
and horizontally readable long filenames. Visible model rows lazily request artwork. If the optional
ComfyUI LoRA Manager extension is installed, Agents searches one bounded page for an exact
catalog category, folder and filename match, showing its real title, base-model label, file size,
tags and sidecar PNG/JPEG/WebP preview. It never guesses compatibility from those labels.
Plain ComfyUI, missing artwork, ambiguous matches, encoders and VAEs show a neutral fallback.
No extension installation is required. Metadata requests are capped at 1 MiB and ten seconds;
artwork is capped at 5 MiB and ten seconds. Preview handles expire after five minutes, are private
to the account and bound to its current backend credentials. The server checks the installed
catalog identity and sidecar path, applies the same egress protections as generation, and proxies
image bytes without exposing backend paths, URLs or tokens. Remote preview URLs and video
artwork are not supported; refresh the browser if a preview handle expires.

Each call makes one PNG. Width/height can be requested in multiples of 64 from 256 to 1536,
with at most 1536 × 1024 pixels; the result includes a reproducible seed. One generation runs per
account at a time, with a ten-minute deadline and a 20 MB output limit. While it runs, a flat grid of blocks fills in with live progress (queue position, model loading, step and percentage, also on the CLI's status line), read from ComfyUI's `/ws` socket for that prompt only ([`server/comfyProgress.ts`](server/comfyProgress.ts)), sent at most 4 times a second to the owner's thread, falling back to `/queue` polling without the socket. Stop/Esc stops waiting and
removes that prompt from ComfyUI's pending queue. An already running GPU job may finish there;
Agents never sends a global interrupt that could stop someone else's job, and cancelled output is
not stored. Errors appear in the existing tool card and CLI output. Successful PNGs live in the
server database, survive restarts and backend cleanup, count toward the account's storage quota,
and are deleted with their thread unless a branch still references them. Branches share the same
private image ID and stored bytes; deleting the original transfers retained images to a surviving
branch. The last referencing thread’s deletion reclaims that storage. Rewinding a conversation does
not reclaim its generated images. `pnpm check:agents-images` exercises generation with
mock ComfyUI/Ollama, permissions, owner-only downloads, cancellation, quota accounting and failures
without running a GPU job. `pnpm check:agents-image-files` checks exact PNG transfers to a mock
Seafile, destination validation, ownership, approval, replacement, quota failures and cancellation
with scratch accounts only. It also runs a plain save request through current-image discovery,
folder discovery, requested folder creation and four binary saves in an older eligible thread,
with the same tool definitions, approval events and round limit used by the app and CLI.

**First titles.** A new thread is named from your first message straight away, while the answer
is still being written, so the sidebar is never empty. When the title model gives nothing usable,
the first line of prose in the message stands in (code fences and what is in them, blank lines and
lines of only symbols are skipped), else the attached files' names, else *Code snippet*. Once the
first answer is in (the first turn that answers: a failed or stopped first turn, a Retry or a
server restart in between do not lose it), the title model names the thread once more from
question and answer, and the title changes when that one is different, as long as it is still that
first automatic title (`title_source` is `first` until then). A rename, *Regenerate title* or a
check that writes the title in the meantime always wins, also when it gave the same title: every
title write counts up a revision, and a background namer only writes when it has not moved since it
started. Spotlight's quick threads are left alone. The
title model's answer is read leniently: thinking and markdown code fences are dropped and the
`{"title": …}` object is found inside any text around it, and a candidate without a letter or a
digit (a bare code fence, `...`, `---`) is never a title.

**Titles keep up to date** (Settings → Agents → Models → *Thread titles*, on by default). A first
title names how a thread started, and threads wander, so every few of your messages (3, 4, 6 or 10;
3 by default, sooner when a thread grows by more than about 24,000 characters over at least two
messages) the server asks the title model once more, after the turn has answered (also when it
ended in a generated image) and without holding up the answer or the next queued message. It gets
the current title, how the thread started (your first message) and a small digest of the latest
exchanges (your last few messages and the start of each answer; no tool results, thinking or files
beyond their names) and answers `{"keep": true}` or `{"title": "…"}`, read as leniently as a first
title. It keeps the title while it still names the main subject (a follow-up or a deeper question
keeps it), and changes it when it no longer names what the conversation is mainly about, or when
it is vague, generic or not a real title. An answer it cannot read keeps the title. A failed
check is only logged, and waits as long as a normal one before it is tried again. A title you set yourself (renaming in the app, or `/rename`)
is never changed automatically; *Regenerate title* (the thread's ⋯ menu, its right-click menu in
the sidebar or the conversation, `/title regen` in the terminal) asks for a fresh title for what the
thread talks about now, saves it straight away and hands the title back to the automatic check. Old
titles stay on the thread as aliases (the last five, with when each was replaced): hovering a thread
in the sidebar, or the title over the conversation, shows *Also known as: …*, and the sidebar's
search, `/resume` and `agents -r` find threads by them too. The thread's columns are `title_source`
(`user` when renamed by hand), `title_history` (JSON `[{title, until}]`, newest first) and
`title_mark` (the last message id when the title was last decided on, which the check counts
from); the thread carries them as `titleSource`, `aliases` and, while a check runs, `checkingTitle`
(windows look again until it is done, and a change streams as a `thread` event when the turn's
stream is still open). `POST /api/agents/threads/:id/retitle` regenerates and answers `{thread}`;
`…/title` still only suggests one for the rename box.

While a turn runs, Enter in the composer queues the message (files and all) instead: queued
messages sit over the composer in order, each with *Edit* (it goes back into the message box, files
included; ↑ in an empty box edits the last one, Esc puts it back), *Send now* and remove. The
server keeps the queue with the thread (column `queue`), so it survives closing the window: when a
turn ends with an answer, the server sends the next queued message as the next turn by itself, on
the same stream, one at a time. A turn that fails or is stopped leaves the queue waiting, with
*Send queued*. The queue holds still while a message in it is being edited (a window that goes away
mid-edit lets it go on after two minutes). *Send now* stops the running turn (as Stop does: what it
finished stays saved) and sends that message next, ahead of the rest. While the agent waits on you
(changes to allow, a plan, a form), the composer says *Tell it what to do instead…* and *Send
instead*: the message declines every waiting change with it as the reason, or answers the form
with it, and the turn goes on with the model reading it; *Send now* on a queued message does the
same then. A message with files can't be an answer, so it stops the turn and goes next. Windows and
terminals on the same thread see the same queue (`queue` events on the turn's stream). The
endpoints are `POST /api/agents/threads/:id/queue` and `/override`, `PATCH` and `DELETE
…/queue/:qid` (`editing: true` holds the queue and returns the whole message) and `POST
…/queue/:qid/send` (Send now) and `/move`.

A turn that does not end with an answer says how it ended, with **Retry**: *Interrupted: the
server restarted (an update)*, *Interrupted: the server stopped unexpectedly*, an error, or
*Stopped* (the thread's `interrupted`, saved with it). On SIGTERM (a deploy; Docker waits about 10
seconds) the server keeps the reply each running turn was writing, answers its unfinished tool calls
with "the server restarted", and marks the thread; a thread still marked as running when the server
starts (`turn_at`) was cut off by a crash or a kill and is marked that way. Queued messages wait
after a restart, for *Send queued*. [`server/shutdown.ts`](server/shutdown.ts) runs every part's
shutdown hook (Agents turns, Empires battles) from one signal handler. When a turn's stream drops,
the window first looks for the turn again, a little slower each time, for a minute (*Reconnecting…*),
picking it up where it is if it still runs; only then does it say *The connection dropped*, with
Retry and Look again. A message that never got there goes back into the box. Retry (`POST
…/retry`, streamed like a message) is also in the last answer's action row, between Share and
Options (in the image's row when the turn ended with an image and no text), to have it written
again; a turn that left nothing to put it under keeps a quiet Retry line below it: the
last turn's output (a partial or failed reply, its tool calls and results, or the answer) goes and
the same message, with its files, is answered again with the thread's model, mode and tools; queued
messages run after it. Every message and card has the same quiet action row on its own side (right
under your messages, left under answers, tool cards, images and summaries), in the same order: its
own actions where it has them (**Share** on an answer; **Save to Files…** and **Generate another**
on an image), then **Options** last, a menu with hints for the rest. On a desktop a row shows only
while the pointer is over its own message or something in it has keyboard focus; it keeps its
space, so nothing moves. On touch it is always shown. Your messages' **Options** has **Copy**, **Edit & resend** and **Rewind to
here** (also in their right-click menu): after a desktop dialog that says how many
messages go, it and everything after it leave the thread (`POST …/rewind`; a running turn is
stopped first, the queue stays) and it comes back into the message box with its files. What the
tools did is not undone: memories, the plan, notes, calendar events and files the agent changed in
the work folder stay as they are.

**Branch off from here** is in each message’s Options menu and right-click menu. It opens a new thread containing every message through that point, including
files, thoughts, tool results and compaction summaries. The original stays unchanged. Mode, model,
tools, project, work folder, permission and image settings/profile carry over; queues and pending
approvals do not. Account/project memories remain shared. The title is `<original title> — from
YYYY-MM-DD`, using the selected message’s UTC date, with the original title kept in its history.
It is treated as a manual title. Wait for a running thread to finish before branching. The terminal
has `/branch [message id]`; omitting the id branches from its last message.

**Generate another** sits in an image’s action row, before **Options**, and in its right-click menu.
It draws another image in the same thread with the same prompt, components, LoRAs, sampling and
size, without asking the model or showing an approval card. It uses the usual progress and Stop
controls, account job limit and storage quota. Images must be on in Tools, ComfyUI must be connected,
and the recorded components must still be installed; a missing component is named in the error.
Retry after this action repeats it directly. Both actions work with keyboard controls and touch.

**Upscale an image.** Choose **Options → Upscale…**, browse the installed upscale models by
folder or search, select a model, and choose 1.5×, 2× or 4×. The preview shows the final dimensions
with the source aspect ratio preserved; outputs above 4096 px per side or 16,777,216 pixels are
blocked. No prompt or diffusion settings are needed. The model's native intermediate image can
exceed the requested output size, so the output limit is not a memory guarantee. Sources above
2048 px per side must be resized separately before upscaling; original pixels are never silently
reduced. **Upscale settings** records the source and model input dimensions. Upscaled results have
no seed. **Upscale again** repeats the recorded
operation from its original source rather than enlarging the enlarged result. Progress and Stop
work like Generate another, and the terminal labels upscale results and settings explicitly.
Upscale observations retain their operation and exact upscale model. `read_image_learnings` with
`operation: "upscale"` retrieves those notes (optionally filtered by `upscale_model`);
`all_models: true` can include all operations. Default diffusion evidence excludes upscale notes.

**Refine an existing image or generate with hires.** Refinement uses diffusion to add or change
fine detail. `generate_image` with `operation: "refine"` starts from an owned source, inherits its
recorded diffusion components, prompts, LoRAs, sampling and seed, then applies explicit overrides.
If the source was model-upscaled, the server follows owned provenance to its diffusion ancestor
(up to eight images, rejecting cycles and foreign or missing ancestors). A source without saved
diffusion settings requires an explicit prompt and compatible configured components; no prompt
is invented. The original image is never changed.

Refinement defaults to 1.5× and denoise 0.2; scale 1–2 or explicit dimensions are accepted. Sizes
round to a 64-pixel grid from 256 to 2048 per side, with at most 4,194,304 pixels. Lanczos resize
with center crop fits the requested shape, so grid rounding can trim edges. An optional installed
`upscale_model` enlarges pixels before encoding; that model stage accepts sources up to 2048 per
side and retains the native-intermediate memory caveat above. Refinement does not require an
upscale model. Turbo CFG remains 1; Krea2 always requires model-only LoRAs.

For new generation, `hires: { scale: 1.5, denoise: 0.2 }` adds a second image-space diffusion pass.
The first pass uses ordinary generation limits; the second uses refinement limits, the same
components, conditioning and seed, and its own optional steps/CFG/sampler/scheduler/upscale model.
Only the final image is saved. Approval shows both stages; metadata records base and final sizes
and resolved stage settings. Generate another reconstructs both stages with a fresh shared seed,
without applying the scale twice. Refine again starts from the original source with a fresh seed.
The existing optional generation approval, Stop, quota, private storage and silent-success rules
apply. Refinement and hires observations retain their operation, separate from ordinary generation
and model-upscale evidence. These workflows do not implement masked inpainting.

**Refine an image.** Choose **Options → Refine…** for a diffusion pass over an existing image.
Choose 1×, 1.5× (default), 2×, or custom dimensions, and strength from 0.1 to 1 (default 0.2).
Higher strength can change details and composition. Scale rounds each side to the nearest 64 px,
so the aspect ratio is approximate; custom dimensions can crop. Outputs must be multiples of 64,
256–2048 px per side, at most 4,194,304 pixels. An optional upscale model runs before diffusion;
its intermediate size and memory needs can exceed the requested output.
The nearest owned diffusion source supplies the prompt, components and sampling. The dialog can
override the prompt and, under **Advanced components and sampling**, the workflow, model,
encoder, VAE, steps, CFG, sampler and scheduler. Images without recorded diffusion settings need
an explicit prompt and configured components; the backend never invents a missing prompt.
**Refinement settings** records the operation. Observations retain refinement strength and the
full hires stage settings, with separate workflow labels and model filters. **Refine again** starts from the original source
with a fresh seed. Progress and Stop work as for other image operations.

For a new image with a second hires pass, ask the agent in the composer or terminal, for example:
“Generate a lighthouse, then apply a 1.5× hires pass at strength 0.2.” The `generate_image` tool
accepts `hires: {scale: 1.5, denoise: 0.2}` with optional upscaler and sampling overrides.
**Generation and hires settings** records both stages and the final image dimensions;
**Generate another** repeats both stages. This does not change the session's saved defaults.

**Compaction** ([`server/agents.ts`](server/agents.ts)): a long thread outgrows the model's context
window, so it can be compacted. The thread's own model writes a structured summary of the
conversation so far (the user's goals and requests, decisions, files and paths, the current state,
open todos, errors and their fixes, the next step), which is saved in the thread as a boundary: a
message with role `compact` (column `compact` holds how it came about). From then on each model
call sends the system prompt, the summary (as a note from the app) and only the messages after the
boundary; compacting again summarises the earlier summary with what came after it. Everything that
is not a message reaches the model as before, in the system prompt: the todo list, plan mode and
the permission mode, the work folder and its AGENTS.md, memory and skills. Files attached before the
boundary are named in the note (their contents go), and a compaction in the middle of a turn keeps
the message it was working on word for word. Ask for one with `/compact` (in the composer, with a
suggestion as you type it, or the agents command), *Compact conversation…* in the thread's menus
(with a box for what to keep) or *Compact now…* in the context breakdown; text after `/compact`
steers what the summary keeps, as in Claude Code. It is sent like a message, so while a turn runs
it waits in the queue (a `/compact` message to a thread that is answering gets 409, like any
message), and one with nothing new since the last boundary does nothing. By itself (Settings →
Agents → New threads → *Long threads*: on by default, at 85% of the window, 60 to 95% or off): a
message that would take the estimate past the threshold compacts what came before it first, so the
turn starts with the message and its files whole; within a turn, a model call past it compacts the
turn's work so far; and a call the model refuses as too long is compacted and tried once more. The
conversation keeps every message, with a *Conversation compacted* divider that opens to the
summary; the context breakdown shows the summary as a part of its own, marks the threshold on its
bar and says when the thread was last compacted. How it fits with the rest: **Retry** after a
compaction answers the last message again, and a compaction after that message goes with it; Retry
after a `/compact` that failed or was cut short (the thread's `interrupted` carries `compact`)
compacts again and removes nothing. **Rewind** to a message before a boundary removes the
compaction too, since it summarised messages that are gone, so the model gets the messages before
it as they are again; rewinding to one after it keeps it. **Shared links** never carry a summary
(it can hold what tools returned): they show the messages as before. **Spotlight**'s quick answers
are threads like any other and compact the same way; the answer it shows is the agent's, never the
summary. A **restart** keeps every boundary (they are messages); a restart in the middle of a
`/compact` leaves the thread as it was, with Retry to compact again.

```sh
pnpm check:agents-compact   # /compact with and without instructions, what the next call gets, the threshold, a too-long refusal, /compact while a turn runs, Retry, Rewind, shares, a restart
```

**Pictures** you attach show as thumbnails in the message box and on your sent messages
([`src/apps/AgentsImages.tsx`](src/apps/AgentsImages.tsx)); other files stay chips with their name.
A click opens the picture over the window: ← and → (or a swipe) go through the message's pictures,
Esc or a click beside it closes it, and it has *Download* and, for a sent picture, *Open in
Preview*. The server keeps a picture's bytes with its message anyway (vision models get them on
every turn), so a thread opened later shows them again: `GET
…/messages/:mid/attachments/:index` serves one to the thread's owner, as the picture types it knows
or as plain bytes otherwise, never rendered as a page. Preview opens such an address with props
`src`, `name` and `from` instead of a file path. Shared links still carry only names and sizes.

**Shared links** ([`server/shares.ts`](server/shares.ts), [`src/apps/AgentsShare.tsx`](src/apps/AgentsShare.tsx)):
*Share thread…* (the thread's ⋯ menu, its right-click menu in the sidebar or the conversation) and
**Share** in the action row under each final answer (on hover or focus, always on touch) make a link to the whole thread or to one
answer with the message it answers. A link is a snapshot taken then: later messages, a rewind or a
retry don't change it. It can expire after 1 hour, 1 day, 7 days or 30 days, or never (the
default). The dialog shows the links the thread or answer has already (Copy, Open, *Stop
sharing*) before offering *New link*, and Settings → Agents → *Shared links* lists them all.
Opening one (`/s/<token>`, 144 random bits, the only way in; nothing lists them) shows a plain page
the server renders itself, not MvL OS: the title, the date and expiry, your messages as bubbles and
the answers as Markdown (the app's own parser, turned into HTML in which every piece of text is
escaped; links only to http(s) and mail, pictures only from https and data:). What goes in: the
title, the model, your messages (attached files by name and size only) and the answers; tool calls
only as labels that name nothing they were given (*Searched notes*, *Looked at the calendar*),
except a web search's query and the site a page was read from. Tool results, thinking, memories and
the plan are never copied. The page runs no script: `Content-Security-Policy: default-src 'none';
style-src 'nonce-…'; img-src https: data:`, `X-Robots-Tag: noindex, nofollow`, `Referrer-Policy:
no-referrer`, `Cache-Control: private, max-age=60`, and it sets and reads no cookies. A link that
never existed, expired or was revoked is the same 404. Stopping sharing deletes the snapshot,
expired ones are deleted when shares are next touched, and deleting the thread or the account
deletes its links. The endpoints are `POST /api/agents/threads/:id/share` (`{kind: "thread" |
"response", messageId?, expires?: "never" | "1h" | "1d" | "7d" | "30d"}`, answering `{token, url,
expiresAt, …}` with the address from `PUBLIC_URL`), `GET /api/agents/shares` (`?thread=` for one
thread's) and `DELETE /api/agents/shares/:token`.
Settings → Agents (also the app's ⚙) picks the model for Quick, Deep and titles, whether titles
keep up to date (and how often they are checked), what a new thread starts with, whether and when long threads compact by themselves, and shows the system prompt: `~/AGENTS.md`, your own from Seafile when Seafile is
home, otherwise a read-only built-in one ([`src/data/agentsPrompt.ts`](src/data/agentsPrompt.ts)).
It opens on an *Overview*: one card per section with a line on how it is set up (ComfyUI not connected, Ollama Cloud missing a key and failed checks are marked), and a card opens its section; the sections are grouped (Models & threads, Safety, Tools, Sharing) in a list on the left when there is room, and in one dropdown on a phone.
Spotlight takes questions too: *Ask Agents* is under the web search, and a `?` in front makes it
the top hit. `OLLAMA_URL` points it at a stand-in for ollama.com when testing.

The Calendar tools ([`server/agentCalendar.ts`](server/agentCalendar.ts)) work on the calendars
connected in Settings → Integrations → Calendars, Google and CalDAV, shared ones included, through the same
code as the Calendar app: `calendar_list_calendars` (ids, names, accounts, which can be changed,
whose they are, the default for new events), `calendar_list_events` (a range, by default the next
14 days, with an optional text search over title, description and place), and
`calendar_create_event`, `calendar_update_event` (only the fields given) and `calendar_delete_event`.
Changes always wait for *Allow*, in every permission mode (plan mode doesn't offer them), and the
card says what happens: the calendar, the event, the time and what changes. A new event can repeat
(an RRULE); for one occurrence of a repeating event a change or a delete is that occurrence's alone
unless the agent asks for the whole series. The window sends its time zone with each message, so the
agent knows today's date and the time where you are, and times go both ways in that zone. Google
connections from before editing existed are read-only: the agent says to connect Google again. The
group is only offered with a calendar connected.

The Mail tools ([`server/agentMail.ts`](server/agentMail.ts)) work on the JMAP accounts linked in
Settings → Integrations → Mail (Fastmail and other JMAP servers), through the same code as the Mail
app ([`server/jmap.ts`](server/jmap.ts)): `mail_list_accounts` (accounts, send-as addresses,
mailboxes), `mail_search` (the Mail app's search syntax, in one account or all of them),
`mail_read` (a message or a whole conversation as plain text: no HTML, no pictures, nothing marked
read), `mail_draft` and `mail_send` (new, reply or forward, threaded) and `mail_update` (archive,
trash, move, read/unread, flag, junk; nothing deleted for good). Every mail call waits for *Allow*,
searches and reads too, in every permission mode, Auto, Edits allowed and Bypass included (plan mode
offers only the reads, which ask as well), and no "allow from now on" reaches it. The one way
round it is on a search or read card: *Allow mail reads for 15 min* lets `mail_list_accounts`,
`mail_search` and `mail_read` run without a card in that thread only, in every mode, for 15 minutes
from then (kept on the server, which checks the time; a restart ends it). The thread shows a chip
with the minutes left and an × to end it early (`DELETE /api/agents/threads/:id/mail-reads`), and
the prompt says so; drafts, sends and changes ask every time all the same. Or for good: Settings →
Agents → Permissions has *Mail searches and reads: Ask (default) / Always allow*, per user (table
`agent_mail_reads`, `GET`/`PUT /api/agents/mail-reads`), also set by the quieter *Always allow mail
reads* on a read's card. With it on, reads run without a card in every thread and mode, the
15-minute button goes away and the thread's chip says *Mail reads always allowed* (it opens that
setting); drafts, sends and changes still ask, Bypass included. Each call is
checked first (the account, the ids, the recipients, the mailbox) and the card shows what will
happen: for a send the account, From, To, Cc, Bcc, Subject and the whole text that goes out.
Message ids are the account's number and the server's own id, so they only resolve within your own
accounts. What mail says comes back marked as third-party content, never instructions. The group is
on by default (threads from before it too) and offered once an account is linked; the prompt names
the accounts. `pnpm check:agents-mail` checks it against the JMAP stand-in.

With the Notes group on too, the agent can work with notes linked to events
([`server/agentNoteLinks.ts`](server/agentNoteLinks.ts), see *Notes and calendar events* below):
`make_meeting_note` (a meeting note for an event, already linked: "make notes for my 2pm meeting"
finds the event with `calendar_list_events` first), `link_note_to_event` and
`unlink_note_from_event`, and, only looking, `notes_for_event` and `events_for_note`.
`calendar_list_events` says how many notes each event has (`linked_notes`). Linking mails nobody and
only adds a private backlink to the event, but it is written into the event, so the three that
change things ask in every mode (Auto, Edits allowed and Bypass too), like the other calendar tools;
`notes_for_event` and `events_for_note` only read and run without asking. Plan mode doesn't offer
the changing ones. Their cards say which note and which event.

Web fetch reads an address straight away only when it came from outside the model: your own
messages, search results, or the links of a page it already read, exactly as given. Any other
address waits for *Allow*, shown in full, while the thread holds anything private (memories, notes,
calendars, code, Seafile, attachments): a page could otherwise talk the agent into "reading"
`https://someone.example/?d=<your notes>`.

**Push notifications** ([`server/webpush.ts`](server/webpush.ts), [`src/os/push.ts`](src/os/push.ts)):
Settings → Notifications → *Push notifications on this device* subscribes the browser, or the
installed app (on iPhone and iPad from iOS 16.4, once MvL OS is added to the Home Screen and opened
from there). When an Agents answer is in, or the agent waits for an *Allow* or a form, and no
window is watching that thread, the server sends it as Web Push (VAPID, RFC 8292; encrypted per
RFC 8291, checked by `pnpm check:push` against the RFC's example), with no dependencies. Tapping
it opens the thread, and any push opens what it is about: a task reminder that task, new mail that
message ([`src/os/openUrl.ts`](src/os/openUrl.ts) takes only what each app allows from the address). The server's keys are `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`, or generated
once into `DATA_DIR/vapid.json` (keep it: new keys mean every device has to turn push on again);
`VAPID_SUBJECT` (a `mailto:` or `https:` address) defaults to `PUBLIC_URL`. Subscriptions are only
accepted for the browsers' push services (Google, Mozilla, Apple, Microsoft).

**The notification hub** ([`server/notifier.ts`](server/notifier.ts), its watchers in
[`server/watchers.ts`](server/watchers.ts)): every notification for an account goes through one
place. It drops what Settings → Notifications switched off (the choices sync, so the server reads
them) and what was sent before, keeps the rest in the account's list (the bell, the same on every
device), sends it live to the account's open pages (`/api/notifications/stream`, which show it as a
pop-up when one is in view; pages say whether they are with a heartbeat), and pushes it when no
page is in view, unless do not disturb is on. Apps hand notifications in two ways: when something
happens (`notify()`: an Agents answer or question, a finished unpack), or from a watcher that looks
every so often (`registerWatcher()`): the Minecraft server (from its pinger), new activity on
GitHub and git.mvl.sh (every 5 minutes, each item once, back as far as Settings says), calendar
reminders (Google and CalDAV, read every 5 minutes, a reminder 0–30 minutes before an event) and due
tasks (see Tasks above). The
list of sources and the rules for the choices are one file both sides import
([`src/data/notifySources.ts`](src/data/notifySources.ts)), so Settings lists exactly what the
server can send. Signed out, a visitor's pop-ups and list stay in that browser, from the page's
own watchers. `NOTIFY_WATCH=off` leaves the watchers off.

The **Code inbox** widget lists pull requests waiting for your review, your own open pull requests
and issues assigned to you, on GitHub and linked Gitea/Forgejo instances
([`server/inbox.ts`](server/inbox.ts)), with the access sign-in and linking already give.
Clicking an entry opens it in the Git app; when the app can't load it (no access, a host it doesn't
know, no answer within a few seconds) it opens on the web instead. Ctrl-, Shift- and middle-clicks
still open the web page in a new tab.

## Photos

**Photos** ([`src/apps/photos`](src/apps/photos)) is a timeline of the photos and videos in your
Seafile folders or your Immich library, by the day they were taken: months and days, newest first,
with the years down the right edge to drag through. Ctrl+wheel, a pinch or the − and + buttons
change the size of the squares. A photo opens in a lightbox: the arrow keys, a swipe or the side
buttons go through the timeline, the wheel, a pinch, double-click, + and − zoom towards the pointer
(drag to pan), I shows the details (when it was taken, camera, lens, exposure, size, and the
coordinates when it has GPS: no map service is asked), the full stop makes it a favourite, and
Escape or a swipe down goes back. Download, *Show in Files* (Seafile) and *Open in Immich* are in
its bar; videos play in Player. *Albums* are the Seafile folders you chose, or Immich's albums;
*Favourites* are kept in this server's database for Seafile and in Immich for Immich. With both set
up, Seafile | Immich in the toolbar switches between them (remembered for your account); they are
not mixed into one timeline. The grid only puts the rows on screen in the page, so 20,000 photos
scroll like 20; thumbnails load six at a time, the newest wish first, and the browser keeps them.

**Selecting** is explicit, as in Google Photos and Immich: a click (or tap) opens a photo, and the
circle that shows on each tile on hover selects it instead. Once anything is selected, a click
anywhere on a tile takes it in or out (nothing opens, and the circles show on all of them) until
the selection is empty again. Ctrl or Cmd+click adds or takes away, and Shift+click adds everything
from the last one selected (in timeline order), with or without a selection. Dragging over empty
space draws a box, which scrolls on at the top and bottom edges, and each day and month heading has
a circle that selects all of it. Ctrl+A selects everything loaded, Escape lets go, and Enter opens
the focused photo. On a touch screen a tap opens, a long press selects, taps then add and take
away, and holding a selected photo drags the selection. The selection is kept as ids, not as tiles, so it outlives the rows
that scroll away, and a range across 20,000 photos is one slice of the timeline. While anything is
selected, a bar takes the toolbar's place with the count, ♡, download, the bin and ⋯
([`src/apps/photos/actions.tsx`](src/apps/photos/actions.tsx)).

**Right-click** a photo (the menu key or Shift+F10 too) for *Open*, *Favourite*, *Download* (several
as one ZIP), *Show in Files* or *Open in Immich*, *Copy share link* (Seafile) or *Copy link*
(Immich), *Move to folder…* (Seafile, with the folder picker; the index follows, and a name already
there is refused rather than renamed) or *Add to album* (Immich's albums), *Info* (I), and *Move to
trash* (Delete); on a selected photo it acts on the whole selection. Empty space has *Select all*,
*Look for new photos* (Seafile) or *Refresh* (Immich), and *Grid size*. The lightbox has the same
menu (right-click, or ⋯) and a bin. Several photos download as **one ZIP made on the server as it
streams** (stored, since photos do not shrink; ZIP64 past 4 GB; up to 2,000 photos), fetched by the
browser's own download, so it goes to disk instead of into the page: the writer is in
[`src/data/zip.ts`](src/data/zip.ts), next to the reader. A file that cannot be read is left out and
named in a *Not included.txt* in the ZIP.

**The trash** asks first, saying how many and where they go: Seafile's photos go to the library's
own trash, where *Files → Trash* restores them (or, in a library that keeps no history, are deleted
for good, which the question says); Immich's go to Immich's trash (`DELETE /api/assets` with
`force: false`, never for good), and the question says how many days Immich keeps it. The grid
updates at once without asking for the timeline again (Seafile's index rows go straight away, no
walk needed), the lightbox goes on to the next photo, and a note offers **Undo** for ten seconds:
Seafile's are restored from the library's trash (by the commit that deleted them) with their index
rows, ids and favourites put back; Immich's with `POST /api/trash/restore/assets`. What undo needs
stays on the server for half an hour, behind a token that only works once, for the account and
source that made it. Locked encrypted libraries and read-only ones (shared for viewing) refuse,
and say so. The server checks every id against the account (Seafile: its own index; Immich: the
asset's owner, so a partner's or a shared album's photo is refused) and takes at most 200 at a time,
which the app sends a bigger selection in.

**Dragging** a selection ([`src/os/dnd.ts`](src/os/dnd.ts)) reaches everything that takes files:
Files and the desktop, a message being written in Mail, and the Agents composer. Seafile's photos
go as the files they are, so Files copies them on Seafile itself (a drag out of Photos copies by
default; Shift moves). Immich's are no file anywhere here: they travel the way files from the
computer do, downloaded through the server when they are dropped (the first 50), so every target
that takes those takes them.

**Seafile** has no idea what a photo is, so the server keeps an index per account
([`server/photos.ts`](server/photos.ts), in SQLite). The ⚙ view chooses the folders (any library,
read-only ones too) and suggests folders named Photos, Pictures, Camera Uploads or DCIM. A walk
lists them in the background, four requests at a time, and reads each new or changed photo's first
128 KB with a byte range for its EXIF ([`server/exif.ts`](server/exif.ts), no library): JPEG,
TIFF, PNG (eXIf), WebP (its EXIF chunk), HEIC, HEIF and AVIF (the Exif item, found through iinf
and iloc, and the primary picture's size and rotation), and the creation time and size of MP4 and
MOV (WebM and MKV keep the file's date). When what it needs is further on (a HEIC's Exif item, a
WebP's EXIF chunk, a phone video's moov box at the end), a second range fetches exactly that.
Walking again only reads files whose Seafile id or date changed, and skips a folder whose id did
not change since the last full walk (Seafile's folder ids change when anything inside does);
deleted files leave the index. The app walks again when it is opened and the index is over 15
minutes old, or with *Look for new photos*. Caps: 100,000 photos and 20,000 folders per account,
two walks at a time across the server. EXIF dates have no time zone, so a photo shows the time on
the camera's clock; a file's date (no EXIF) and a video's creation time are shown in yours.
Encrypted libraries are walked only while unlocked in Files, and their photos only show then;
Seafile makes no thumbnails there, so the small preview the camera embedded in the EXIF stands in.
Thumbnails come from Seafile's thumbnail API through the server (the token stays there), with an
ETag that the browser must revalidate after the current account and library-access checks (an
encrypted library's, and Immich's, are instead sent `no-store` with no ETag). A locked library
answers 423 for its thumbnails and details before anything else, so locking, or switching account
in the same browser, never shows cached photos;
the full photo comes straight from Seafile's file server with a
short-lived link, as in Files. Videos Seafile made no thumbnail for show a frame the browser takes
from them, as in Files. Linking another Seafile account starts the index over.

**Immich** is linked in Settings → Integrations (Photos' ⚙ view has a button to it), with its URL and an API key
(Immich: *Account settings → API keys*; All, or at least asset.read, asset.view, asset.download,
asset.update, album.read, timeline.read and user.read, plus asset.delete for the trash and
albumAsset.create for *Add to album*). Linking asks Immich for its version first
and refuses anything but Immich 2 and 3. The key is stored encrypted and only ever sent from the
server ([`server/immich.ts`](server/immich.ts)), without following redirects: thumbnails, the
originals and video (with byte ranges, for seeking) come through the server. Immich indexes its
own photos, so nothing is copied: the timeline is its month buckets, a photo's details its asset,
favourites its own. Times are the photographer's clock, as Immich gives them.

`pnpm check:photos` ([`scripts/photos-check.ts`](scripts/photos-check.ts)) checks the EXIF reader
against small files made by Pillow, exiv2, ImageMagick and ffmpeg (and one written by hand,
big-endian) in [`scripts/fixtures/photos`](scripts/fixtures/photos) (its `make.py` makes them
again), then runs the real server against stand-ins for Seafile and Immich
([`scripts/photos-mock.ts`](scripts/photos-mock.ts)): suggestions, the walk and its byte ranges,
months in the viewer's time zone, thumbnails and 304s, walking again (nothing read when nothing
changed; new, changed, deleted files and a deleted folder), encrypted libraries locked and
unlocked, another account seeing nothing, and Immich (an old version and a wrong key refused, both
of its bucket formats, thumbnails, albums, favourites, video ranges, the key never in an answer).
The selection's side too: favourites for many, the trash and undo on both sources (the index rows
gone and back with their ids, the undo token once only and for its own account), batch caps,
another account's ids refused, locked and read-only libraries refused, someone else's Immich photo
refused, moving to a folder, adding to an album, and the streamed ZIP read back with the app's own
ZIP reader.
`node scripts/photos-mock.ts [count]` starts both stand-ins with a big made-up library (Seafile on
8810, Immich on 8815) for trying the app; they are on 127.0.0.1, so link them as an admin. Not
yet tried against a real Seafile or Immich server, nor with HEIC files from a real phone.

## Contacts

The **Contacts** app ([`src/apps/contacts`](src/apps/contacts)) keeps everyone in one list: the
address book on this site (in SQLite, for whoever has no CardDAV server) and every CardDAV address
book linked in Settings → Integrations → Contacts (Settings → Apps → Contacts keeps where new contacts go): Fastmail (its
URL is filled in), iCloud, Nextcloud, Radicale and any other, with an app password stored
encrypted like CalDAV's. When a CalDAV account is linked already, the pane offers to use its login
for contacts too (Fastmail's carddav host, iCloud's contacts host, the same URL elsewhere); the
password never leaves the server. The address books are found the standard way (principal →
addressbook-home-set → address books), and the server keeps each book's cards in memory by their
ETags: a refresh lists the ETags and fetches only the cards that are new or changed
(addressbook-multiget) ([`server/carddav.ts`](server/carddav.ts), with the WebDAV helpers in
[`server/dav.ts`](server/dav.ts)).

Search matches names, addresses, part of a phone number and organisations; the strip along the
list jumps to a letter (a finger can slide along it). The sidebar has the address books, the groups
(both kinds: Apple's and Fastmail's group cards, and CATEGORIES) and the birthdays and anniversaries
of the coming 30 days. A card shows every way to reach someone, their dates (with the age they
turn), groups, note and which address book it is in; Edit changes it in place, with a photo made
small in the browser. Right-click a contact (or ⋯) to move it to another address book, export its
vCard, or delete it (asked first). The ⋯ menu imports and exports .vcf files from and to this
computer or Files (Seafile); a .vcf dropped on the window (from the computer, Files or the desktop) or opened
from Files, the desktop, Spotlight, a Mail attachment or the terminal's `open` lists the cards it holds
(UTF-16 and a byte order mark read too, a card that never closes is taken as it is), then imports them into the
address book you pick, skipping the ones it has already (the same UID, or with none the same name and email) and
saying how many. *Find duplicates* lists people who are in twice (the same address,
or the same full name) to merge into one. On a phone the window shows the list or the card, with
the address books and groups in a menu above the list.

vCards are read and written directly ([`server/vcard.ts`](server/vcard.ts)): 3.0 and 4.0, folded
lines, escapes, PHOTO inline or as an address, Apple's item groups and labels, and 2.1's
quoted-printable on import. An edit sends the contact as it was loaded and as it is now; the server
reads the card again, changes only the fields that differ, and writes it back with its ETag, so a
change made elsewhere meanwhile stays and every property the app does not know (other apps' X-
properties, keys, sounds) is kept. A 412 from the server answers "it changed somewhere else".
New cards are vCard 3.0, which every server takes. `pnpm check:contacts`
([`scripts/contacts-check.ts`](scripts/contacts-check.ts)) runs all of this against a stand-in
CardDAV server, including another user who must see none of it.

**For other apps** ([`src/data/contacts.ts`](src/data/contacts.ts)): the contacts are loaded once
per page and shared, with an index by email address.

| Call | Does |
|------|------|
| `searchContacts(q, limit?)` | contacts matching a name, address, phone or organisation, best first |
| `contactByEmail(email)` | the contact with that address, or null |
| `contactsByEmails(emails)` | a Map from lower-case address to contact, for many at once (one load for every caller) |
| `peekContactByEmail(email)`, `useContactByEmail(email)` | the same without waiting, and as a hook |
| `openContact(idOrEmail, name?)` | the Contacts app on that person; an unknown address gets a card with *Add to contacts* |
| `addContact({ email, name, ...fields }, { book?, groups? })` | a new contact in the default address book (Settings), answers it |
| `birthdays(from, to)` | birthdays and anniversaries in a range, with the years they mark, for a Birthdays calendar |
| `registerContactSlot('recent-mail' \| 'upcoming-events', render)` | fills that section of the contact card (Mail's and Calendar's, from src/os/pimLinks.tsx) |

[`src/apps/contacts/people.tsx`](src/apps/contacts/people.tsx) has the components:
`<PeoplePicker value onChange placeholder? exclude? more? badge?>` is a recipient or guest field (chips; your
contacts suggested while typing, picked with the arrow keys and Enter or Tab; a contact with
several addresses opens them to choose from; a group adds everyone in it; any valid address as
typed, after Enter, a comma or leaving the field; several pasted at once, `Name <address>` included;
Backspace takes the last one off; `more` adds suggestions after your contacts', such as Mail's
recent correspondents, and `badge` marks a chip, such as a guest's answer). `<PersonChip email name?
badge? onMenu?>` shows a person by their contact's name and photo, a hover card with *Open contact*
or *Add to contacts*, and opens the contact on a click. `<Avatar contact? email? name? size?>` is the photo or initials, and `parseAddresses(text)`
turns pasted text into `{ email, name? }` people.

## How the apps work together

Mail, Contacts, Calendar and Tasks each have hooks for the others, and
[`src/os/pimLinks.tsx`](src/os/pimLinks.tsx) plugs them in once for the page, with the server side
in [`server/pim.ts`](server/pim.ts) (`/api/pim/…`, per user, every message read again from the
user's own account):

- **People in Mail.** To, Cc and Bcc are Contacts' people picker: your contacts as you type
  (groups too), then recent correspondents. Senders and recipients are contact chips with their
  photos; a click opens the contact, or a card with *Add to contacts* for an address you don't
  know, and right-click adds *New message*, *Copy address* and *Mail from them*.
- **The contact card** has *Email* (Mail's composer once a mail account is linked) and *New event*
  (the Calendar's editor, with them as a guest), and two sections: *Recent mail*, the last five
  conversations from or to any of their addresses across your mail accounts (JMAP search, Drafts,
  Trash and Junk left out; a click opens it), and *Upcoming events*, the events of the next 60 days
  where they are a guest or the organiser (a click opens it in the Calendar).
- **Invitations.** The card in Mail answers with Accept, Maybe or Decline where the event lives:
  in a linked CalDAV calendar (Fastmail puts invitations there by itself) your PARTSTAT is changed
  in the event's own text and the server, which does scheduling, mails the organiser; in Google
  Calendar the answer goes through Google's API, which mails them; anywhere else the event is
  copied into the calendar you used last (not when declined) and your answer goes out by email as
  an iMIP REPLY (`text/calendar; method=REPLY`, the message written whole and sent with JMAP's
  Email/import and EmailSubmission). The card shows your answer and the calendar, and *Open in
  Calendar* opens the event there. A cancellation offers to take the event out of your calendar; a
  guest's reply shows whether your event has their answer yet and writes it on (only the answer of
  the guest who sent it).
- **From a message.** *Create event from this email* opens the Calendar's editor with the subject,
  everyone on the message as guests and a link back to it in the notes (this site's
  `/?open=mail&message=<Message-ID>`, which the editor's *Open the email* follows). *Make task
  from this email* asks when it is due (no date, today, tomorrow, next week or a date) and makes a
  task with the subject, the sender and a snippet, and the message as a `message:%3C<Message-ID>%3E`
  link, the kind Apple's Reminders and Mail use, so it opens the message on a Mac or an iPhone
  too; in Tasks it opens it in Mail, found by its Message-ID in whichever account has it.
- **Calendar.** *Email guests* (in the editor and an event's menu) writes to everyone on it with
  the title as subject. The *Birthdays* calendar comes from your contacts.
- **mailto: links** anywhere in MvL OS (contact cards, the Calendar, Agents answers, notes,
  Markdown previews, HTML mail) open Mail's composer once a mail account is linked, and the
  browser's mail program otherwise ([`src/data/links.ts`](src/data/links.ts)'s
  `registerLinkHandler`); so does `/?mailto=<a mailto: link>`.
- **Spotlight** lists your contacts as you type (name, address, phone; Enter opens the contact,
  Ctrl+Enter writes to them, and Ctrl+K has *Copy* the address and *Call*), and `mail:` followed
  by a search (the words and `from:` … filters Mail takes) shows the newest matching messages
  from every account, Enter opening one. Settings → Spotlight switches both off.

### Notes and calendar events

Meeting notes: a note in the Notebook can be linked to calendar events, and an event to notes
([`src/os/noteEventLinks.tsx`](src/os/noteEventLinks.tsx) plugs the Calendar and the Notebook into
each other through the hooks in [`src/data/calendar.ts`](src/data/calendar.ts) and
[`src/data/notes.ts`](src/data/notes.ts)).

- **From an event** (its right-click menu, and the event editor's *Notebook* row): *New meeting
  note* makes a note titled with the event and its day, with when, where, the guests (names from
  the invitation or your contacts) and headings for the agenda, notes and action items, linked and
  opened in the Notebook; *Link a note…* picks one (search, arrows and Enter); the editor lists
  the linked notes, each to open or unlink, and the menu has them under *Linked notes*. Events with
  notes have a 📝 beside their title in every Calendar view and in the Agenda widget (a click there
  opens the note).
- **From a note** (the Notebook's ⋯ and right-click menus, and the sticky's menu): *Link to an
  event…* picks an event from two weeks back to a month ahead, by title, with the dates to change.
  The note shows a chip per event with its date and time, which opens the Calendar at that event
  (that occurrence, for a repeating one), and × to unlink. Linked notes have a 📅 in the Notebook's
  list, and Spotlight finds a note by the title of its meeting.
- **A repeating event** asks whether the note is for this occurrence or every one.

Where the link lives: on the note, in the synced notes, as the event's iCalendar UID (the same in
every calendar app, kept when the event is renamed, moved or edited elsewhere), which occurrence
(its RECURRENCE-ID, which also stays when that occurrence moves) or none for the whole series, the
calendar it was in, and a copy of its title and time to show when the event can't be read. Notes
sync, so the link is on every device; the copy is brought up to date whenever the event is seen,
and a link is looked up again now and then (and on a click), so a moved event shows its new time.
The event also gets a private backlink ([`server/noteLinks.ts`](server/noteLinks.ts)), so it says
it has notes as soon as it is read, even before the notes have synced: in CalDAV an
`X-MVLOS-NOTE:<note id>` line, written into the event's own text with its ETag (a conflict is read
again and redone, up to three times) without touching anything else, SEQUENCE and DTSTAMP included
(it is not a change to the meeting); for one occurrence it goes on that occurrence's own VEVENT
when it has one, otherwise on the series with `X-MVLOS-OCCURRENCE=<its start>`, so no exception is
made for it. Events with guests get no backlink in CalDAV, as a server that does scheduling could
mail them about any change. In Google it is a private extended property (`mvlosNotes`), only on
your copy of the event, with `sendUpdates=none`. The link works without the backlink (a read-only
calendar, guests).

A deleted event keeps its link, crossed out, until it is unlinked (the chip says so when clicked);
a note in the trash keeps its links (restored, they are back) and doesn't count on the event; a
note deleted for good takes its backlinks out of its events. Signed out, the notes (and so the
links) leave the browser with the rest of the account's state. The endpoints are `POST
/api/calendar/note-link` (`{ref | link, note, all?, unlink?}`) and `POST /api/calendar/find`
(`{uid, calendarId?, occurrence?, start?, fresh?}`, the event a link points at now, or `gone`).
Not yet tried against real Google or Fastmail: Google merges a patch's private properties (the
whole map is sent anyway), and whether Fastmail mails guests about an X- property is avoided rather
than known.

```sh
pnpm check:pim-links   # Against stand-ins for JMAP, CalDAV and Google Calendar: invitations answered in each place (PARTSTAT, Google's API, an iMIP REPLY), cancellations, replies, a contact's mail and events, tasks from mail, another user seeing none of it
pnpm check:note-links  # Against stand-ins for CalDAV, Google Calendar and Ollama: the backlink written with everything else kept, an ETag conflict, one occurrence against the series, guests left alone, Google's private property with sendUpdates=none, a deleted event, the Agents note tools asking in every mode (Ask first, Auto, Bypass), another user seeing none of it
pnpm check:window-props  # One-shot requests (event, task, contact, day, import, message) kept out of the saved window layout, so a reload never opens that editor again
```

[`scripts/google-mock.ts`](scripts/google-mock.ts) is the Google Calendar stand-in: the server
talks to it instead of Google when `GOOGLE_API_URL` (and `GOOGLE_TOKEN_URL`) point there, which
only the checks do. Not yet tried against real Fastmail, Google or iCloud accounts: how Fastmail
takes the iMIP message made with Email/import, and Google's `events/import` for an invitation from
elsewhere, are as their documentation says.

## Widgets

Widgets sit on the desktop like sticky notes: no title bar, tape on top, a sway when dragged, a
right-click menu, and no text selection (except a sticky being edited). Desktop icons sway when
dragged too; Settings → Appearance → Motion turns either off. Several icons dragged at once gather
in a pile under the pointer with a count badge, like Finder, and fan back out into the arrangement
they had, moved to where you drop them. Add widgets from the desktop's menu (*Add widget*), All apps → Widgets or Spotlight.
Today there are six: **Sticky note** (one of your notes, with checklists you can tick),
**Weather** (now, the next hours and three days from [Open-Meteo](https://open-meteo.com), for the
browser's location or a city you pick; your pick syncs, the browser's location stays on that
device; double-click or the menu opens the full **Weather** app), **Agenda** (Google Calendar and
CalDAV, see above), **Code inbox**, **Status** (updown.io) and **Minecraft server** (up or not, the
address to copy, who is on with their heads, and the in-game day and time when RCON is set up; a
click opens the Minecraft server window).

### Weather

The **Weather** app ([`src/apps/Weather.tsx`](src/apps/Weather.tsx), with its parts in
[`src/apps/weather/`](src/apps/weather)) is a forecast dashboard: current conditions, the next hour
of precipitation, the coming hours (temperature, precipitation or wind), a 10-day outlook, and tiles
for UV, sunrise and sunset, wind, precipitation, feels like, humidity, pressure, visibility, the
moon, an animated precipitation radar and air quality. A strip at the top of the window switches
location and refreshes. On a wide window the tiles sit in a grid; on a tablet the 10-day list sits
beside the map; on a phone or a narrow pane they stack. It uses the same Open-Meteo fetch as the
widget ([`src/data/weather.ts`](src/data/weather.ts)), called from the browser with no API key:
current conditions, every hour of the 10 days (temperature, feels like, precipitation and its
chance, wind, gusts and direction, UV, humidity, dew point, pressure, visibility, cloud cover),
15-minute precipitation for three hours, and hourly air quality (European AQI, PM2.5, PM10, ozone,
NO₂) a few days ahead.

**Looks.** Behind the cards the sky follows the current conditions, mixed from the theme's palette
(deep in a dark theme, pale in a light one): drifting clouds, slanted rain, falling snow, twinkling
stars and a moon glow at night, a lightning flicker in a storm, a slow sun glow on a clear day. The
cards are layered glass with a soft shadow, rise in one after another, and lift on hover; the
weather icons move a little, numbers count up, and the tiles carry small drawn-in sparklines (UV,
precipitation, feels like, humidity, visibility, air quality), a swaying wind needle and a sun on
its arc. All of it is CSS animation on transform and opacity (no frame loop, no React renders), and
with *reduce motion* set in the system everything stands still.

**Details.** Every card opens a detail with one shared interactive chart
([`weather/Chart.tsx`](src/apps/weather/Chart.tsx), plain SVG): hover with a mouse or drag with a
finger or pen along it and a crosshair, a tooltip with every series and the readout above follow
that point; the handle under the axis drags too, and arrow keys, Page Up/Down, Home and End step
through it when it has focus. What each shows: *hourly* temperature and feels like, precipitation
amount and chance, or wind and gusts with direction arrows (switchable in the detail); *10 days*
highs and lows as a band with the chance of precipitation, and a button into that day; *a day* its
hours, with previous and next day; *next hour* three hours in 15-minute bars; *UV* by hour over
the UV bands, with advice for the hour; *sun* a sun you drag through the day along its path (time,
time to sunset or sunrise) and the daylight over 10 days; *wind* a compass that turns with the
scrubbed hour; *precipitation* the next 24 hours or 10 days; *feels like*, *humidity* (with dew
point and how muggy it feels), *pressure* (the gauge follows, with the trend) and *visibility*
(with cloud cover) by hour; *moon* 30 days of illumination plus a phase calendar to tap through;
*air quality* the AQI by hour over its bands with the pollutants for that hour.

**Radar** ([`weather/Radar.tsx`](src/apps/weather/Radar.tsx)). The map card is a quiet gray canvas
(Esri's dark canvas in a dark theme, the light canvas in light mode) with
[RainViewer](https://www.rainviewer.com/)'s frames on top: the last two hours of scans, and its
nowcast frames when it publishes them (it publishes none at the moment; the timeline then ends at
the latest scan and says so). Each frame is its own stacked layer, loaded up front, so the loop and
scrubbing only crossfade between layers. Radar tiles are 512 px from one zoom level down, a quarter
of the requests. The card loops by itself while it is on screen and the page is visible, showing the
frame's time; tap it for the big map: play and pause, a timeline to drag (past and forecast drawn
differently, a *Now* mark, local time with "40 min ago" or "+30 min"), three speeds, drag to pan,
zoom buttons or the wheel, and a button back to the place. If RainViewer does not answer, the canvas
stays and the map says the radar is unavailable; the rest of the forecast is unaffected. The line at
the bottom of the page credits Open-Meteo, RainViewer, and the basemap (Esri, HERE, Garmin and
[OpenStreetMap](https://www.openstreetmap.org/copyright)). Saved cities and units sync with your
account; the browser's own location stays on that device. Open it from All apps, Spotlight, the
dock, `weather` in the terminal, or from the weather widget.

### Changelog

The **Changelog** app ([`src/apps/Changelog.tsx`](src/apps/Changelog.tsx)) lists MvL OS GitHub
releases (`MvL OS X.Y.Z`) with their notes rendered as Markdown. It loads them through the site's
cached `/api/git/…/releases` proxy ([`server/github.ts`](server/github.ts)), falling back to the
public GitHub API when that proxy is absent. Open it from All apps, Spotlight, the dock, or
`open changelog` in the terminal.

The terminal's `changelog` command ([`src/terminal/commands.ts`](src/terminal/commands.ts)) prints
the same releases as scrollable coloured text (`changelog`, `changelog 3`, `changelog 1.80.0`).

The framework lives in [`src/widgets`](src/widgets). A widget is one `WidgetDef`
([`types.ts`](src/widgets/types.ts)): a name, a glyph, a size, its component, and optional hooks
for its frame colours and tilt (`useFrame`), its own menu items (`useMenu`) and how a new one is
made (`create`). List it in [`registry.tsx`](src/widgets/registry.tsx) and it gets the frame,
dragging, the menus and an *Add widget* entry everywhere. Per-widget settings go through
[`config.ts`](src/widgets/config.ts) (`useWidgetConfig` / `setWidgetConfig`), which syncs like
notes. Which widgets are on the desktop, and where, is a set of its own
([`src/os/widgetPlaces.ts`](src/os/widgetPlaces.ts), synced as `widgets:placed`), not part of the
window layout: signed in, another browser or device shows the same widgets (same ids, so their
settings apply too), and adding, moving, minimizing or removing one shows up elsewhere on the next
pull (a refresh, or coming back to the tab). The set merges by widget id, the latest change to
each widget winning, so two browsers (or two tabs of one) adding widgets at the same time both
keep theirs. A change counts on from the one it changes, so a device whose clock runs behind still
wins with a later change. Taking one off is final: its entry's key goes into a list of removed
keys, kept for good, so a browser or an old saved layout that still has the widget can't bring it
back (a key is about 9 bytes, so 20,000 removals are under 200 KB). Putting a sticky back after
taking it off makes a new entry with a key of its own. `pnpm check:widgets-sync` checks
these rules in memory. `PORT=5273 node scripts/widgets-sync-e2e.ts` checks migration,
cross-device display, phone layout and delayed sticky contents in muted Chromium with scratch
accounts and data; it starts and stops its own server.
A big screen puts a widget where it was put, moved along when its own screen is another size (a
widget near the right edge stays near the right edge) and fitted onto a smaller one; a widget
added on a phone gets the usual spot for a new widget there. Phones and big screens share the
set; a phone only changes a widget's place in its column. Widgets stay through *Start over* and
a reboot, and show whatever Settings → Windows starts the desktop with. Widgets kept in a window
layout by an earlier release move into the set when that layout is loaded or arrives from the
server or another tab (before a merge of the layouts could drop it) (unless the set already
has newer entries, or had them and they were removed since). Migrated coordinates have an
unknown-screen marker: they are shown as stored and clamped to fit, without scaling or assigning
a default spot. Equal change counters prefer a desktop-width source (at least 720 px), then the
larger width, then a deterministic tie-break. The width of the importing browser is only a
migration preference, not the original screen size. A missing sticky note stays hidden locally
while its contents sync; arriving contents reveal it again. Only a user close or a known trash
or purge removes its widget entry. Visitors keep their widgets in this browser;
ones placed before signing in join the account's.

## Touch screens

On a phone or tablet, **holding a finger still for half a second is a right-click**, everywhere
in the OS: the desktop, its icons, the dock, title bars, notes and widgets, Files, the Agents
sidebar, the calendar, Spotlight results and the rest open the same menu a mouse gets, with a short
buzz ([`installTouchContextMenu`](src/os/ContextMenu.tsx)). Moving the finger first (scrolling,
dragging a window or an icon) or adding a second one is not a long press, and the tap that would
follow the lift is dropped once a menu opened. Text fields keep the browser's own long press
(selection, paste), and so do places with a long press of their own: Empires At War, Minesweeper's
flags, held game buttons and game canvases. Anything else can opt out with `data-no-touch-menu`.
On coarse pointers the menu's items are taller, and the OS chrome (bar, dock, title bars, sidebars)
does not select its labels or show the browser's callout (see *Selecting text* above).

On phones the notes and widgets go one under the other down a desktop that scrolls. Hold one by
its top strip until it lifts (a swipe there just scrolls), then drag it up or down that column (the
desktop scrolls along near the top bar and the dock); let go without moving, or long-press it, for
*Move up*, *Move down* and *Move to top*. The order is part of the
phone's window layout (`stack` in [`src/os/wm.tsx`](src/os/wm.tsx)), and for widgets part of their
synced set; on a big screen notes stay wherever they were put.

The MvL OS menu (top left) has *Hide notes and widgets* to put them all away and see the desktop
itself (per browser; adding a note brings them back). On a phone, where the icons otherwise sit
behind the notes, the desktop's icons then show as a grid of tiles: tap one to open it, long-press
for its menu.

Dragging works with a finger too: hold a desktop icon (in the phone's grid) or a row in Files still
for a moment and it lifts with a buzz; move the finger then and it drags, to
the same places a mouse drags to. Holding on without moving opens its menu as before, and moving
after that closes the menu and drags.

On phones and touch devices, **Maximize** fills all four edges, including after rotation.
The title bar, OS bar and dock disappear, with no window border, margin or shadow. Notch and
home-indicator space is padding inside the window; the on-screen keyboard reduces its visible
height. Tap **Restore size** at the top right to return to the previous window layout. The
window's saved geometry is retained, including when returning to a larger screen.

With the on-screen keyboard open, windows end just above it, whether the browser lays the
keyboard over the page (iOS) or shrinks the page (Android, newer iOS). Text fields are at least
16px on touch screens, and on iOS the page has a maximum scale of 1, so focusing a field never
zooms the page in; double-tap zoom is off everywhere. Pinch zoom still works.

## Games

The Games app ([`src/apps/games/Games.tsx`](src/apps/games/Games.tsx)) is a games library: a shelf
of covers, with the game you played last (or, before you have played anything, Empires At War) laid
out large above it, and a search and two filters (*Played*, *Starred*) over both
([`Library.tsx`](src/apps/games/Library.tsx)). Picking a game opens it in a window of its own,
titled with the game's name and grouped under Games in the dock. Each game has one window; picking
it again (in the library, Spotlight, Launchpad, or `games tetris` and `./tetris.game` in the
terminal) brings that window forward.

A cover is drawn, not downloaded ([`covers.tsx`](src/apps/games/covers.tsx)): plain shapes over the
game's own colour, so it costs nothing, takes the theme's colours and still reads at 130px wide. A
game without a drawing falls back to its emoji. What you played and what you starred are two small
lists in this browser ([`prefs.ts`](src/apps/games/prefs.ts), `mvlos.games.recent` and
`mvlos.games.favourites`): opening a game, in the OS or on its page of its own, puts it first, and
the star sits on every cover and on the large one.

On a phone the shelf comes three covers to a row, stars and filters grow to finger size, and the
large cover gives up its poster on the smallest screens so its words fit; a phone on its side gets
a shorter one. Tapping a cover opens the game, and holding it gives the same menu a right-click
does.

A game in progress belongs to its window. Closing the window ends the game, and opening it again
starts at its main menu. A page reload keeps the window, so the game carries on where it was:
every game window has a session id (saved with the window layout), and what a game keeps to
resume (Empires At War's battle snapshots, the campaign it had open, being in multiplayer) is
stored under it ([`session.ts`](src/apps/games/session.ts)) and removed when the window closes. At
startup, anything kept for a window that no longer exists is removed too.

Save games stay until you delete them: Empires At War's Galactic conquest campaigns (they save into
their slot as you play; load them from Galactic conquest → Load game), Gladiator's careers, high
scores and settings. A campaign battle cut off by closing the window waits in the loaded campaign,
to be fought again from the start.

### Direct links: games without MvL OS

Every game also has a page of its own at **`/play/<game>`** (`/play/tetris`, `/play/pacman`,
`/play/minecraft`, `/play/snake`, `/play/minesweeper`, `/play/pool`, `/play/gladiator`,
`/play/empires`, `/play/breakout`; the ids are in
[`src/apps/games/catalog.ts`](src/apps/games/catalog.ts)): just the game, filling the browser
window, with no boot log, desktop, top bar or dock ([`src/os/playMode.ts`](src/os/playMode.ts),
[`Play.tsx`](src/apps/games/Play.tsx)). The game bar slides in at the top edge (or with the
handle on a touch screen) with the browser's real fullscreen, a link to the list and one back to
MvL OS. **`/play`** is the same library, with each cover a link to that game's page; a link to a
game that doesn't exist lands there with a note.
The server gives each page the game's title and description for link previews
([`server/index.ts`](server/index.ts)).

The game window's menu (⋯ or right-click) and a right-click on a cover in the library have **Copy
direct link** and **Open without MvL OS**.

Saves, settings and high scores are the same ones the OS uses (same site, same browser storage), so
progress carries over both ways, and signing in from Gladiator comes back to the game's page.
Multiplayer works the same. The game in progress belongs to the browser tab instead of a window: a
reload carries on where it was, closing the tab ends it.

## Empires At War factions

Three factions: the **Republic** (`republic`, unit ids `r-…`), the **Confederacy** (`droid`, ids
`d-…`: the id stays `droid` so saves and multiplayer keep working) and the **Swarm** (`swarm`, ids
`s-…`), a bio-mechanical hive. All three are playable in skirmishes, multiplayer, Galactic
conquest and the Codex. They form a soft triangle, each pairing close to even (about 45-55% in the
AI tournament): the Confederacy's alpha strikes and shield-breaking edge out the Republic, the
Republic's shields and turbolasers edge out the Swarm, and the Swarm's numbers and regrowth wear
down the Confederacy's thin shields.

- **Republic**: tough, shielded warships with strong repair; fewer ships, each worth more. Its
  frigate-tier ships are the Warden frigate and the Sentinel destroyer, a shield escort whose
  projector domes speed the shields of the fleet round it; its two flagships are the Sovereign
  dreadnought (heavy guns and a fighter wing) and the Resolute battleship, a command carrier with a
  flight deck of Lance squadrons and a fire-control aura.
- **Confederacy**: heavy guns that hit hard and early, missiles and the Breaker's spinal ion lance
  for shields, fast strike craft; thin shields and weaker repairs. Its two flagships are the
  Dominator dreadnought (carrier, Alpha strike) and the Tyrant battleship, whose fire-control aura
  makes the guns round it hit harder.
- **Swarm**: no shields anywhere (more hull instead), living hulls that grow back out of combat,
  cheap ships that hatch fast, the Leech corvette's drain aura, and broods of Stingers from its
  flagships and the fully grown Hive Nexus. Its frigate-tier ships are the Harvester frigate and
  the Impaler destroyer, a living spear that turns its whole body to aim a spinal tendril lance at
  big hulls; its two flagships are the Leviathan dreadnought, the gun flagship (heavy tendril lances
  and spore cannons, one slow brood), and the Broodmother carrier, which hatches broods of Stingers
  far faster and keeps four out, with weak guns of its own. Its mining platform's "Shield
  generator" upgrade is a Hardened carapace (more hull, faster regrowth), and its station takes no
  Shield core.

Everything that belongs to one faction is in files of its own, so the factions can be worked on
side by side without touching each other's:

- **Its data**, [`data/<faction>.ts`](src/apps/games/empires/data/): its ships, its Command Station
  at every level, its mining and defense platforms and yards, its research, its yards' sockets,
  berths and gantries, its warships' hardpoint layouts at their size, its Galactic conquest
  defense station (`orbital`: its levels and modules, see below), and how it looks and sounds
  outside its models (`info`: its name, colours, emblem, welding light, id prefix, its usual rival
  in Galactic conquest, and `names`: what it calls the shared things, see below). Its station's
  `stages` each carry the name it goes by at that level (Bastion Outpost … Citadel, Dominion
  Outpost … Fortress, Hive Seed … Hive Nexus), shown on the HUD's station card, the upgrade in the
  tech tree and the Codex's level picker. It is written in the types and helpers of
  [`data/kit.ts`](src/apps/games/empires/data/kit.ts); [`data.ts`](src/apps/games/empires/data.ts)
  merges the three into the tables the rest of the game reads (`UNITS`, `UNIT`, `TECHS`,
  `STATIONS`, `FACTIONS`, …), toughens, scales and sizes them, and holds what all factions share.
- **Its models**, [`models/<faction>/`](src/apps/games/empires/models/): `craft.ts` (strike
  craft, station, platforms), `warships.ts` (everything bigger, at its size), `base.ts` (engineers,
  yards and expansion modules), `orbital.ts` (its defense station, every level), `mounts.ts` (its
  turrets and modules), `palette.ts`, and `index.ts`,
  which lists its designs by unit id. [`models/index.ts`](src/apps/games/empires/models/index.ts)
  merges them; the geometry ([`kit.ts`](src/apps/games/empires/models/kit.ts)), the warship
  helpers ([`proto.ts`](src/apps/games/empires/models/proto.ts)), painting and break-ups are shared.

Code that once asked "Republic or droid?" looks the faction up instead (`FACTIONS[f].prefix`,
`unitOf`, `yardOf`, `wingOf`, the faction's palette and sounds), so a new faction needs no change
there.

**Faction mechanics** ([`sim.ts`](src/apps/games/empires/sim.ts), set on a unit type in its
faction's data; all off unless a unit sets them, and none draws a random number):

- `regrow` (`{ rate, delay }`): living hulls. Once `delay` seconds have passed since an enemy last
  hit it (or an asteroid field's rocks: flying through a field holds the regrowth off, so a living
  hull can't cross one for free), the hull grows back by `rate` of its full hull a second (0.02: 2%), as far as it can go.
  A station gets it from a level on (`StationPlan.regrow`, with `level`).
- `drain` (`{ radius, dps, heal, targets }`): the `targets` nearest enemies it sees within `radius`
  (nearest first, ties by unit id) lose `dps` hull points a second each, straight off the hull past
  shields; `heal` of what it took (0.5: half) mends our damaged ships within `radius`, shared
  evenly. The Leech bites 3 at once.
- `fireControl` (`{ radius, bonus }`): our ships within `radius` deal `bonus` more damage (0.15:
  15%); auras don't stack, the best counts.
- `shieldAura` (`{ radius, regen }`): a shield projector. Our ships within `radius`, itself
  included, recharge their shields `regen` faster (1: twice as fast; it multiplies on top of the
  rest, out-of-combat doubling included). Auras don't stack, the best counts; a ship with shield
  generators projects only while one of them stands (shoot the projectors off and it stops), and
  ships without shields gain nothing. The Republic's Sentinel destroyer carries one.
- A brood: a station launches strike craft as a flagship carrier does (`StationPlan.carrier`:
  `{ unit, every, max, level }`, from that level on), on a clock of its own beside its defense wing.
- A spinal gun (`spinal(weapon, degrees)` in data/kit.ts): fixed along the keel, it fires only
  within `degrees` either side of the nose, so the whole ship turns to aim it; its mount doesn't
  turn on the model. The Confederacy's Breaker and the Swarm's Impaler carry one.
- No shields: `shield: 0` with no shield generators works everywhere (the HUD shows no shield
  bar, ion barely scratches the hull, shield research does nothing).

Radii are written at the old battlefield scale and stretched like gun ranges (and spread out with
the fleet for the bigger hulls, as repair tenders are). `pnpm check:empires-mechanics` switches
each one on for a test unit and checks what it does, along with ships crossing an asteroid field (a
Swarm hull loses hull and doesn't regrow inside; shields wear at `FIELD_WEAR`), the drain's target
limit and the strike craft's toughness.

The battle shows them (render.ts, in each side's bolt and engine colours): a drain ship's tendrils
to the enemies it bites and heal sparks off the allies it mends, a fire-control ship's ring (and,
selected or up close, lines to what its ships fire on), a shield projector's faint ring and
shimmering links to the ships whose shields it is feeding, a pulsing glow on a living hull growing
back, a spinal gun's charge at its muzzle and its shot as a lance of light, and a Swarm brood
bursting from its sac. The Codex lists them as **Traits** (with "No shields" and carriers), and the
unit cards and their tips explain them (`traits` in
[`codexInfo.ts`](src/apps/games/empires/codexInfo.ts)).

**Research for the mechanics** (`TechEffect` in data/kit.ts, applied in sim.ts like the others, as
fractions): on the unit type a tech is `for`, `shieldDamage` (its guns hit shields that much
harder), `aura` (added to its fire-control bonus) and `auraRadius` (the reach of its fire-control
or shield-projector aura), `shieldAura` (added to its shield projector's `regen`), `regrow` (faster
regrowth) and `regrowDelay` (negative: a shorter wait), `drain` (its drain's dps), `drainHeal` and `drainTargets` (added to how many enemies it bites); on the
station, `fleetBuild` (every ship of the faction built that much faster, -0.1 for 10%, on top of
each ship's own `build` research), and `regrow`/`regrowDelay` there reach every living hull of the
side, ships and structures, on top of their own. The AI weighs them like the rest. The research
that uses them: the Confederacy's Shield breakers (Breaker, `shieldDamage`) and Fire-control net
(Tyrant, `aura` and `auraRadius`), the Republic's Projector arrays and Wide-field emitters
(Sentinel, `shieldAura` and `auraRadius`) and Fleet command (Resolute, `aura` and `auraRadius`), the Swarm's Rapid regrowth (Hive Nexus, for the whole Swarm), Swollen wombs (Broodmother, `regrow`),
Deeper tendrils (Leech, `drain`, `drainHeal` and one more target) and Hive surge (Hive Nexus, `fleetBuild`).

**Names per faction** (FactionInfo `names` in data/kit.ts): its guns by kind (`weapon`, the Codex's
weapon lists), turrets by the gun on them (`mount`), its other hardpoints (`part`), its mount looks
(`look`), its mining platform's upgrades (`site`) and its abilities (`ability`: the same ability
under its own name, so the Confederacy's `broadside` is Alpha strike, the Swarm's `tractor` Tendril
grip). Each falls back to the shared name; only the words change. `hpName` (icons.ts),
`weaponName` (codexInfo.ts), `abilityOf` and `siteUpgradeOf` (data.ts) look them up.

**Sound sets** ([`sound.ts`](src/apps/games/empires/sound.ts) `SET`, by faction id): the Republic's
clone crews and blasters; the Confederacy's machine-shop military (plasma guns, cannons with
clanking breeches, a command net of relays and pulse tones, no droid chatter); the Swarm's living
ships (spit, wet pulses, spore thuds, acid hisses, chitters, and the groans of its big ships, which
also thud wetly when hit and tear rather than shear when they die). Each faction's crews answer in
their own voice (`VOICE`): the Republic's clone radio beeps, the Confederacy's command net (a relay
clack, then bit-crushed data-burst tones, with a servo whine under its big ships), the Swarm's
chitter. FactionInfo `sound.turbo` still tunes the heavy guns' pitch. Settings → Sound test plays every faction's set.

**Music** ([`music.ts`](src/apps/games/empires/music.ts)): six separate synthesised pieces (no shared bed) — menu fanfare, lobby arpeggios, calm skirmish underscore, skirmish combat (war drums), galactic map, and galaxy alarm. Hard cuts between them. Skirmish flips to combat on fight heat; the galaxy map flips to alarm on a threat. Original motifs, not film themes. Sound test auditions every piece.

**AI doctrine** (ai.ts `DOCTRINE`, on top of the admiral's profile): the Confederacy concentrates
its fire from further off and sends its fast warships round the flank of a goal where that is
clear, and strikes early: its first waves go out at 85% of the usual fleet value, and its quiet
start is 40% of its difficulty's (on Medium a minute rather than two and a half; Hard has none).
With the full quiet start it sat out the build-up and lost about two Medium battles in three, while
winning most on Hard. The Swarm leans to small, quickly built ships (and build-time research), in skirmishes and
Galactic conquest. Every side pulls living-hull ships back out of a wave to grow back, keeps drain
ships in among the enemy with its wave, values fire-control and spinal ships, values a shield
projector by how many warships it has and how much of their staying power is shields (and keeps it
with the fleet, never scouting or flanking). Every side has two flagships, a gun flagship and a
carrier/support one: the Republic's Sovereign and Resolute (carrier and fire-control aura), the
Confederacy's Dominator and Tyrant (fire-control aura), the Swarm's Leviathan and Broodmother
(carrier). A side settles on one only once it is really saving for a flagship (a fleet worth
guarding it, nothing attacking home, a Capital slip that could build it), not at the start of the
battle, drawn by what its fleet needs: the support flagship the bigger its own fleet and the more
strike craft the enemy flies, the gun flagship the more cruisers and flagships the enemy fields.
It keeps to that pick until the flagship is built, and settles afresh after losing it, so both
appear. A side without shields never orders a Shield core.

**For a faction's model files** (all additive, no shared file to change):

- *Level of detail*: `minPx` on a part or a detail (`Lod` in models/types.ts) paints it only once
  the whole hull (or mount) is at least that many device pixels across; see the top of
  [`models/paint.ts`](src/apps/games/empires/models/paint.ts) for thresholds.
- *Extra mount designs*: a faction's `mounts.ts` may export `extras: MountExtras` (functions of
  `broken`, by `MountExtra` name: torpedo, pd, triple, missileBox, strike, railgun, beam, quad,
  spore, acid, lance, bioturret, parasite, regen, engineSac, broodSac, spine). A hardpoint picks
  one with `look` in its data (or a model with its `mount` override); a faction without that
  design draws the nearest common one (`FALLBACK` in models/mounts.ts).
- *Part names*: a faction's `models/<faction>/index.ts` may give `partNames` ([prefix, name]
  pairs, longest prefix wins) or `partName(id, t)` on its `MODELS`; the Codex looks there before
  the shared names.

In Galactic conquest the player picks the enemy's side too (any other faction; by default its usual
rival). In the Rim Wars the Republic holds the west, the Confederacy the east and the Swarm the Deep
along the southern edge, two systems that are only there when the Swarm fights.

The multiplayer client and server check each other's `PROTOCOL` version
([`protocol.ts`](src/apps/games/empires/protocol.ts)) when a connection opens: a copy of the game
from another version would play another battle, so the server turns it away and the game asks for a
reload.

## Empires At War maps

Skirmishes and multiplayer battles are fought on fifteen hand-made maps
([`maps.ts`](src/apps/games/empires/maps.ts)) or on a generated one, for 2 to 6 players. Every
map is symmetric: everything is placed for one side and copied to the others, so every spawn gets
the same ore, beacons, terrain and lanes. The symmetries: `point` (two sides, turned half way
round), `quad` (four corners, mirrored both ways), `tri`, `penta` and `hex` (three, five and six
sides turned round the middle) and `tripair` (six: three pairs of mirror twins turned a third of
the way round). Teams are always two sides, so a six-spawn map plays 3v3, 2v4, 1v5, a duel with
empty spawns, or anything in between.

A map's size class goes by its area at the battlefield's scale (`mapSize` in `Menus.tsx`, in
millions of square units divided by `MAP_SCALE`²): **Small** under 30, **Medium** under 50,
**Large** under 90, **Huge** from 90.

| Map | Size | Spawns | The idea |
| --- | --- | --- | --- |
| Cinder Gate | Small | 2 | A tight duel over four ore, the middle beacon in a nebula |
| Hadrel Narrows | Small | 2 | An asteroid wall with two narrow gaps, a beacon in each, and a derelict in the wall |
| Tessaly Knot | Small | 3 | Walls between each pair of stations; every road runs through the one beacon in the middle |
| Kessar Belt | Medium | 2 | The classic duel: three beacons down the middle |
| Orvane Lanes | Medium | 2 | Three lanes split by long walls, open only at a crossroads in the middle |
| Twin Reefs | Medium | 4 | Four lean corners, reefs in every quarter |
| Ithra Archipelago | Medium | 4 | Four ore islands ringed by asteroids, each open towards its own corner |
| Trinity Rift | Large | 3 | Three stations round a contested core in a nebula |
| Shroud Expanse | Large | 3 | The richest ore in the clouds on the rim |
| Vanth Crossing | Large | 4 | Four corners, five beacons |
| Quintara Crown | Large | 5 | A crown of asteroids with a beacon in each gap, the richest ore inside |
| Serrat Halo | Large | 6 | A ring round a dead heart of asteroids; neighbours share the beacons between them |
| Velkar Core | Huge | 6 | A wide open field round a rich core ringed by six beacons |
| Draxis Spiral | Huge | 6 | Asteroid arms wound like a pinwheel: every road to the core curves past a neighbour |
| Tarsis Triad | Huge | 6 | Three pairs of twin stations sharing a beacon, three nebula fronts between the pairs |

The huge maps are laid out for a duel on opposite spawns as well as for 3v3: the empty spawns'
ore is there for the taking, and the beacons ring the middle rather than the stations. The
generator builds maps for 2 to 6 players (five and six turned round the middle, like three).

`pnpm empires:maps` plays the maps out with AI admirals, to see that a map is fair and that the AI
expands, fights and finishes on it: duels on spawns as far apart as the map has and battles with
every spawn taken (sides alternating round the map), each played from both sides. It reports how
many games ended and how long they took, how often each spawn's side won, and the ore, beacons,
expansions, ships and kills per admiral. `MAPS=hadrel,orvane pnpm empires:tournament` runs the AI
profile tournament on those maps instead of the two-spawn ones. With repairs slowed under fire (see
"Repair crews" below), hard AI-only battles mostly end (`pnpm empires:maps 60 3`: 99 of 156
within the hour, median 34 minutes; every spawn taken, 56 of 66), and duels on the small and
medium maps do too. Duels between equal hard admirals on the large and huge maps still mostly
run past an hour (Velkar and Draxis none of 6, Vanth, Quintara, Orvane and Tarsis 1, Serrat 2,
Ithra 3): both sides reach the fleet limit, two equal capped fleets trade evenly in the open
field, and the side that loses a fight builds its fleet again at home before the winner's wave
has crossed the map.

```sh
pnpm empires:maps 40 3 velkar,draxis,tarsis      # minutes, seeds, maps (default all), layouts (1v1,near,full), difficulty, profile
```

## Empires At War battlefield scale

Three dials in [`scale.ts`](src/apps/games/empires/scale.ts) set how big a battle feels:

- `MAP_SCALE` (1.25): every battle map, in skirmish, multiplayer and Galactic conquest, is this much
  bigger in each direction than drawn (on top of `SPREAD` in `maps.ts`). Spawns, ore, beacons,
  wrecks, fields, nebulas and start areas move out with it, as do the distances the AI measures
  across the map; ships, structures, ore and rocks keep their size.
- `RANGE_SCALE` (1.1): every weapon, sensor, ability range, repair tender, the defense wing's home
  radius and what the sim derives from them (chase leashes, how far ships look, strafing runs).
  The numbers in `data.ts` stay as written; research bonuses stay percentages on top.
- `SPEED_SCALE` (1.0): every ship's speed.

Changing one changes every battle, so the multiplayer hash from `pnpm check:empires` changes too.
Battles saved before keep the map and ship types they were saved with.

## Empires At War path finding and rocks

Warships find their way round the rocks on a grid of 80-unit cells
([`nav.ts`](src/apps/games/empires/nav.ts)), one per hull size, built the first time a ship that
size needs a path and cached on the world (`World.nav`); the path is then pulled tight into
straight legs. Strike craft fly straight.

- **Rocks** are as big to the ships as 80% of their drawn radius (`ROCK_HIT`: the art is lumpy,
  its outline at 0.7 to 1.15 of the radius), and a hull may reach into one by 60% of its own radius
  (`HULL_ROCK` in sim.ts; hulls are longer than wide, so side on that's only the edge of the hull).
  The path keeps 20 to 40 units more than that (`navClear`). The push that keeps ships out of rocks,
  the steering round the next rock (`detour`) and where a move order may end (`offRocks`) all use
  the same sizes, so the path and the physics agree.
- **Asteroid fields and nebulas** are soft ground, never walls: crossing one costs more than open
  space (`navCost`): a nebula 1.5 times as much plus 12 times the hull's share of its strength
  in shields (`NEBULA_SHIELD_COST`), since a nebula strips the shields within a second: about 6
  times for a Republic warship, about 4.5 for a Confederacy one, 1.5 for a Swarm hull, which has
  none to lose. A field costs 1.2 (gunships) to 2.5 (frigates), 3
  (cruisers) and 4 (flagships) times, since the rocks there batter big hulls. So a path goes round
  one unless that takes far longer. One the ship was sent into, or is in already, costs nothing
  extra. Pulling a path tight never cuts back across a patch it went round.
- **Somewhere walled in** (a spot inside the rocks, or in a pocket no hull that size fits into):
  the path ends at the nearest point the ship can reach (`Path.short`), and the ship stops there
  (`asNearAsItGets`) and fights from there, instead of flying at the rocks for good. A selected
  ship's route line ends there too. Each grid knows which pieces of open space connect, so this
  costs no search of the whole map.
- **Structures** (stations, platforms, yards) aren't on the grid: they come and go during the
  battle. Warships steer round the one close ahead on their way as they do round a rock (`detour`,
  never the one they're headed for), slide round one they run into as they do round a bigger hull,
  and count a waypoint under one they're up against as passed. Before, a flagship whose way led
  past its own mining platform pressed into it for good, and the wave's cruisers piled up behind it.

**Scattering the rocks.** Each battle scatters its rocks from its seed (`newWorld`), copied to every
side by the map's symmetry. They keep clear of ore, beacons, wrecks, the build radius round each
start, asteroid fields (with room for the biggest flagship to skirt one) and the lanes: from each
station into the middle and to its neighbours, and from each beacon to the stations nearest it,
each wide enough for the biggest flagship. A rock is also left out if it would wall the biggest
flagship off from any station, beacon or ore it could reach before (`rockStamp`, `reachCheck`).
Without that, rocks piled up in the space left over, walled off whole sides of the four-player maps
and ringed the beacons, and flagships went the long way round, through the fields, or nowhere.

```sh
pnpm check:empires-nav   # every faction's biggest hull reaches every spawn, beacon and ore on every map (and generated ones), routes across Twin Reefs, a walled-in spot, path cost
```

## Empires At War weapon ranges and repair craft

Hovering a ship or structure in battle (ours, or an enemy we can see) rings it with its weapon
ranges ([`render.ts`](src/apps/games/empires/render.ts) `drawRanges`, worked out in
[`ranges.ts`](src/apps/games/empires/ranges.ts)): one ring per kind of gun, centred on the unit
at the average reach of that kind's standing guns (labelled e.g. *Turbolasers · avg 792*), each
kind in its own colour and dash (lasers solid red, flak amber, turbolasers blue, missiles pink
dots, ion violet), plus a faint dashed ring for its sensors. Pointing at one of its guns instead
rings that gun alone, centred on the gun where it sits. That is how the battle measures it: a gun
on a hardpoint fires from the hardpoint, out to its range (times any range research), and a target
is in reach once its centre is within that plus half its radius, an allowance for the target's size
the rings leave out. A unit's average reach is measured from its centre: for a ship, which turns
its nose to what it fights, as its stopping distance does (a gun's range less how far it sits out
to the side or behind the centre); for a structure, which never turns, averaged over every
direction. On a touch screen, which has no hover, the selected ships show theirs, and a structure's
gun picked by tapping it shows its own ring. The Codex does the same: pointing at a gun (on the
model or in the hardpoint list) or selecting it shows its own ring, and the Workshop's *Ranges*
shows the averages. The setting *Show weapon ranges on hover* (on by default) is in the game's
Settings and in Settings → Apps → Games → Empires At War.

Each side has a repair squadron of two strike craft, the Republic's Suture repair fighter and the
droids' Tinker repair droid ([`data.ts`](src/apps/games/empires/data.ts)). They launch from the
hangar like any fighter and need the research Engineer wing or Welder protocols (300 credits,
25 s, station level 1) before the shipyard builds them. Their guns are next to useless; their
ability, **Field repair** (35 s cooldown), sends them to a damaged station or a ship of gunship
class or bigger for 15 s. Each craft in reach mends 8 hull a second plus 0.5% of the patient's
hull, and its damaged modules. On a station, and only there, they also rebuild shot-off modules
one at a time, the strongest first (the hangar, then the shield generators, then the turbolasers,
the other modules, and the flak last): 20 s of one craft's welding, so 10 s for the squadron,
brings a module back at a quarter of its strength, after which it heals like a damaged one, and
the progress stays on the module between runs. A ship's shot-off modules stay lost. A shot-off
station module also counts as damage worth a run, so idle crews come over for a lost hangar
alone. F, or the ability button, aims at the ship
under the pointer, else the most damaged one within 1,400; on touch, the action wheel on one of
ours has *Repair it*. Fighters, bombers and the platforms on the ore are refused. Idle or guarding
crews start a run by themselves on anything within 900 that has lost a tenth of itself. A new
order calls a run off. The battle AI unlocks them now and then once it has warships (more often
the harder it is), keeps a squadron or two guarding its most valuable warship, and sends them to
its worst-hurt ship or station. Galactic conquest has no research, so there they are built like
any other ship.

**Repair orders.** With repair ships selected (the Mercy corvette, repair craft), a right-click on a
damaged ship of ours or an ally's repairs it (`cmdMend` in sim.ts, the `mend` order): the pointer
turns into a green ring with a cross and the ship is tagged "Repair"; on touch, the action wheel on
it has *Repair it*. Each repairer takes what it can mend: a Mercy patches the hull of any ship,
closing to just outside it and keeping it in reach (and patching it before the others round it);
repair craft mend stations and ships of gunship class or bigger, starting a Field repair run as
soon as the ability is ready and staying with the patient between runs. They keep at it until the
patient is whole or lost, then take their next queued order, or go back to the ship or structure
they were guarding or escorting, or wait where they are. In a mixed selection only the repairers
take the order; the warships move to the spot as on any friendly. On an undamaged ship the
right-click is the usual move. Engineers do the same for structures: a right-click on a damaged
structure of an ally's welds it back too (their sites and rush-launched ships are theirs to finish),
and whoever welds pays for rebuilding shot-off modules, Field repair crews on an ally's station
included. Enemies are refused by the sim and, online, by the server referee before the order
reaches anyone.

**Repair crews** (*Repair* on a structure's card, `cmdRepair`): for 60% of what's missing of the
structure's worth, a crew mends the hull and every module, rebuilding the shot-off ones, over 20 s.
**Under fire** they're slower (`REPAIR_FIRE` in sim.ts): while enemy warships or strike craft are
within a station's reach (its size, its guns' range and 250 more, `repairReach`), the crew works
at 25% of its pace and rebuilds no shot-off module; full pace comes back 4 s after the last of them
has gone, so ships slipping in and out of range gain nothing. A repair that ends under fire leaves
those modules off and pays back their share of the price. Players and the AI alike. The station's card says
so on the button itself, in gold ("Repair 723 · under fire", or "Repairing… 76s · under fire" with
the time at the slowed pace), and the tooltip says why; on a screen too narrow for the card's side
column (a phone) the button sits in the card's header, so it can be seen and tapped there. Before, a crew put back
5% of a station's hull a second and every gun shot off, under any fire, for at most 1,500 credits:
a station whose owner had money outlasted any fleet not far bigger than its own, and battles
between equal admirals rarely ended.

Every station also comes with a free **defense wing** (`DEFENSE_WING` in `data.ts`): the
Republic's five Aegis pickets or the droids' six Bolt guard droids, smaller and frailer than line
fighters. They cost nothing, take no fleet space and can't be built, retreat or escape with a
conquest fleet. Their station is their parent, as a carrier's fighters are theirs, and with no
orders of their own they guard it: each craft has its own slot in an even ring just outside the
hull, where it flies to, slows, stops and waits facing out (no circling). They take on any enemy
inside the reach of the station's turbolasers (measured from each turbolaser mount the way the
guns measure it, research range bonuses included, so it grows with the station), chase it at
most 250 further out, and fly back to their slots and park once it's dead or gone. They can be
ordered anywhere and come home to guard once their orders are done, but more than 1,400 from their station, or
once it's gone, their guns do 30% of their damage (they're drawn faded there, and the unit card
says so). Lost craft come back from the station's hangar one at a time: the first 15 s after the
last loss, then one every 25 s until the squadron is whole, even after it was wiped out. A
shot-off hangar holds that until the station's repair crew or a Field repair rebuilds it (the
countdown carries on the moment the hangar stands again); the station
card shows "Defense wing 3/5 · next in 12 s". Stations in conquest fleet battles have one too
(auto-resolve leaves it out). The AI's admirals never give them orders, so they cost no actions.

```sh
pnpm check:empires-repair   # Field repair: a station's hangar rebuilt and its wing back, a frigate's lost turret, determinism
pnpm check:empires-heal     # repair orders: a Mercy on ours and an ally's, back to escorting, refusals, mixed selections, engineers, determinism
```

## Galactic conquest fleets

In Empires At War's Galactic conquest every fleet carries its ships on a **grid of 6 by 4 cells**
(`GRID_W`, `GRID_H` in [`galaxy.ts`](src/apps/games/empires/galaxy.ts)), like a backpack in a
role-playing game, and each side keeps at most **4 fleets at a planet** (`MAX_FLEETS`). Every
ship takes up a footprint by its size (`FOOTPRINT`, wide by tall as it sits upright):

| Ships | Footprint | Per fleet at most |
| --- | --- | --- |
| Fighters, bombers, repair craft, pickets (the fighter tier) | 1×1, stacking up to 3 squadrons of one type (`STACK`) | 72 squadrons |
| Gunships | 1×1, one per cell | 24 |
| Frigates (also the droid ion frigate) and the Republic's repair corvette | 1×2 | 12 |
| Cruisers | 2×2 | 6 |
| Dreadnoughts and carriers (capital ships) | 2×3 | 3 |

Only strike craft stack: three frigates are three items. Each item on the grid either jumps in when
a battle starts or is **held back** (gold), waiting in the battle's reserve.

Selecting a planet, or a fleet of ours at one, opens **Fleets at <planet>**
([`Inventory.tsx`](src/apps/games/empires/Inventory.tsx)): our fleets there side by side, each its
grid with a bar of how full it is, and an empty *New fleet* column while there are fewer than 4.
- **Mouse:** drag a ship to a spot: the cells it would take light up green where it fits and red
  where it doesn't, **R** or a right-click turns a ship that isn't square on its side. Dropped on a
  stack of its own kind it joins it; dropped on a fleet's header it goes wherever it fits there.
  Shift drags half a stack, Ctrl one squadron. A click picks a ship up (the bar under the title
  sets how many of a stack, and turns it) and a click on a spot puts it down; a double-click sends
  it to the next fleet; a right-click on a ship turns it where it lies. After a move of strike
  craft the bar sets the exact count (− + All). Dragging a fleet's header onto another joins them
  as far as there's room; clicking a header selects that fleet for orders. Each header has
  **Arrange** (packs the fleet again, biggest first, stacks filled) and hold back all.
- **Touch:** tap a ship to pick it up and tap a spot to put it there (the touch bar's Shift takes
  half a stack); a long press opens a wheel: *Move*, *Move half*, *Move one*, *New fleet*, *Turn*,
  *Hold back* or *Deploy*, *Select fleet*. A long press on a fleet's header: select, hold back
  all, arrange, join another fleet. On a phone the fleets sit two by two.
- **Onto the map:** drag a fleet's header, or a ship (a stack, or with the mouse's Shift/Ctrl part
  of one), out of the panel onto a system or a planet (zoomed in), or onto a fleet's badge (where
  that fleet is headed), and let go: it gets the same move order a right-click there gives, over the
  hyperlanes and by the same rules (blockades, the front line). A system sends it to the planet a
  right-click would pick there. Shift (the touch bar's Shift with a finger) as you let go adds it as
  a stop instead. Dragged ships are split off first as a new fleet, the way *New fleet* makes one,
  so the cap of 4 and "only in orbit" apply; ships that are their fleet's whole grid just send that
  fleet. While over a target it's ringed with the way there drawn, and a label by the pointer says
  what letting go does ("Send Fleet 1 to Alderra · 2 jumps, ~3 days"), or in red why not ("Fleet 1
  can't go to Catonis. Blockaded: ..."); a refused drop gives no order and splits nothing off. Let go anywhere
  else and the ships go back. The new or sent fleet becomes the selection. A finger drags too: move
  off a ship or a header before the long press; once the finger leaves the panel it fades out of
  the way, with the selection's sheet and any other panel over the map (letting the finger through
  to the systems under them) until the drag ends, with the ship and
  the label shown above the finger. The order logic is `fleetToSend` and `sendPreview` in
  [`galaxy.ts`](src/apps/games/empires/galaxy.ts) (the preview runs the real orders on a copy).
- **Held back:** the corner icon on a ship holds it back or deploys it (the header's shield does the
  whole fleet). When the fleet fights, the rest jump in and the held back ships start in the
  battle's reserve tray, to be called in during the fight; ones never called in come out of a won
  battle untouched (and jump out with the rest of a lost one, except fighters, as with any
  reserve). The battle prompt shows the split. Auto-resolve counts held back ships in full but
  brings them in 4 seconds late (`RESERVE_CALL`), or at once when nothing else of their side is
  left.
- **Moves** only happen between our fleets at the same planet; a fleet in flight shows its grid
  read-only (it can still change what it holds back). A fleet that gives away its last ship is
  gone, and the selection follows its ships. Ships come out of a battle on the same spots of the
  same grids (held back ones first, as they waited in the reserve).
- **Full fleets:** a fleet with no room takes nothing more. Merging (a header dragged onto another,
  *Gather*) moves what fits and leaves the rest as a fleet of its own. A fleet flying in to a planet
  where we already have 4 folds into the others there when all of it fits (the one with the same
  stops queued first, then the biggest); when it doesn't, it **stays a fleet of its own past the
  cap** until we sort it out, but no new fleet is made there meanwhile.
- **The shipyard:** a finished ship joins the first fleet at its planet with room (one that is
  staying before one only stopping on its way), else a new fleet while there are fewer than 4.
  When every fleet there is full and there are 4, the ship **waits in the shipyard**, holding up
  the queue behind it, until a fleet makes room or leaves: the planet dock says "Fleets full" and a
  message says so once.
- **The AI** builds only where there's room, keeps its fleets at a planet together where they fit
  whole, and moves the fleets waiting beside its main fleet with it as one army (one order).
- **Old saves** (stacks without spots): every fleet is laid out on load, biggest ships first, its
  held back ships still held back; what doesn't fit forms another fleet beside it with the same
  orders, and spare fleets then fold in down to 4 where they fit.

## Galactic conquest orbit view and defense stations

Zooming in past a planet on the galaxy map locks the camera onto it: the **orbit view**
([`Orbit.tsx`](src/apps/games/empires/Orbit.tsx), the camera in
[`Conquest.tsx`](src/apps/games/empires/Conquest.tsx) `enterOrbit`, the panel in
[`PlanetMap.tsx`](src/apps/games/empires/PlanetMap.tsx)). Zooming all the way in, the planet settles
a little smaller and to one side, and its **battle map** sits pinned beside it (below it on a tall
screen, a phone held upright), overlapping the planet's orbit by about 40% (`orbitFrame`). The panel
has no handle: it moves with the planet, fading and sliding in over the last 15% of the zoom
(`panelIn`), so going in and out is one continuous glide rather than a snap. The camera goes no
closer than that (`K_ORBIT_MAX` at most) and keeps the planet where the frame puts it. The wheel
eases into it once it would zoom past the planet under the cursor (`ORBIT_SNAP`), and so do a pinch,
a double-click or a double tap on a planet, the zoom keys and buttons, *Orbit view* on a planet's
action wheel and the planet picture in its shipyard. Zooming or pinching back out (`ORBIT_LEAVE`),
Esc, the banner's *Leave* or a look anywhere else lets go.

The camera's glides (the wheel's zoom, flights to a place, going into the orbit view) are critically
damped springs (`Glide` in Conquest.tsx): the zoom (as its log, so every doubling takes as long) and
where one point is on screen each glide toward their aim, solved exactly for each frame's time, so
it's the same at any frame rate. A glide starts from however the camera was already moving, so the
wheel's or a pinch's speed carries into the snap rather than stopping and restarting; it never
overshoots; and more notches or a snap on the way re-aim it instead of jumping. The planet glides
sideways to its place beside the panel as the zoom settles; in the orbit view the wheel and a pinch
only zoom while it stays put, and leaving carries on from where the camera is. A flight far out
zooms round the point that stays in place, so nothing swings out and back. The orbit view's
pictures, panel and banner fade in as it's entered, and out over `ORBIT_FADE_MS` (taking no clicks)
after it's left, on top of the fade the zoom gives them. With *reduce motion* set in the system,
flights and the orbit view's ease go at once and nothing fades (the wheel still takes its short
glide, as it follows the hand).

- **Every planet has its own battle map** ([`conquestMap.ts`](src/apps/games/empires/conquestMap.ts)
  `planetMap`): generated from the galaxy's seed and the planet's id, its terrain by the planet's
  kind (asteroid fields round barren, volcanic and crystal worlds, nebulas round gas giants), the
  planet far below the battle. Every battle there is fought on it, and the panel shows the same map:
  its terrain, its rocks (scattered from the map's seed, as the battle scatters them), the planet,
  the Command Station's build radius and every structure as its real model at its true size and
  heading. The holder starts on the left (the home spawn).
- **Only what is built shows**, on the battle map and round the planet, each as it looks built: the
  Command Station at its level, a yard with its expansions, a defense station at its level with its
  modules. Ruins show darkened where they lie (rebuilt for half). An empty yard or defense site shows
  nothing; it is ordered from the shipyard's Yards and Defense pages, or from the Command Station's
  card, which lists the empty sites (each opens its site card).
- **Under construction:** once a yard or a defense station is being built (the head of the planet's
  queue; one waiting behind other work isn't started and doesn't show yet), it shows on the battle
  map and round the planet at its spot in the layout, drawn as what it will be, faint and hatched,
  with a bar under it filling up and the seconds left (`structWork`, `WorkBar` in
  [`Orbit.tsx`](src/apps/games/empires/Orbit.tsx); it updates with the galaxy's clock, ten times a
  second). A ruin being rebuilt shows the same way. It can be dragged and turned while it builds, and
  is saved in the layout; finished, it stands built at the same spot and heading. A station, yard or
  defense station being upgraded, or getting an expansion or a module, keeps its current look with
  the same bar. Its tooltip says *under construction* (or *upgrading*) and the seconds left. Battles
  fought before it is finished don't have it. On other sides' planets it shows only while we see the
  system (the fog of war hides their queues).
- **Entry zones:** each hyperlane into the planet's system has an entry zone of its own along the
  far side of the map, named after the system at its other end, in the order the lanes leave the
  system (from the west round through north, east and south), and a planet with neighbours in its
  system has one more for fleets coming from them. An attacking fleet drops out of hyperspace at the
  zone of the lane it came down (`Fleet.via`, `entrySpawn`); one that hasn't flown down a lane (built
  there, or from a save before the zones) comes in at the zone in the middle of the far side. The
  terrain and the rocks leave the zones open, and the defender's side is kept clear of them. Every
  zone is a spawn of the map (`MapDef.spawns`, home first) with its rocks kept back a little
  (`MapDef.keep`), and the map's rocks are its own all over (`sym: 'none'`), so the map is the same
  whichever lane the attack comes down.
- **Placing structures** (our planets): drag a structure on the battle map, with a mouse or a finger.
  The Command Station moves anywhere in the defender's third of the map (`homeZone` in
  [`sim.ts`](src/apps/games/empires/sim.ts): the third on the side of the middle the home spawn is
  on, along the axis it is furthest out on as a share of the map's size; every conquest map has its
  home on the left, so that is the left third), keeping `STATION_ENTRY_GAP` from the middle of every
  entry zone so attackers never drop out of hyperspace on top of the base, and takes the rest along.
  While it is dragged the third shows as a tinted box and the entry zones' keep-out rings in red; a
  spot outside says why and a drop there is refused. Anywhere within `HOME_R` of the home spawn (the
  old home circle) always stays allowed, so older layouts stand where they did. In battle its reserve
  jumps in by the station wherever it stands; the yards and defense stations move within its build radius, clear of rocks, asteroid
  fields, the map's edge and each other, each by its real size (the station at its level, a defense
  station at its level, one being built as what it will be). Only what shows counts: an empty site
  takes no room. A structure that grows later (a station or defense station upgraded) and no longer
  fits where it was moves to the nearest clear spot, in battle and on the map alike. A drop on another
  structure is refused naming it (*Too close to the Frigate Yard*); a drop on rocks, a field or past
  the edge goes to the nearest clear spot (`nearestClear`); anything else is refused with the reason. A click or tap on a structure (on the map or round the planet) picks it and opens its card;
  the card's *Reset layout* puts everything back at its default place and heading.
- **Turning structures** (our planets): a picked structure that stands shows a handle at its nose on
  the battle map; drag it round (mouse or finger, a bigger handle on touch screens) and the structure
  turns with it, in 5° steps. On a desktop the wheel over a structure, or R and Shift+R while it is
  picked or being dragged, turn it 15° either way (caught before R's fleet order). A double click on
  the handle turns it back the way it faces by default. The heading is kept in the layout
  (`LayoutPlace.a`, radians as a unit's), and battles there stand it turned so. A turn that no longer
  fits moves it to the nearest clear spot. Left unturned, a structure faces as before: the station
  towards the middle of the map, a yard away from the station, a defense station the way the station
  faces (so turning the station turns the defense stations nobody turned). Saves from before turning
  load with every structure facing its default way; enemy planets show the headings we last saw.
- **The wheel and pinches on the panel** never zoom the galaxy map or let go of the orbit view,
  anywhere on it, so a wheel meant to turn a structure that slips off it does nothing (over a
  structure of ours it turns it). A touchpad pinch (Ctrl + wheel) and a two-finger pinch on the
  panel are caught the same way.
- **Exactly as in battle:** the panel and the battle both work out where everything stands with
  `standBase` ([`sim.ts`](src/apps/games/empires/sim.ts)) on the same map with the same rocks: the
  station first, then the yards and the defense stations, each at its place in the layout
  (`Planet.layout`, in the map's world units, with its heading if turned) if it may stand there, else
  the nearest clear spot. A
  structure left out of the layout stands at its default (`autoLayout`: the yards on either flank a
  little behind the station, away from the entry zones, the defense stations either side in front of
  it), worked out for every structure at its biggest, so the defaults never shift as more is built.
  The galaxy AI's planets are laid out by default.
- **Round the planet:** the planet with its Command Station, yards (ruins greyed) and defense
  stations, each drawn as its real model from the same cached picture as the cards (`structArt`:
  nothing is painted per frame), pictured where the battle map has them turned back round the planet
  (`mapToPolar`, the station up and to the left of it), each turned as it stands on the battle map
  (its heading turned back round the planet the same way, `Spot.h`), so the two views always agree,
  default headings included. They orbit the planet together, once in twelve minutes, their headings
  turning with them (held still while one is picked, and for *reduce motion*). Moving and turning
  them happens on the battle map only. The camera places and fades the whole view with one transform, as the map's own
  layer is, so zooming renders nothing.
- **Enemy and neutral planets** show read only: terrain and entry zones always, and their structures
  as the fog of war allows (see below): where they stand now while we see the system, else where we
  last saw them (`Intel.layout`), marked *Last seen day N* or *Pre-war charts*. A planet we never saw
  laid out shows its default layout.
- **Closer than the system, not yet in orbit** (zoom over 9, the map's `B_BASE` band): each planet
  with a station shows a small picture of each structure where it sits round it, at least a little
  way out past the planet's edge, the station's level on the station's picture.
- **Orders:** a structure's card is built from the shipyard's own pages: the station's upgrade and
  expansions (and the empty sites), a yard (or the site to build it on, or its ruin to rebuild) and its expansions, a
  defense station's levels and module slots, with the planet's queue on top. A click on open space,
  or Esc, puts the card away.

**Defense stations** ([`data/<faction>.ts`](src/apps/games/empires/data/) `orbital`,
[`data.ts`](src/apps/games/empires/data.ts) `orbitalType`): up to two per planet (`ORBITAL_MAX`),
on two defense sites round its Command Station, ordered in the planet's queue like a yard (paid when
queued, refunded in full when called off), and on the shipyard's **Defense** page. Each has three
levels, each upgrade ordered in the queue too, with 1, 2 and 4 **module slots**; the player picks
the module for each slot (a module ordered into a full slot replaces what is there once it's done).
On the shipyard's Defense page each site is a compact tile (its picture at its real level, its
name and a state line: *Level 2 · 1/3 modules*, *Under construction · 37s left* with a progress bar,
*Ruin · rebuild for half*, or *Empty · build Bastion Watchpost 700 / 40s*). Tapping a tile opens the
same card as a click on that structure in the orbit view (it enters the orbit view and picks it): the
station's card on the left, its upgrade and its slots to the right, the modules to pick from below.
The tiles sit side by side on a wide panel and stack on a narrow one or a phone:

| | Republic: Bastion | Confederacy: Bulwark | Swarm: Guardian |
| --- | --- | --- | --- |
| Level 1 (station level 1) | Watchpost: 700, 40 s | Gun Post: 750, 40 s | Spore: 600, 34 s |
| Level 2 (station level 2) | Battle Station: 900, 50 s | Battle Station: 950, 50 s | Bloom: 800, 44 s |
| Level 3 (station level 3) | Redoubt: 1300, 65 s | Keep: 1400, 65 s | Hive: 1150, 56 s |
| Battery (against warships) | Turbolaser battery 450 | Heavy cannon battery 450 | Tendril lance 400 |
| Flak (against strike craft) | Flak battery 350 | Shredder flak 350 | Acid sprayer 300 |
| Launcher (through shields) | Torpedo launcher 450 | Missile battery 450 | Spore cannon 400 |
| Shield | Shield generator 400 (+1,400 shields) | Shield generator 380 (+1,100) | Regeneration pool 350 (+20% hull, regrows three times as fast) |
| Hangar | Hangar bay 550 (Lance squadron) | Talon hangar 550 | Brood chamber 500 (Stingers) |

Prices are credits, times galaxy seconds (modules take 14-24 s). Hulls grow with the level (2,600 to
6,200 for the Republic, more armour for the Confederacy, more again and a living hull for the
Swarm); a module is a part of the station that can be shot off (its gun stops, its shields go, its
hangar stops launching). Each faction's model ([`models/<faction>/orbital.ts`](src/apps/games/empires/models/))
grows on one shared frame (data/kit.ts `ORBITAL_FRAME`), so a module keeps its place as the station
grows round it: the Bastion's armoured hub grows truss arms to gun decks and closes an octagonal
truss ring, the Bulwark's gun hub bolts on sponsons and an armoured frame, the Guardian's chitin
bulb buds weapon lobes and a ring of petals. Every slot is a deck, sponson or lobe of its own; an
empty one shows its open port.

- **In battle:** they fight in every fleet battle at their planet, in orbit beside the station
  where the layout puts them, with their modules, and count in the auto-resolve (their whole hull
  and shields, their guns, and their hangars' squadrons) and in the battle prompt. Like the yards,
  they don't hold the planet on their own: they fall with the station.
- **After a battle:** one destroyed is a ruin; one that came through loses the modules shot off it.
  With the station lost (or the planet taken), every defense station is a ruin. A ruin is rebuilt
  at its level (as far as the station's level allows) for `REBUILD` of what its levels cost, its
  slots empty; work queued for a ruin is refunded.
- **The galaxy AI** (galaxy.ts `planBase`) builds one at its front planet once its yards are up,
  armed by the enemy fleets it sees (`pickOrbitalMod`: flak against strike craft, batteries against
  warships, a launcher against shields, then a shield and a hangar), then one at its forge world,
  modules for every one standing, the upgrades, and the second site; it rebuilds ruins with its
  yards. Its estimate of a planet's defence (`defence`, `baseGuard`) counts what was spent on the
  defense stations it knows of.
- **Saves:** campaigns are version 5 (`Planet.layout` on the planet's battle map, `Intel.layout`,
  `Fleet.via`); version 4 (`PlanetBase.orb`) kept the layout as bearings round the planet, turned
  onto the map on load where its battles stood them (`fromPolar`); older ones load with no defense
  stations and every structure at its default. Looks from before version 5 know no layout.

```sh
pnpm check:empires-gc-defense   # ordering, levels and slots, modules, ruins and rebuilds, auto-resolve, battles standing everything exactly where the planet's map has it, placing structures, the AI, old saves
```

## Galactic conquest fog of war

Each side sees only part of the galaxy ([`galaxy.ts`](src/apps/games/empires/galaxy.ts)
`updateSight`, `known`, `canSee`). A side **sees a star system** while it owns a planet there, has
a fleet there (in orbit, or flying between its planets), or the system is contested for it (one of
its planets being taken, or a battle it's in). Everything else is **hidden**:
- In a hidden system we see the star, the planets and their kinds, and **what we last saw**
  (`Side.intel`): who held each planet, its station level, where its structures stood on its battle
  map and the enemy ships in its orbit, drawn faded with dashed rings and "Last seen day N" under
  each planet (the planet dock, tips and the orbit view's battle map say the same). A new campaign
  starts with the **pre-war charts**: who held what and their stations, no word of any fleet. Never
  live fleets, stations being built, captures or shipyards.
- Enemy fleets show only inside systems we see; out on a lane they're in hyperspace and nobody sees
  them, so an attack shows up when it arrives. A fleet of ours flying through a system glimpses it
  on the way, and a side that loses a planet knows it even with nothing left there.
- Routes plan by what we know: a blockade we didn't know of pulls the fleet out of hyperspace when
  it gets there. The map, the galaxy minimap, tips, the planet dock, the selection, the economy's
  enemy estimate, messages and long-press wheels all keep to this. How many planets each side holds
  is public (the top bar's "8 vs 8"); the enemy's fleets and income are not (the economy shows a
  guess from what we last saw).
- **The AI plays by the same rules:** it reads planets and enemy fleets only through what its side
  sees and remembers. For a planet it has never seen the orbit of it guesses a small garrison
  (`FOG_GUESS`); its detachments taking planets nearby double as scouts. Scouts and probes as ships
  of their own are planned for later.
- Sight is worked out once a tick for every side and saved with the campaign; old saves start with
  the galaxy as it is on their charts and sight from what each side holds.

```sh
pnpm check:empires-fleets    # footprints, placing and turning, stacking, full fleets, merges, the shipyard waiting, old saves
pnpm check:empires-galaxy    # the AI's campaigns, the fog's rules, and the AI deciding the same whatever it can't see
```

## Empires At War attack positions

Warships (gunships and up) told to attack something, or picking a fight themselves, close in only
until **every gun that counts against that target** reaches it, with 8% to spare
([`sim.ts`](src/apps/games/empires/sim.ts) `stopDistance`). A gun counts when the ship would fire
it at that kind of target and it adds at least a fifth of the damage of its best gun there: flak
counts against fighters and gunships but not against capital ships or stations, so a flagship
shoots a carrier from turbolaser range instead of drifting into flak range. When several of a
side's warships attack the same target they spread over an arc on the side they came from
(`attackSpots`): each gets a spot sized to its hull at its own stopping distance, so long guns hold
further back, the arc grows with the group up to 120 degrees, and more ships form a second row
nearer in. Spots are handed out in the order the ships stand round the target and refreshed when
the group changes or every 4 seconds. Warships keep a small gap between hulls instead of
overlapping. Strike craft keep their strafing runs and dogfights.

**Holding a heading.** A warship that has reached its firing spot **settles** there (`Unit.settled`,
`closeIn` and `arrive` in sim.ts): it swings round on the spot only until every gun that counts
bears on its target (coming in nose first, that's at once), then keeps its heading while the
turrets do the turning. A new target, or one shifting about round it, changes nothing as long as
any gun that counts can bear on it (`bearing`: in reach from its hardpoint, inside its arc for a
gun fixed to the hull); a fighter darting out of reach is left to come back. The hull only turns
to bring a gun to bear when none can, to keep a gun fixed to the nose (a gunship's missiles) on
target, or to move somewhere new, and setting off from its spot unsettles it. The way in and the
way out are far apart (it settles once every gun reaches, and only leaves once none does), so it
doesn't jiggle round the stopping point. Holding ships (the Hold stance) work the same way. The
battle's turrets turn all the way round at once, so the hull never has to help them; only the
strike craft's and gunships' hull guns have arcs (lasers ±20°, missiles ±34°, torpedoes ±23°).

**Who pushes whom.** Hulls pressing into each other are pushed apart by class (`PUSH_CLASS`,
`pushClass` in sim.ts): strike craft 0, gunships and corvettes 1, frigates 2, cruisers 3,
flagships 4, structures never move. The smaller of two ships takes the whole push and never moves
the bigger one; what of its own way heads into the bigger hull turns into a slide round it, on the
side it's already on, so it steers round. A bigger ship coming through moves the smaller ones aside
out of its path, smoothly, a little each tick. Ships of the same class share the push as before.
A unit's own `pushClass` overrides its class's: the hook for a later ability that lets a ship
shove bigger hulls. Tractor lock only slows ships, so it doesn't touch this.

**Flying over.** Ships two or more classes apart don't touch at all (`overlaps`, `heightOf` in
sim.ts), friend or foe, the way strike craft have always flown over everything: gunships and
corvettes cross cruisers and flagships, frigates cross flagships. The small one flies straight
across, the big one doesn't shove it, so a flagship no longer gathers a clump of gunships pressed
against its hull. Gunship and frigate, frigate and cruiser, cruiser and flagship, and the same
class stay solid, and so do structures for everything but fighters. A unit's own `height`
overrides its class's. Formations no longer spread out to make room for a lone big ship among
small ones that fly over it (`spreadOf`). On screen a smaller ship is always drawn over a bigger
one (`drawRank` in render.ts: by class, then by id), with a faint soft shadow on the hull under it,
offset away from the light: its own silhouette, painted once per model into a small bitmap
(`drawShadow` in models/paint.ts), one `drawImage` per ship over a hull. A click picks the topmost
ship under the pointer, so a gunship over a flagship is picked, and the flagship's hull round it
picks the flagship; a hardpoint marker under a smaller ship gives way to it too.

**Escorts.** Guard (V) on a friendly ship two classes bigger escorts it (`escorts`, `wardOf`,
`escortSlot`, `keepStation` in sim.ts): each escort takes a slot of its own over the hull, down
both flanks in turn from bow to stern, handed out by id each tick, so several never stack (each
stands off the spine by a fifth of the big hull's beam plus a fifth of its own radius and 14, so
the two of a pair keep clear of each other on a narrow hull); the
slots are fixed to the hull, so the escorts move and turn with it, matching its heading and pace.
An enemy that comes within reach of an escort's guns of the ship (measured from its hull's edge) is
engaged, chased at most `ESCORT.leash` further, and then the escort comes back to its slot; a
holding escort only fires from its slot. Repair escorts mend their ship first: tenders patch it
before anyone else, Field repair crews start a run on it once it has lost 3% of itself. When the
ship is lost its escorts take their next queued order, or wait where they are. It is the ordinary
guard order, so it goes through `commands.ts` and the server unchanged. The map tags the escorted
ship "Escorting" and a selected escorted ship "Escorted by 3" (its card says so too), selected
escorts show a faint tether to it, and with Guard armed a ship the selection would escort is tagged
"Escort" (on touch, the wheel offers *Escort it*). The AI gives its flagship a repair tender and two
gunships as an escort, kept out of its waves.

```sh
pnpm check:empires-spacing   # the arc, the stopping distances, following a target that moves, determinism
pnpm check:empires-overlap   # flying over, still solid, escort slots, engaging and returning, repairs, losing the ship, determinism
```

## Empires At War messages and AI

Messages about a place carry a ⌖: clicking one (or tapping it, or Enter when it has focus) takes
the camera there and selects what it's about. On the galaxy map that's the planet taken, lost,
fought over or given a station, our fleet a new ship joined, or a fleet that arrived or was
stopped by a blockade; in battle it's the ship that was built, promoted or repaired, or the spot
of an alarm, a beacon, a survey or a salvaged wreck. The × still only puts the message away.

**On the screen, always.** Everything that floats over a battle or the galaxy map stays inside the
screen ([`fit.ts`](src/apps/games/empires/fit.ts)): tooltips go above their button, or below it
when that fits better, and are kept 8 px in from every edge; the hover unit card and the Codex's
part tips flip to the cursor's other side near an edge; the action wheel (and the group wheel) is
moved in whole, its title and labels included; the docked and dragged panels (the tactical map,
the unit card and build panel, the selection, the fleet inventory, the economy, the galaxy map's
dock, fleets and selection), the credits popover and the order hints are pushed back in (up when
they would clip at the bottom) whenever the window is resized or their content grows, and a dragged
panel keeps its saved spot, coming back to it once there is room again; the yard placement label
moves above the ghost near the bottom; and messages that don't fit let the oldest go out of the
top. A panel already on the screen, flush with an edge or not, stays where it is. The shift is
written onto the element (CSS `translate`) by measuring it once per change, never through React
state, so nothing measures, moves and re-measures in a loop.

```sh
pnpm check:empires-gui-fit http://localhost:5173   # against a running dev server, at four window sizes and a phone: panels on the screen, tooltips near the edges 8 px inside, a map dragged into the corner and the window shrunk, the tech tree, the action wheel in each corner
```

The AI plays like a person with limited hands, more limited the easier it is:
- **Galactic conquest** ([`galaxy.ts`](src/apps/games/empires/galaxy.ts) `galaxyAi`, `GALAXY_AI`):
  at most 3, 4, 8 or 14 orders a game minute (very easy to hard), counting fleet moves, splits,
  ships and station work. It keeps one main fleet at a staging shipyard near the front, defends
  planets under attack once it has noticed (40 s late on very easy, 6 s on hard), attacks a
  reachable planet it thinks it can beat and sees that attack through, and sends a detachment or
  two of a ship or two to take unclaimed planets nearby. It misjudges your strength by up to 40%
  (very easy) or 10% (hard) and now and then picks worse. Both sides start on the same income and
  fleet; only the AI's income multiplier differs (0.55, 0.7, 1 and 1.15). It plays under the fog of
  war like the player (see above): what it can't see it doesn't know. Each AI empire also has a
  profile (see below), picked from the galaxy's seed (`galaxyProfile`, the same on every load, so
  older saves get one too): a defensive one wants to be 15% stronger than a planet's defence before
  it attacks, gathers 30% more first and leaves you alone 30% longer; an offensive one 12% less, 20%
  less and 30% sooner (`GALAXY_STYLE`). Its fleet battles are fought with the same profile.
- **Fleet cap on the easy levels** (`cap` in `DIFFICULTY`, [`ai.ts`](src/apps/games/empires/ai.ts)):
  Easy stops building warships at a fleet value of 2,800, Very easy at 4,000 (not counting scouts and
  yard guards); Medium and Hard have none. Their long quiet start used to make the first wave bigger,
  not weaker: they stockpiled the whole time and sent it all at once (Easy's first wave came out
  larger than Medium's). Waves on those levels go out at 70% of the cap at most.
- **Battles** ([`ai.ts`](src/apps/games/empires/ai.ts)): at most 25, 35, 60 or 100 actions a
  minute (a move for a group of ships is one), and it notices an attack on its base 6 to 1 seconds
  late. It runs on the battle's own clock and dice, so multiplayer copies stay in step.

**Battle AI profiles.** Next to its difficulty, every AI seat has a style: **Defensive**,
**Balanced** (the default) or **Offensive** (`PROFILES` in ai.ts). It's picked in the skirmish
setup (remembered with the other setup fields) and by the host for AI seats in the multiplayer
lobby, and it's part of the match config (`MatchSeat.profile`), so every copy of a battle and the
server referee run the same admirals. Setups, matches and saved battles from before profiles play
Balanced. Every profile plays the same game, with a purpose:
- **Economy:** it claims and mines the ore on its half first, and once that's all built on reaches
  for the ore in the middle; it deepens its drills and shields its platforms when it's flush.
- **Station:** it goes up a level on its profile's timetable, once it has a fleet worth the
  investment, and saves for it in the last 45 seconds or so rather than stalling the yard for
  minutes.
- **Research** (`pickTech`): the station's refinery once mines pay for it, the repair dock once it
  flies cruisers or flagships, the station's guns (more the more defensive, and while its base is
  attacked), the repair craft once it has warships, and upgrades for the ships it flies most by the
  credits of them, range, armour and shields first. Nothing but the refinery at level 1.
- **Ships** (`pickShip`): every ship it could build is weighed by how well it does against the
  enemy fleet it has seen (the damage it deals to that mix per credit, times how long it lasts
  under that mix's fire, from the same tables the guns use; it remembers what it saw, fading over
  a couple of minutes), by how far up the classes it is (frigates, then cruisers, then a flagship
  once its fleet is worth a flagship), and by its profile's taste. Ion frigates only against
  shields, a repair tender for a big fleet, repair craft for its warships.
- **Fighting:** its fleet waits on the nearest beacon in the middle while it's a match for what it
  has seen of the enemy (holding it), else in front of the station. A wave goes out once it's big
  enough and bigger than the enemy fleet it has seen, gathers at the rally point first and goes out
  together; ships built meanwhile follow in batches. It picks goals it can take (mines, platforms,
  beacons, the station, counting the guns of stations and platforms there), fires its warships on
  one target at a time (`focusFire`: kept till it's dead; heavy guns at the shield generators), uses
  its abilities, and turns back once it has lost too much or meets a much bigger force. Cruisers and
  flagships badly hurt go home to the repair dock or the repair craft and rejoin once whole. It
  defends an outlying mine only when it can win there; against more it waits under the station's
  guns.
- **Sieges** (medium and hard): a wave going for the enemy station gathers just out of reach of its
  guns, on the side it comes from, and the ships that follow it out join it there rather than fly
  into the guns a few at a time. It goes in once what has gathered is twice what it knows guards
  the station and hits harder than the station's repair crews can mend under fire (`SIEGE`), or after
  90 seconds there with half as much again as it knows of. When the assault is down to 40% of what
  went in, the rest pull back to the gathering spot and try again with the new ships. A wave that
  comes no closer for two and a half minutes with nothing to fight (stuck) comes home to gather
  again (`STALL`). With a wave out far from home and 3000 credits or more, it buys its new ships as
  reinforcements and calls them in beside the wave, surcharge and all (`frontline`): on a big map the
  side that lost a fight in the field had otherwise built its fleet again at home before the
  winner's new ships had flown across. Ships with their engines shot off stay at home (a group flies
  at its slowest ship's pace), and a ship slowed for a moment isn't given the group's order until
  it's free.
- **A big bank at the fleet limit** (8000 credits, within 6 of the limit; medium and hard): it picks
  ships by what they're worth per place in the fleet rather than per credit, and sends its cheapest
  gunships at home out through hyperspace (for part of their price back) to make room for cruisers
  (`REFIT`); lamed ships go the same way.

| | Defensive | Balanced | Offensive |
| --- | --- | --- | --- |
| First wave at (fleet value, × difficulty's) | 1.6 | 1 | 0.7 |
| Fleet must be this much bigger than the enemy's it has seen | 1.5× | 1.25× | 0.9× |
| Quiet start (× difficulty's; medium 150 s) | 1.3 (195 s) | 1 (150 s) | 0.6 (90 s; easy levels keep theirs) |
| Rest between waves | 90 s | 45 s | 15 s |
| Wave turns back below / against | 50% / 1.2× | 40% / 1.5× | 25% / 2× |
| Calls a wave home when the base is hit by | 35% of it | 60% | 120% |
| Fights for an outlying mine with | 1× the attackers | 0.85× | 0.6× |
| Station level 2 / 3 / 4 due at | 130 / 320 / 540 s | 170 / 400 / 680 s | 200 / 460 / 800 s |
| Fleet value per station level before upgrading | 600 | 900 | 1000 |
| Gun platforms on ore (level 1-2 / 3 / 4; only with *Defense platforms on ore* on) | 1 / 2 / 3 | 0 / 1 / 1 | 0 / 0 / 1 |
| Mines on top of its difficulty's (+1 from level 3) | 0 | +1 | +1 |
| Raiders after your mines | none | none | 2 ships, from 4 min |
| Counter-attacks | when your attack fails, or the fleet it has seen of yours is small | when your attack fails | no |
| Heavy ships go home to mend below | 50% hull | 35% | 25% |
| Fleet battles: pulls out below / meets attackers at | 40% / 0.8× | 30% / 1× | 20% / 1.6× |

How it fares, headless (medium, Kessar Belt and Cinder Gate × 5 seeds, both
sides): these admirals beat the earlier one in 51 of 60 battles (Defensive 17, Balanced 18,
Offensive 16 of 20), where the earlier one against itself wins 5 of 6 for the Republic side. Head to
head, Balanced and Offensive edge out Defensive (22-14, 20-16, 12-24 over 36 battles each).

```sh
pnpm check:empires-galaxy [weeks] [runs] [turtle|expand]  # campaigns vs a scripted player: orders a minute, fleets, wandering, the fleet cap, the difficulty ranking, the fog of war
pnpm check:empires-fleets                                 # the fleet inventory: moves, the cap, held back ships into battles, old saves
pnpm empires:battle-ai [games] [minutes]                  # AI-only battles: wins per pairing, actions a minute against the cap
```

## Empires At War procedural models and the Codex

Every ship and structure of both sides is drawn as a procedural model built from parts
([`src/apps/games/empires/models/`](src/apps/games/empires/models)), cel-shaded like the
cartoon: flat fills in three hard tones, a heavy dark outline, panel lines, stripes, windows and
engine light. They are the only pictures of the ships and structures: the game loads no sprites for
them (the pictures in `public/games/empires/` are the world's: the backdrop, rocks, ore, beacons,
planets, the emblems, the title and the research icons).

Each side is a family. The **Republic** builds angular off-white wedges with deep red bands, grey
machinery and blue engines: the Lance interceptor, the blunt twin-engine Hammer bomber with its
bomb bay and torpedo racks, the Suture repair fighter with manipulator arms and a green repair hub,
the Aegis picket in the defense wing's gold bands, the Halberd gunship with a ball turret on each
wing, the Mercy corvette with its green repair ring and crane booms, the Warden frigate, the long
Paladin cruiser with its turbolasers in a row on an armoured spine, the Sentinel destroyer, a slim
dagger with three shield-projector domes (two on armoured flank sponsons, one on the spine) joined
by glowing power conduits, the Sovereign dreadnought with a flight-deck trench and twin bridge
towers, and the Resolute battleship, a broad dagger with a sunken flight deck between two
flight-bay sponsons and a raised two-tier command bridge aft. Its Bastion station is a squared-off military
platform of plates and girders that grows with its level: a compact eight-sided core at level 1,
short arms with docking pods and a girder frame at level 2, long arms, big pods and dry docks at
level 3, and a great outer frame on struts at level 4, square with corner bastions or octagonal
(the battle uses `STATION_FRAME` in [`republic/craft.ts`](src/apps/games/empires/models/republic/craft.ts);
the Codex shows both). The **Confederacy** is an industrial droid navy
([`droid/craft.ts`](src/apps/games/empires/models/droid/craft.ts)): weathered sand and bone plating over dark
gunmetal, rust-brown and dull blue-grey panels, rivets, red and amber sensor eyes and blue-white
engines, long spines with heavy forward sections, tall sails, boxy engine blocks and rings and
spheres for the biggest hulls. Its fighter is a flying droid with a row of eyes and folding
wing-legs, its bomber a twin-hulled cousin with a bomb bay between the hulls, its repair craft a
blocky welder with manipulator arms, its guard droid a small gold-banded three-blade, its gunship a
ball head on three long cannon arms. The ion frigate is a slim spine behind a great emitter dish,
the line frigate a spine with a big armoured bulb and a tall sail, the cruiser a narrow destroyer
with a towering sail and swept gun galleries either side. The flagship is a ring hull open at the
front round a core sphere, docking-bay gaps between them (it breaks into ring segments and the
sphere, the `ring` break style); the Codex also shows a broad carrier design on the same
hardpoints (`CAPITAL_DESIGN` picks the battle's). Its station is built round a sphere core on a deck
plate, gaining ring arcs and docking arms at level 2, the closed ring with hangar segments and gun
pods at level 3, and an outer frame joining gun towers with antenna spires at level 4. The platforms
of both sides stand on clamp legs that hold them to their asteroid.

The **Swarm**'s models ([`swarm/craft.ts`](src/apps/games/empires/models/swarm/craft.ts) and
[`swarm/warships.ts`](src/apps/games/empires/models/swarm/warships.ts)) are living organisms in
chitin and violet, with weapon organs of their own (tendril lances, acid sprayers, spore cannons,
brood chambers) drawn in [`swarm/mounts.ts`](src/apps/games/empires/models/swarm/mounts.ts).

- **The format** ([`types.ts`](src/apps/games/empires/models/types.ts)): a model is a list of
  parts, each a polygon (with holes for rings) in a colour role (`hull`, `accent`, `metal`…), a z
  order, and optionally a facet slope (which way it faces, for the shading), a lift (it stands up
  from what's under it: a hard drop shadow and lit and shadowed rims), details (panel lines,
  stripes, lights) and a reason to come off (`detach`: when a hardpoint is destroyed, below a hull
  share, or only at death). Ships are drawn on a box 100 units on the long side, nose up; the
  station in the pixels of its frame (`STATIONS` in data.ts). The helpers in
  [`kit.ts`](src/apps/games/empires/models/kit.ts) build wedge hulls, outlines from half-width
  rows (`halfHull`), tapered sections, wings, engine pods, capsules, smooth organic outlines
  (`spline`), tapering bands along a line for limbs and spars (`thick`), rings, chamfered blocks
  and mirrored pairs (`sym`). Each faction's palette is its own (`models/<faction>/palette.ts`:
  off-white, deep red and blue light for the Republic; sand, rust and gunmetal for the droids; bone
  tan and violet for the Swarm; plus green for repair craft and gold for a station's own defense
  wing).
- **Hardpoints:** turrets, shield generators, hangars and station modules are mounts placed by
  the model builder on the unit's own hardpoints from [`data.ts`](src/apps/games/empires/data.ts),
  one per hardpoint and in the same order, so they sit exactly where the battle aims and the
  markers show. Destroyed flak turrets blow off (a burnt socket stays); heavy guns, shield
  generators and modules stay on, wrecked. Each faction draws its own mounts
  (`models/<faction>/mounts.ts`); [`mounts.ts`](src/apps/games/empires/models/mounts.ts) builds
  and keeps them.
- **Lighting and caching** ([`paint.ts`](src/apps/games/empires/models/paint.ts)): the light
  comes from the top left of the screen, so a facet's tone (lit, base or shadow) is worked out for
  the ship's heading. A hull is painted once into a bitmap per size bucket (steps of √2 from 32
  pixels, so a bitmap is at most about half as big again as it shows), per light heading and per
  damage state, kept in one cache with a memory budget (112 MB, 48 MB on phones), and turned to
  the exact heading when drawn. There are 64 light headings (under 6° apart) at the sizes ships
  show at in battle and 32 for specks, for the few big bitmaps and on phones; fragments tumbling
  away use 8. A heading is only painted when a ship first turns to it, at most 3 ms of painting a
  frame (past that, the nearest heading already painted stands in, and a hull that has just taken a
  new scorch mark or lost a part keeps its look of a moment ago until there is time). Strike craft
  and gunships share one burn layout, so a swarm doesn't multiply the bitmaps. As a ship turns,
  the two nearest headings are crossfaded over the middle of each step, so the shading moves on
  smoothly instead of popping (`lightTuning` in paint.ts; a linear blend and the old snap can be
  compared there). Turrets get the same treatment in bitmaps of their own, because they turn to
  aim, at most 128 pixels across (32 headings above 64 pixels), drawn larger up to 192 pixels on
  screen and painted live past that. A hull (or a wreck's piece) whose bitmap would be more than
  362 pixels on its long side (256 on phones) is painted live, with exact light: one heading of a
  Big flagship at that size is about half a megabyte and a full turn paints 32, so caching it
  filled about 53 MB of a 48 MB phone budget (`memTuning` in paint.ts; `legacy` puts the old 720-pixel rule back, to
  measure against).
- **Damage:** scorch marks spread as the hull drops (four levels, with burnt-through holes at the
  worst); parts come off at their hull share and fly away tumbling and smoking; wrecked mounts
  show broken. All of it follows from the battle's own state.
- **Death and wrecks** ([`fx.ts`](src/apps/games/empires/models/fx.ts)): fighters, gunships
  and structures burst into fragments that fade (a station's and a platform's slabs tumble slowly
  and linger); flecks of debris are only drawn for a unit that died out of sight. Frigates,
  cruisers and flagships leave the battle's wreck as before (`leaveWreck`, salvage, decay are
  unchanged), and the hull lies there
  in one scorched piece, broken in half or in several pieces drifting slowly apart, until the wreck
  is salvaged or drifts off. Which one is picked from the wreck's id and the map's seed with
  integer maths (`breakOutcome`, weights per class in `BREAK_WEIGHTS`), so every player in a
  multiplayer battle sees the same break. Nothing of this touches the battle itself.

- **Menus** ([`Hud.tsx`](src/apps/games/empires/Hud.tsx) `ShipArt`, `unitArt`): unit cards,
  the shipyard, the fleet inventory and its tiles, Galactic conquest's fleet grids, tooltips and
  the tech tree show a still of the model (nose up, under the world's light, with its mounts, a
  shot-off one wrecked), painted once per look by `thumbnail` in paint.ts and kept as a data URL;
  an expansion module in a queue shows on its own (`moduleThumbnail`).
  A ship dragged from the fleet inventory is ghosted as its model too.

**Ship sizes.** Every ship bigger than strike craft is built bigger than its numbers in
[`data.ts`](src/apps/games/empires/data.ts) were first written for, by its class, and that is the
only size there is: `data.ts` applies [`sizes.ts`](src/apps/games/empires/models/sizes.ts)'s
`sized()` to every unit once, so the sim, the renderer, the Codex and every card and tooltip use the
same unit types. (Battles, lobbies and campaigns once offered a choice of *Classic* sizes, the
numbers as written. A campaign saved as Classic loads at today's sizes; a battle saved mid-fight at
Classic sizes can't be carried on, and says so when it would be resumed, see `outdatedSnapshot` in
[`snapshot.ts`](src/apps/games/empires/snapshot.ts); the server drops such a battle kept over a
restart.)

- **Size** (`SIZE_CLASSES`, `sizeClass`): strike craft ×1, gunships and corvettes ×1.15, frigates
  ×1.4, cruisers ×1.7, flagships ×2.5, stations and platforms ×1. The yards grow with what they
  build: the Frigate Yard ×1.4, the Capital Yard ×2.5. The hit radius, collisions, the keep apart
  spacing, spawning and jump-in spots, guard posts, Field repair orbits, building placement and
  turret and module sizes all follow the hull. A warship looks round itself for hulls to keep clear
  of as far as the biggest hull there can be, so a gunship makes way for a flagship as much as the
  other way. Scattered rocks keep clear of each start's build radius, so the yards have room.
- **Hardpoints** (each faction's `layout`, merged as `BIG_LAYOUT` in data.ts): every warship with
  hardpoints has a layout on its 0-10 grid, one
  turret per gun, spread over the hull with room between them. Carrier fighters launch from the
  hangars where they sit.
- **Handling** (`HANDLING`): turn rate ×0.9 / 0.8 / 0.72 / 0.65, acceleration and braking ×0.9 /
  0.8 / 0.7 / 0.6, top speed ×1 / 0.95 / 0.92 / 0.88 for gunships / frigates / cruisers /
  flagships, on the numbers as written.
- **Reach**: every gun reaches as far past its hull as it did, its range growing by as much as the
  hull's radius grew, so a 2.5× flagship doesn't spend half its range on its own hull. Formations
  and the repair tenders' reach spread out by `BIG_SPREAD` (×1.3, or the biggest ship's class).
- **Designs**: every ship bigger than strike craft is drawn in the same calm style, for all three
  sides: the Republic's in [`republic/warships.ts`](src/apps/games/empires/models/republic/warships.ts),
  the droid navy's in [`droid/warships.ts`](src/apps/games/empires/models/droid/warships.ts) (the
  Gyre in both its ring and carrier designs) and the Swarm's in
  [`swarm/warships.ts`](src/apps/games/empires/models/swarm/warships.ts), with the shared helpers in
  [`proto.ts`](src/apps/games/empires/models/proto.ts). Big, quiet surfaces (long
  armour plates, trenches, a few lights), strong superstructures, and each gun on its own pad or
  barbette. The gunships keep their shape with a calmer surface (`calm`). Cruisers break into three
  chunks, the flagships into four, the Gyre's ring into segments round its core.
- **Bolts**: slim and long (`BOLTS` in render.ts), so they read as streaks of light next to the
  big hulls.

A move order never ends on top of a station or platform: the spot is moved out to the first place
clear of its hull (`offRocks` in sim.ts), so a big hull arrives instead of being pushed back for
ever.

The Codex's *Size classes* lays out every ship of a side (the Swarm's too) on one scale.
`pnpm check:empires-models` checks every ship's layout, and that its turrets have room between them.

**Adding a unit's model:**

1. In its faction's data (`data/<faction>.ts`), give the unit its box (`aspect`, `size`) and its
   hardpoints and engines on the 0-10 grid, as before.
2. Write a `ModelDef` in the faction's models folder (`models/<faction>/craft.ts` or
   `warships.ts`) that returns its parts on the unit's box,
   100 units on the long side, nose up (a hardpoint at grid (gx, gy) sits at
   ((gx / 10 − 0.5) × w, (gy / 10 − 0.5) × h)). Leave solid hull under every hardpoint, give
   frigates and bigger at least four parts that come off as they are battered, and tie engine
   pods to engine hardpoints (`detach: { hp }`) or engine glows (`engine`).
3. List it in the faction's `models/<faction>/index.ts`, and give any new part names a friendly
   name in [`codexInfo.ts`](src/apps/games/empires/codexInfo.ts).
4. Run `pnpm check:empires-models` (it fails for any unit without a model), and look at it in the
   Codex's Workshop: damage it, detach its parts and destroy it a few times.

**The Codex** (main menu → Codex, [`Codex.tsx`](src/apps/games/empires/Codex.tsx)) lists every
ship and structure of both sides with its numbers: hull, shields, speed, turn rate, sensors, fleet
space, cost, build time, station level, firepower, each weapon (damage, burst, range, reload),
hardpoints, what it beats and what beats it, and its ability, next to a view of its model, nose
up. Drag to turn it, scroll or pinch to zoom, **Reset view** to go back; a station
has a level switch and, at level 4, a switch between the two outer frames.

Every module and named part can be looked at ([`codexInfo.ts`](src/apps/games/empires/codexInfo.ts)
holds the words): hovering one outlines it on the model and shows a tip (name, type, health, and
for a gun its damage, rate, range and what it is good against); clicking or tapping selects it,
which adds a **Module** section to the specifications (what it does, what losing it costs the
unit, whether it is blown off or stays on wrecked) and rings a gun's reach on the model. The
hardpoint list in the specifications selects and highlights the same way. Esc or clicking empty
space clears it.

**Workshop** mode adds tools for checking models: a click tool (**Inspect** selects, **Damage**
takes half a module's health and then destroys it, **Detach** shoots a part or a flak turret off),
hardpoint markers, weapon ranges, engine glow, part outlines (detachable parts orange, engines
blue), **Spin** (off by default) to watch the light move, a hull slider, a Detach button per part,
and **Destroy**, which plays the death the battle would show; pressing it again re-rolls how it
breaks, or the break can be forced (intact, half, pieces). On a touch screen, holding a finger on
a module or part opens a wheel: Inspect, Damage, Destroy, Detach. On a phone the list becomes a
row of chips over the view and the numbers.

**Warp out**, on a gunship, frigate, cruiser or flagship, plays that ship's retreat on the view.
The drive charges for a few seconds (the same drawing as a battle, only the wait is shorter), then
it jumps out the way its side does: the Republic stretches into a hyperspace streak, the
Confederacy lurches through the rift it tore open, the Swarm flies into the wormhole ahead of it.
After a short pause the ship fades back in where it was. Pressing the button again restarts the
sequence; choosing another unit cancels it. Fighters, bombers and structures have no hyperspace
drive, so they have no button. The charge and the jump play the battle's sounds when the game's
sound is on.

```sh
pnpm check:empires-models   # every unit has a model that builds, its mounts match the hardpoints, parts come off soundly, breaks are deterministic and weighted, small craft and structures burst into real fragments
```

## Empires At War launching from the yards and reinforcements

New ships no longer jump in from hyperspace: they fly out of where they were built
([`sim.ts`](src/apps/games/empires/sim.ts), *Launch*). A frigate or corvette slides out of the
Frigate Yard's berth through its mouth, a cruiser or flagship out of the Capital Yard's; fighters,
bombers, gunships, engineers and repair craft come out of the Command Station's hangar door (the
craft of a squadron one after another). Rush-launched ships come out the same way, scaffolding and
all. The docking lights at the mouth blink while the engines spool up (`LAUNCH.spool`, 0.8 s), then
the ship slides out in 1.1 to 2.1 s by its way out (`LAUNCH.slide`, `perUnit`, `slideMax`), comes
clear at 70% of its top speed and flies on to the yard's rally point. It neither steers nor fires
until it is clear, and a destroyed yard lets it go at once. Something solid in the way out (where it
comes clear, or half way there) holds it back, but never longer than `LAUNCH.wait` (6 s); a ship two
classes smaller flies out over a big one (see overlaps), fighters over everything, and two ships
finished at once by a Second slip leave one after the other. It is all in the sim, so lockstep
battles stay in step.

While a yard builds, its gantry cranes (the droids' ring frames) weld the ship in its berth with
small green beams, from the two gantries nearest the welding front, a flash and a few green sparks
where they hit. These and the engineers' welding beams are sized in world units, so they shrink
with the ships as the camera pulls back: the core is never thinner than a pixel, and the flash and
its star of sparks are left out once they would be a few pixels (`WELD` in
[`render.ts`](src/apps/games/empires/render.ts)). The support ships' repair tethers and a site's
welding front are in world units too. All of them are fixed colours faded with `globalAlpha` and
glow sprites, with nothing made per frame.

**Call in reinforcement.** The small red button on a ship's card (now showing its price, the card
itself showing the plain one) buys the ship as a reinforcement: it is built as usual, then waits in
the fleet inventory, to be dragged onto any spot your fleet can see, as the reserve always worked.
Choosing where it arrives is the advantage, so it costs a surcharge: 15% by default, rounded to
5 credits and at least 25 (a frigate 820 + 125, a fighter squadron 260 + 40). A cancelled one is
refunded in full, surcharge included. Strike craft can be reinforcements too. A click on the card
always builds a ship that flies out; a reinforcement is only ever the red button's choice.

**Lobby options**, in the skirmish setup and the multiplayer lobby (the host's to change), part of
the match config and remembered with the skirmish setup: *Strike craft* On/Off, *Warships*
(gunships and up) On/Off, and the *Surcharge*, 0 to 50% in steps of 5. With a class off, its cards
have no red button, the sim refuses the order and the server's order cleaning drops it
(`cleanCmd`); the server cleans the lobby's rules as they come in and again when the battle starts
(`cleanReinforce`), so a tampered client can't set a free or negative one. Matches and setups from
before the options get the defaults. A battle saved mid-fight before them (its world has no
`reinforce`) keeps its old ways: new ships jump in beside their yard, the reserve costs nothing
extra and strike craft can't go in it.

**The AI** builds ships to fly out as before, and pays for a reinforcement only where flying out
from home is too slow: a mine, platform or beacon of its own more than `REINFORCE_AI.far` from its
station with enemy ships at it, or the wave out now far from home and fighting something about its
match. Medium and harder admirals only, at most one a minute, a warship (no flagships) with credits
to spare, called in a little back from the fight, towards home.

```sh
pnpm check:empires-launch   # out of the right yard or the hangar to the rally point, a blocked mouth, reinforcements and their price, the lobby's variants, old saves, save and restore, the AI
pnpm check:empires-panels http://localhost:5173   # against a running dev server: the build panels and unit cards at five window sizes and a phone, nothing scrolling, wrapping or cut off, simple cards with their text
```

The build panels of the Command Station and the yards fit their card at every window size: the
building tabs keep to one row (with three or more, their pictures alone, names in the tooltips),
and the ship and expansion cards share out the width side by side, at most two rows of them, at
one compact height. A unit card shows its description and role line (strong and weak against)
whenever they fit; when its rows would not (engineers with their yards, an escorted flagship, a
rushed ship), the description gives way first, then the role line, and its ⓘ always has both
(`useFitLines` in [`Hud.tsx`](src/apps/games/empires/Hud.tsx) measures when the card's rows change
or it is resized, never per frame).

## Empires At War jumps by faction

Every side arrives and leaves its own way: reinforcements and reserve ships called in, fleets at the
start of a fleet battle, and warships that retreat. Only the look and the sound differ; the timings
are the battle's (the warp delay, `RETREAT_TIME`), the same for everyone, so lockstep battles are
untouched. The style is picked from the ship's faction (`WARP_STYLE` in
[`warpfx.ts`](src/apps/games/empires/warpfx.ts)); adding one is a new `WarpStyle`, its entry there,
and its branch in `WarpFx` and in `JUMPS` in [`sound.ts`](src/apps/games/empires/sound.ts).

- **Republic: hyperspace.** Light gathers where the ship will be, with turning rings and streaks
  reaching back; it streaks in, stretched long, and snaps to a stop. A retreating ship gathers
  light and tightening rings, then streaks away ahead. Drawn in
  [`render.ts`](src/apps/games/empires/render.ts) (`drawWarps`, `drawCharge`, `drawDeparts`).
- **Swarm: wormholes.** While the jump charges, a wormhole tears open behind the drop point: a
  dark throat ringed by a bright, warbling rim, spiral arms turning into it, and the space round it
  bending in (spokes curling harder the closer they get, ripples sinking inward). The ship shoots
  out of its mouth, growing to full size, and the hole collapses behind it in a pulse, with a wet
  spray of its engine colour. A retreating ship bends space ahead of it first, then the hole opens
  from a pinprick, swirling and throbbing harder as the drive charges, with strands of light
  spiralling off the bow into it; the ship flies in, shrinking and stretching into the throat, and
  the hole swells, collapses and goes in a last pulse. Its sound is a deep organic drone that
  throbs faster as it opens, and a wet whomp.
- **Confederacy: rifts.** A jagged red crack forms across the ship's heading behind the drop
  point, branch by branch, burning hotter, flickering and juddering, spitting embers. When the
  jump lands it splits wide and the ship is shoved out of it (its stern hidden behind the crack's
  jagged edge until it clears), overshoots and recoils onto its mark, and the tear snaps shut in a
  red burst of sparks, leaving fading cracks and embers. A retreating ship tears one open ahead of
  it while it charges; the rift gapes, the ship jolts back and lurches in, and it slams shut with a
  red flash and sparks. Its sound is electrical crackle over a harsh, stuttering buzz, and a ripping
  tear with a heavy thump.

Each crack's shape is made once, from a seeded random number generator: from the drop point for a
ship coming in, from the spot ahead of it for a retreat (the one it tears open on the way out is the
one it was tearing while it charged). Only how much of it shows changes. The soft parts of a
wormhole (its glow, throat, rim and swirl) are sprites painted once per side, the rest is a few
strokes; a wormhole small on screen leaves out the bent space and the details. Line widths have a
floor in screen pixels, so both read at every zoom. Twenty jumping in at once (a fleet battle's
start) cost about as much to draw as twenty Republic jumps. The retreat's charge arc round the ship
is the same for all three.

## Empires At War rush launch

A desperate measure for a base under attack. Once **Rushed construction** (the droids' **Hasty
assembly protocols**) is researched (800 credits, 45 s, station level 3, and it needs a Capital Yard
standing; it shows on the tech tree's Capital Yard line), the Capital Yard's build queue shows a
**Rush launch** button beside the ship in progress (not for fleet-inventory builds). It is always
there, so it can be found: disabled as **locked** (the tooltip names the research needed), **at 50%**
until the ship is half built, and **Rush launch · 1:12** while the yard cools down; enabled as
**Rush launch (62%)** otherwise. A click sends it out now; on
a touch screen the button is held for 0.6 s (a ring fills round it) so a stray tap can't do it.

- The ship flies out of the berth with its hull at the share that was built, no shields, and as many of its
  turrets and modules as were still to be built not yet installed: the ones furthest aft, drawn as
  scaffolding (not smoke or fire), and they don't fire or work. Its card and tooltip say
  "Rushed: 3 of 11 turrets and modules not yet installed · 23 s of work to finish it".
- Finishing it takes the build time it had left, at the build pace, only while a Drydock, repair
  craft or engineers work on it (engineers ordered onto it, or idle ones nearby by themselves);
  several of them don't make it faster. Its unbuilt hull fills in and its parts go on one by one
  (whole) as it goes, free of credits. Ordinary repairs (the Drydock's 2.5%/s, repair docks, repair
  tenders, Field repair, Damage control) mend battle damage but never the unbuilt hull
  (`hullCap`), so rushing never gets a ship out finished sooner.
- The yard can't rush again for `RUSH.cooldown` (120 s), and the next ship it starts takes
  `RUSH.slowdown` (25%) longer. `RUSH` in [`data.ts`](src/apps/games/empires/data.ts) holds the
  numbers; in a dev build the F9 cheats can change them live on a local battle (`World.rushTune`).
- It is an order like any other (`rush`), checked by the server and deterministic. The AI admirals
  research it by profile (Defensive as soon as it can pay, Balanced with credits to spare, Offensive
  only when rich) and rush only with their base under a real attack, or with the enemy's warships
  near home well outnumbering theirs.
- Galactic conquest has no research yet and its planet battles start with empty yard queues, so it
  doesn't come up there.

```sh
pnpm check:empires-rush   # the gates, the ship as it launches, finishing it, cooldown and slowdown, save and restore, the AI
```

## Empires At War defense stations in skirmishes

Skirmishes and multiplayer battles have Galactic conquest's defense stations too: the same Bastion,
Bulwark and Guardian, their three levels, modules, prices, names and models (data.ts `ORBITALS`,
`defenseType`, which is `orbitalType` with a price and a build time; see *Galactic conquest orbit
view and defense stations* above for the stations themselves).

- **The lobby** (the skirmish setup and the multiplayer lobby, where only the host changes it):
  *Defense stations* Off, 1, 2, 3, 4 or 6 per player (`DEFENSE_STEPS`), 2 by default
  (`DEFENSE_DEFAULT`). It is part of the match config (`MatchInfo.stations`, `World.defense`),
  cleaned by the server (`cleanDefense`); a lobby, setup or match without it gets the default. Off:
  engineers have no defense station card, the AI builds none, and the orders are refused by the
  protocol (`cleanCmd`) and by the sim. A battle saved before them (no `defense` in its world) plays
  on as before, with them off.
- **Building:** the engineers' Build section has a *Defense station* card beside the yards, with
  its price, how long the selected crew take and how many we have of the limit ("1/2"). Placed like
  a yard (the ghost, turning it, the action wheel's *Build defense station* and the pinned spot on a
  touch screen), inside the build radius and clear of everything a yard keeps clear of, by the size
  it grows to at level 3 (so it always has room to). It goes up at level 1 with one empty slot,
  welded by engineers at a yard's pace (one squadron's time is the galaxy's over `SHIP_TIME`).
  The limit counts the ones standing and going up (`fortLock`); a destroyed one leaves no ruin and
  frees its place.
- **Levels and modules:** selecting one opens its card (Hud.tsx `FortDetail`): its upgrade to the
  next level, its slots (1, 2 and 4 by level) and, for the slot picked, the five modules (fitting a
  filled slot swaps its module once it's done). The station does the work itself, up to three jobs
  queued (`DEFENSE_QUEUE`), one at a time; a job clicked again is called off, refunded in full (an
  upgrade called off takes the modules waiting for its slots with it), and work lost with the
  station is paid back. A slot the queued upgrade brings may be fitted already. Prices are the
  galaxy's; times are the galaxy's over `SHIP_TIME` (1.5):

  | | Republic: Bastion | Confederacy: Bulwark | Swarm: Guardian |
  | --- | --- | --- | --- |
  | Level 1 (station level 1) | Watchpost: 700, 27 s | Gun Post: 750, 27 s | Spore: 600, 23 s |
  | Level 2 (station level 2) | Battle Station: 900, 33 s | Battle Station: 950, 33 s | Bloom: 800, 29 s |
  | Level 3 (station level 3) | Redoubt: 1300, 43 s | Keep: 1400, 43 s | Hive: 1150, 37 s |

  Modules take 9 to 16 s. Each is a part of the station, drawn on its model, that can be shot off:
  batteries, flak and launchers fire, a shield generator gives shields (the Swarm's regeneration
  pool more hull, regrowing faster), a hangar keeps a squadron of the faction's interceptors in the
  air (its first one launches as soon as it's fitted). A repair crew (*Repair*) rebuilds every
  module that was shot off; engineers weld one back for `REBUILD_MODULE` of its price.
- **The AI** (ai.ts `planForts`, Style `forts` and `fortTop`): a Defensive admiral wants one from
  station level 2 and raises it to level 2, a Balanced one one from level 3 and an Offensive one
  one at level 4, both left at level 1, all within the limit (more turned the AI-only tournaments
  into stalls: bases a wave can't crack). It puts one up between its station and the nearest enemy
  with its engineers while its base is quiet, saves up for the first module of each (picked by what
  the enemy flies, data.ts `orbitalPick`, as the galaxy AI arms its own), fits the rest and the
  upgrades with credits to spare, and sends repair crews like for any structure.
  `DEFENSE=0 node scripts/empires-tournament.ts …` plays the tournament with them off (exactly the
  battles from before them). All of it goes through the same orders
  as a player's (`fortUp`, `fortFit`, `cancelFort`, `place`), so lockstep holds.
- **Codex and tech tree:** the Codex lists each side's defense station under Structures, with a
  level picker, its slots filled, and its levels and modules; the tech tree has a line of its
  levels and modules (ordered on each station's card).

```sh
pnpm check:empires-sk-defense   # the lobby's limit and Off, placement, levels and slots, modules and swaps, refunds, combat, repairs, the AI, old saves
```

## Empires At War beacons, idle strike craft and defense platforms on ore

- **Beacons see.** A capture beacon a team holds is a pair of eyes for every player on it:
  `BEACON_SENSOR` (900 as written, 990 at the battlefield's scale, a frigate's sensors about) round
  it, on top of the fleet cap (`BEACON_POP`, +6) and income (`BEACON_INCOME`, 90 credits a minute)
  it already gave. It counts wherever sight does (sim.ts `eyesOf`: the ships and structures, then
  the beacons held): the fog of war and the fog grid, the minimap, what the AI sees (`sight`,
  `canSee`), sparks and ruins drawn in the fog, and where reinforcements may be called in. A
  neutral or half-taken beacon sees nothing, and one that is lost stops seeing for its old holder
  at once. Hovering over a beacon (the action wheel's *Beacon info* on a touch screen) shows what it
  gives; the top bar's fleet cell spells out the cap (base, station levels, beacons held) and the
  beacon cell what each one gives.
- **Idle strike craft hold station.** Fighters, bombers and the like with no orders and nothing to
  fight (alone at their spot, round their carrier, or escorting a ship that waits) fly a slow, wide
  circle round it (sim.ts `loiter`): `IDLE_PACE` (45%) of their speed, on a 130 to 208 radius by
  craft, with half their turn rate (`IDLE_TURN`), where they used to buzz round a tight 70 to 124
  ring at 65%. Further out than a couple of radii they come back quicker (up to 80%, full turns);
  round a carrier under way the circle moves with it and they add its pace to theirs. A
  target or an order takes them out of it straight away: picking up an enemy is as quick as ever
  (the same look round every 0.4 to 0.7 s) and they're at full speed within a second. The engine
  glow follows the speed. The defense wing still parks in its slots round the station.
- **Defense platforms on ore** (the lobby's *Battle settings*, beside *Defense stations*; in the
  multiplayer lobby only the host changes it): Off by default, and then surveyed ore takes only a
  mining platform: the ore card has no gun, flak or all-round platform, the sim refuses one
  (`cantSite`, World `oreDefense`, `oreGuns`) and so does the protocol (`cleanCmd`). On, it's as it
  always was. It is part of the match config (`MatchInfo.oreDefense`, set by the server from the
  lobby, only `true` or `false`). A skirmish setup saved before the choice comes back with it off,
  as a new lobby has it; a battle saved before it (no `oreDefense` in its world) and a match from
  before it play on with them on, as they were. Galactic conquest's fleet battles build nothing, so
  it doesn't apply there. The AI builds none with them off, and the money goes to its fleet.
  (Admirals fill their claims with mines first, so they seldom built one even before; a defense
  station more in their place was tried and turned more of the AI-only tournaments into stalls.)
  `ORE_DEFENSE=1 node scripts/empires-tournament.ts …` plays the tournament with them on.

```sh
pnpm check:empires-mechanics   # 13-15: beacon vision on capture and loss, idle strike craft pace and response, the ore switch, old saves, the AI
pnpm check:empires             # also a battle with defense platforms on ore, frozen with them standing
```

## Empires At War control groups and credits for allies

**Control groups** ([`groups.ts`](src/apps/games/empires/groups.ts)), as in classic RTS games:
**Ctrl+1…9 or 0** puts the selection in that group (ships, a yard, the station), **Shift+number**
adds the selection to it, the **number** selects it, and pressing it twice within 300 ms also brings
the camera to it. A group of one yard or the station opens its build panel, as selecting it does.
The groups that hold anything show as a strip of chips on the selection panel (key, the main unit's
picture, how many): a click selects, a double click looks. On a touch screen the strip sits by the
touch bar: tap to select, double-tap to look, long-press for Set to selection, Add selection and
Clear group, and "+ Group" saves the selection as the next free group.
- They are the player's own view, never orders: they never go through the lockstep protocol, units
  that die or change hands drop out, and a saved battle keeps them with the selection.
- The group keys and both modifiers are in Settings, on the Keybinds tab (Ctrl, Shift or Ctrl+Shift;
  picking the other's modifier swaps them). Alt is never one: the OS uses Alt+number for workspaces.
- Ctrl+number is also the browser's tab switch. The battle takes the key press (`preventDefault`),
  which stops Chromium switching tabs (Firefox on Linux uses Alt+number for tabs, so Ctrl+number
  reaches the page anyway); in the browser's own fullscreen the number keys are also locked to the
  page with the Keyboard Lock API where it exists. A browser that still switches tabs: set groups
  with Ctrl+Shift instead.

**Credits for allies:** in a team battle (multiplayer or a skirmish with AI allies) the send button
beside the credits opens a panel: pick an ally (their credits show), an amount (+250, +500, +1,000,
Half, All but 100, or typed) and send. The ally gets "Vex sent you 1,000 credits" with a sound, the
sender a message too, and both see it in the economy panel.
- It is an order (`give`), deterministic: whole credits above 0, only to a teammate still in the
  battle, at most what the sender has, and one a second at most (`GIFT_COOLDOWN`). The server
  refuses the rest before they reach the turn, with the reason as a message, and takes one a tick.
- AI allies take gifts like anyone. An AI admiral with 3,000 credits or more also sends a teammate
  who is a person and down to under 200 credits 500 of its own, at most once in 90 s (`AID` in
  [`ai.ts`](src/apps/games/empires/ai.ts)).
- No allies (one against one, every player for themselves) or galactic conquest: no button.

```sh
pnpm check:empires-groups   # set, add, select, dead units dropping out, the bar, a double press, the keys
pnpm check:empires-allies   # the sim's rules and the AI, then a 2 v 2 on a real server: a gift in sync, refusals, a burst, repair orders on enemies refused
```

The game's Settings (main menu, and the battle menu) are tabbed: Sound, Controls, Camera, Gameplay,
Keybinds and Multiplayer. Controls is edge scrolling, Camera is how fast the view scrolls, and
Gameplay is the battlefield and the shipyard. Key bindings live on the Keybinds tab, not as their
own item on the main menu. How to play is off the main menu for now; the battle menu still opens it.

## Empires At War dock points

Dragging a floating window (the tactical map, economy, fleet inventory, players; on the galaxy map the
map, planet dock, fleets, economy and selection) shows small anchors at the places it can snap to,
the nearest one lit with an outline of where the window would land ([`src/apps/games/empires/dock.ts`](src/apps/games/empires/dock.ts),
drawn by `Floating` in `Hud.tsx`). Let go within 44 px (64 px for a finger) of one and it sits there exactly;
anywhere else it stays where it was dropped, as before. The places are the window's own **default spot**
(always first: snapping there clears its moved entry, so it follows the default again) and eight dock
points: the four corners, top centre, bottom centre and the left and right middles, 8 px from the edges
and 56 px under the top. A window on a dock point is stored in the layout as `{ dock }`, not pixels, so
it stays on that corner or edge when the screen is resized or the window grows; layouts saved with
pixels load as they were. Hold **Shift** while dragging to place a window freely, with no anchors.
*Settings → Apps → Empires At War → Snap windows to dock points* (and the game's Settings, Gameplay
tab) turns it off; it is on by default. Windows the phone layout pins in place (the tactical map on touch
screens) don't take part.

## Empires At War on touch screens

Phones and tablets play the whole game by touch ([`src/apps/games/empires/Touch.tsx`](src/apps/games/empires/Touch.tsx)),
and mouse and keyboard play is unchanged: every touch path checks `pointerType === 'touch'` or the
`(pointer: coarse)` media query. Settings hides Controls, Camera and Keybinds there: a finger drags
the view and has no keys to bind.
- **Gestures:** tap to select, drag to pan, pinch to zoom, and double-tap a ship for all of its
  kind on screen.
- **Action wheel:** a long press opens a radial wheel of context actions. In battle: move,
  attack-move, patrol, line, facing, attack, area attack, guard, rally, info. On the galaxy map:
  send fleet, add stop, shipyard, station, zoom.
- **Touch bar:** a sticky ⇧ Shift (queue, add to the selection, build five) and a ▢ Box mode (the
  next drag selects).
- **Long presses elsewhere:** on ship cards, control groups, the minimap, selection tiles, fleet inventory stacks and
  tech-tree slots. On anything else, a long press shows its tooltip.

On phone-sized screens the game opens in fullscreen:
- the HUD and galaxy panels become bottom sheets, with the minimap behind a button;
- the menus and lobby scroll and fit, with the lobby's launch bar always in view;
- portrait shows a hint to turn the phone sideways.

## Empires At War multiplayer

The arcade's space RTS has online skirmishes: Main menu → Multiplayer → Skirmish. Anyone can play,
signed in or not, under a typed or random name; names are unique among everyone online, and a
signed-in user's GitHub login is theirs alone (held by the account, not the name: if someone renames and
another account takes the old login, it doesn't bring their player, seat or battle with it). The game remembers the last name you played under
(in this browser, and with your account when signed in, so it follows you to other devices) and
takes it by itself when you come back, straight to the list of battles; on a device that hasn't
loaded the account's copy yet, it waits for it rather than asking. If someone online has the name
right now, the name screen says so, with the name filled in to try again. *Change* in the
multiplayer header renames you at once; the game's Settings, on the Multiplayer tab (and Settings → Apps → Empires At War)
show the remembered name, to change it for next time or *Forget* it, so the next visit asks. A
host sets up a battle (map, rules, starting
credits, and each spawn as open, AI (with its difficulty and style) or closed); players join from the list, pick their spawn,
faction and side, chat, and say they're ready.

The lobby, and the single-player skirmish setup that shares its layout, is a panel centred on the
screen: at most 1500 px wide and no taller than its contents, so a big or ultrawide window gets
margins rather than a giant map. *Players* (the spawns) and *Battle settings* (starting credits,
reinforcements, defense stations, defense platforms on ore and, on a generated map, its rules) sit on the left, the map with its legend in the
middle, and the chat as a rail on the right. In a narrower window the chat moves under the map; on a
phone everything is one column, with each player as a two-line card. A launch bar at the foot stays in
view at every size. It says what the battle is still waiting for, and holds *Start battle* for the
host, *I'm ready* for the others, or *Launch battle* in a skirmish.

*Change map* opens the map picker. It lists the maps one to a row: a thumbnail, the name with its
terrain (fields, nebulas, wrecks), a one-line description, and the map's size, players, beacons and
ore. A search box filters by name and description; it takes the focus on a desktop, but not on a
touch screen, where it would pop up the keyboard. Quick filters pick a player count. The list sorts
by name, size or players; clicking the active sort again reverses it, and the last sort is
remembered in this browser (`mvlos.empires.mapsort`). The current map is marked and scrolled into
view. The arrow keys move through the list and Enter picks, so typing part of a name and pressing
Enter picks the first match. The generated map stays pinned under the list, whatever the search. On
a phone the picker fills the screen and each map takes two lines.

Battles run in deterministic lockstep: every player's browser runs the whole battle, and only
orders cross the network. The server ([`server/empires.ts`](server/empires.ts), on the WebSocket
`/api/empires/ws` from the dependency-free [`server/ws.ts`](server/ws.ts)) keeps the clock at 30
ticks a second and hands everyone each tick's orders; it cleans every order and stamps it with the
sender's own seat ([`commands.ts`](src/apps/games/empires/commands.ts)), so a tampered client can't
order other players' ships, play faster or claim a win. It also runs its own copy of every battle:
players send a fingerprint of theirs every second, and one that drifted gets the server's copy.
The same copy brings a player back after a reload or a dropped connection. In battle, Tab (or the
top bar's players button, which shows your ping) opens the player list: fleet, kills, losses,
credits earned and score, and online each player's ping and whether they're still there; a toast
says when an ally or enemy steps away, comes back, or gives up. What a client can still do is read past the fog of
war, since it holds the whole battle.

Quitting a battle (its menu's Leave) hands your fleet to an AI admiral at once. Anything else that
takes you away (the connection dropping, closing the browser tab, closing the game's window) only
steps you away: your seat is kept for 3 minutes (long enough to reopen the browser, or pick up
another device), and the battle pauses for everyone meanwhile
(the server stops handing out ticks, and doesn't fast-forward afterwards). The others see
"<name> left" with a live countdown (the server's deadline, on each player's own clock) and vote:
*Continue: AI takes over <name>*, *Continue: <teammate> takes over <name>'s fleet* (only when the
player who left has teammates still there), or *Wait*, the default. The battle goes on as soon as
everyone still there picks the same way to continue, and shows who voted what; when the countdown
runs out, the AI takes over. A teammate taking over gets every ship and the credits, on every
player's machine at the same tick, while an AI admiral keeps running the base (station, mines and
defenses stay with their seat: one player runs one station). Coming back in time puts you straight
back in the battle with the server's copy, and it carries on for everyone. The browser keeps your
last token (in localStorage, next to the tab's own), so even after closing the tab, opening
Empires → Multiplayer again rejoins the battle. Signed in, your account finds your seat too, from
another browser or device without the token (only a player of yours that isn't connected: a second
tab playing on purpose keeps its own). The main menu shows *Rejoin battle* while your seat is
waiting, as the server says (`POST /api/empires/away`, by the browser's token or the account).
Come back too late and the game says what happened to your fleet.

Battles survive a restart of the site (a deploy, or watchtower pulling a new image). On SIGTERM
the server writes every player (name and token), lobby and battle (the server's own copy, at its
last tick) to `DATA_DIR/empires-state.json`, tells the players it is restarting (WebSocket close
code 1012), and exits. The new server reads the file back and deletes it (one older than 10
minutes, from another version or unreadable is ignored). Players have 3 minutes to reconnect, which
their games do by themselves with their token, and each gets the server's battle back. A battle
waits at the tick it stopped on: everyone in it has stepped away, with nobody counting down until
the first player is back; from then the others get the usual 3 minutes (and the vote), and the
time it was down doesn't count. Meanwhile the game says the server is restarting and the battle
will carry on. Should the server have lost a battle anyway (a crash, SIGKILL, or a
player gone too long), the battle screen says so and offers to keep playing it against the
computer, from where it was, as an offline skirmish with AI admirals for the other players.

The sim is bit-for-bit the same in every browser: it uses its own trigonometry
([`detmath.ts`](src/apps/games/empires/detmath.ts)) and a seeded random stream kept in the world.
The reverse proxy in front of the site has to pass WebSocket upgrades through (nginx:
`proxy_http_version 1.1`, `proxy_set_header Upgrade $http_upgrade`,
`proxy_set_header Connection "upgrade"`; Caddy and Traefik do it by default).

```sh
pnpm check:empires                                              # two copies of a battle stay identical (four seats, then six)
pnpm check:empires-ws ws://localhost:5173/api/empires/ws        # names, limits and lobbies (needs pnpm dev)
pnpm check:empires-match 40 ws://localhost:5173/api/empires/ws  # a scripted battle: drift, rejoin, leave (add a map id, e.g. tarsis, for six seats)
pnpm check:empires-restart                                      # a battle through a server restart (starts its own servers)
pnpm check:empires-rejoin                                       # stepping away: rejoining, votes, teammate takeover, timeout
pnpm empires:bot "Bot Rook"                                     # an opponent that joins your battle
```

## Performance guardrails

The bar is the display's full refresh rate (up to 240 Hz) without giving up anything on screen.
`pnpm check:perf` ([`scripts/perf/`](scripts/perf)) keeps new features to it: it runs fixed scenes
in headless Chromium and holds them to [`perf-budgets.json`](perf-budgets.json) and to pixel
snapshots in [`scripts/perf/baselines/`](scripts/perf/baselines), and CI runs it on every pull
request.

```sh
pnpm check:perf                      # every scene: a table of metric, budget, actual, result
pnpm check:perf --only galaxy-late   # one scene (or a comma-separated few)
pnpm check:perf --update             # after an intended change: new budgets and snapshots, diff printed
pnpm check:perf --json out.json      # everything measured, raw counters included
pnpm check:perf --fixtures           # rebuild the galaxy saves in scripts/perf/fixtures
```

**The scenes.** A skirmish with 200 and with 300 ships fighting (spawned through the sim in the
middle of the map, the camera panning across); six admirals on a huge map (Velkar Core), 40 craft
each sent at the middle, seen zoomed all the way out and then panning across the fight; a skirmish reloaded from the tab's resume snapshot
with engineers selected, looked at in five window sizes with the unit card's contents scrolled into
view (the battle screen must never scroll, and the panels laid out round each other must settle:
no React update loop, few commits); the galactic conquest map of a new and a late
campaign (saves in `scripts/perf/fixtures`), zoomed with the wheel and dragged round a circle; and
the desktop with a few apps open, left idle, then hidden.

**Deterministic.** The check starts its own Vite dev server (no `/api`, no network) and
[`harness.js`](scripts/perf/harness.js) goes into every page first: from the moment a scene starts,
`performance.now()`, `requestAnimationFrame` and the timers run on a clock the check steps by hand,
a fixed 1/60 s a frame, and `Math.random` starts from a fixed seed. Loading waits in real time with
the clock stopped. So every run draws the same frames, whatever the machine: the counts come out
identical on a fast desktop and on CI's software rendering. Nothing of this is in the app; the
scenes reach into the game through its modules and the dev-only `window.__ew`.

**What's measured**, per scene: canvas calls per frame (draw calls, `drawImage`, fills and strokes,
save/restore, gradients, filters and shadows, pixel reads, and what's drawn off screen into bitmap
caches), new canvases per second, the model bitmap cache's size, React commits per second (while
zooming and panning, the galaxy map should hardly render), DOM nodes, map elements drawn through a
CSS filter, and, idle, frame callbacks, timer callbacks and live intervals, shown and hidden.
Budgets are the measurement plus 15%, or plus 2 for counts near zero.

The main thread's time per frame (input, timers, frame callbacks and the style and layout they
leave) is measured too, but only as a soft budget of three times the measurement: it never fails
the check, since machines differ.

**Pixels.** Each battle and galaxy scene is also a 320×180 snapshot, compared with a tolerance
(mean difference 1.5/255, and at most 1% of pixels clearly changed): the battle's canvas, and the
galaxy map's layers without the panels round them. Text is left out of both (canvas text isn't
drawn, SVG and HTML text is made transparent), since fonts render differently from machine to
machine; animations and transitions are off. A failing snapshot's picture is saved next to the
message, to compare.

**Updating.** A failure names the scene and the metric, and how far over it went. If the new cost is
the point of the change (more ships drawn, a new effect), run `pnpm check:perf --update`, look at
the printed before and after, and commit `perf-budgets.json` and the snapshots with the change.
Never update to make a regression go away.

**CI.** The `perf` job in [`ci.yml`](.github/workflows/ci.yml) downloads the Chrome for Testing
build the snapshots were made with (pinned, cached) and runs `pnpm check:perf` with software
rendering. Counts don't depend on the machine; time budgets are soft there as everywhere.

### Do's and don'ts

- **Cache big drawings as bitmaps.** A ship, a station or a sprite is painted once into an off-screen
  canvas at the size it shows (steps of √2, see `models/paint.ts`) and drawn with one `drawImage`
  a frame; painting paths every frame is what costs.
- **Cap the canvas DPR at 2.** A 3× phone screen at full density is 2.25 times the pixels of 2× for
  no visible gain; the battle canvas uses `Math.min(2, devicePixelRatio)`.
- **Glow sprites, not gradients.** A radial gradient made per particle per frame is slow; draw a
  glow once into a small canvas and stamp it with `drawImage` (scaled, tinted, faded).
- **No React state for anything that changes every frame.** The camera and animations live in refs
  and move in a `requestAnimationFrame` loop that sets styles or draws directly; React renders only
  when what's shown changes (the galaxy map's `CamView` and `zoomBand`).
- **No filters or blur on huge or zoomed shapes.** A CSS `filter` (drop-shadow, blur) or a canvas
  `filter`/`shadowBlur` is a pass of its own every frame, as big as the shape on screen; fake the
  glow with a few soft strokes or a sprite (the galaxy's blockade rings, `glowRings`).
- **Register CSS variables as not inherited, and set them only where they're used.** A variable
  set on a map's root restyles every element under it each frame; `@property … inherits: false` set
  on the few elements that read it restyles only those (`scaleVars` in `Conquest.tsx`).
- **Fewer elements that change with the zoom.** Each element a step of a zoom restyles costs about
  10 µs of the frame. Draw many alike shapes that change together as one path whose data is set
  from the camera (the galaxy's blockade rings and glows, `placeBlockades`: a few paths, not five
  circles a blockade); put a marker's parts in one pin rather than sizing each (a system's planet
  dots); and give a size that is `max()` of screen and map units a floor on `--ik` (`data-ik-lo`), so
  it stops restyling once the map units take over.
- **Keep text out of transformed SVG.** SVG text inside a zoomed SVG is laid out again at every step
  of a zoom; put labels in an HTML layer over it (the galaxy's `.ew-gover` pins).
- **Pan by moving a layer, not by drawing again.** Changing an SVG's `viewBox` (or a transform
  inside a layer) to pan repaints and rasters the whole view every frame, about 5 ms of GPU time on a
  5120×1440 screen. Draw a region a little past the view into one `will-change: transform` layer and
  move that layer by whole pixels (fractions blur it); draw again only when the zoom changes or the
  view leaves the region (the galaxy's `Region`, `.ew-gpan`).
- **Give a small thing that moves every frame a layer of its own.** Anything that changes inside a
  big layer has its tiles rastered again; the minimap's view frame sits in its own small layer over
  the minimap (`.ew-gmini-over`) for that.
- **Move what moves by itself every frame, outside React.** A render ten times a second makes
  moving things step on a fast screen; set their transforms from the frame loop instead (the
  galaxy's fleets in flight, `CamView.tick`).
- **Don't judge smoothness with `--disable-gpu-vsync --disable-frame-rate-limit`.** Chromium then
  runs `requestAnimationFrame` as fast as it can while far fewer frames reach the screen: an FPS
  counter shows 200+ while the picture lags. Measure at the display's own rate.
- **No allocations per frame.** Reuse arrays and objects in the frame loop, and drop dead entries by
  compacting in place (a write index, then `length =`) instead of `filter()` making a new array.
- **Pause timers and loops when hidden.** On `visibilitychange`, stop intervals and animation loops
  that only update the screen; a hidden tab should do next to nothing (the idle scene checks it).
- **Measure with the FPS overlay.** Settings → Performance → *Show FPS and frame time* shows the
  page's frame rate and p50/p95 frame times anywhere, fullscreen included: try the change at your
  display's refresh rate before and after.
- **Run `pnpm check:perf` before a pull request,** and update the budgets only for a cost you meant
  to add.

## Installable app

The site is a PWA: [`public/manifest.webmanifest`](public/manifest.webmanifest) makes it
installable (full-window, with Terminal/CV/Games shortcuts on the icon), and a service worker
built from [`pwa/sw.js`](pwa/sw.js) caches the app shell so it boots offline. The build stamps the
worker with this release's files, so installed copies show an "update" notification after a
release; clicking it restarts into the new version. Live data (`/api/*`, other sites) is never
cached. The worker only registers in production builds; `.claude/launch.json` has a `prod`
configuration that builds and serves one on port 4180.

The worker precaches the page, the main script and CSS, the chunks loaded later (the terminal's
editors, figlet fonts, Gladiator and Empires At War), the icons and the data snapshots; only pdf.js
is left for when a PDF is opened. On a release, the new worker reuses every hashed `/assets/` file
it already has in any of its caches (the names carry a hash of the content) and downloads only the
ones that changed. The install is all or nothing: if any file fails, the running release stays as
it was. A game whose code can't be loaded anyway (no worker, its cache not filled yet) says so in
its window instead of taking the page down: offline with a Try again button, online with a Reload
into the latest version (most likely a release replaced its files while the page was open).

The build also writes a Brotli (`.br`, quality 11) and a gzip (`.gz`, level 9) copy next to every
text file in `dist/` (the `mvlos-precompress` plugin), and `server/index.ts` sends the one the
browser prefers by its `Accept-Encoding` q values (Brotli on a tie), with `Content-Encoding` and
`Vary: Accept-Encoding`. Requests without `Accept-Encoding`, refusing both, and `Range` requests,
get the raw file. A cold first visit (worker installed) downloads about 1.1 MB instead of 4.5 MB,
and a release about 0.9 MB instead of 3.7 MB (the main chunk and the two game chunks, which import
it, change with nearly every release).

Run `pnpm build && pnpm check:sw` to check all of this: the precache list, the server's
encodings and headers, and in headless Chromium a cold load, offline boot with a game, and a game
failing cleanly when its code is missing. It runs the server on port 5283 (`SW_CHECK_PORT`; the
byte-counting proxy uses the next port) with a scratch `DATA_DIR`. `SW_CHECK_FROM` takes older
builds (directories with `server/`, `src/` and a built `dist/`, separated by `:`) and checks the
upgrade from each: unchanged files reused, changed ones downloaded, and offline boot afterwards.
Use an `origin/main` checkout for the upgrade from the live worker, and a copy of this build's
`dist/` and `server/` taken before running `pnpm build` again (which changes only the build time)
for an ordinary release.

Install from the browser's **Install app** or **Add to Home Screen** menu, then launch the saved
icon. The manifest requests fullscreen by default; browsers that do not support it fall back to
standalone or a normal browser tab. On iPhone/iPad, use Safari's Share menu → **Add to Home Screen**;
Apple's web-app metadata allows content beneath the status bar, with safe-area padding protecting
controls. The browser/OS ultimately decides which system bars remain visible. Theme colour follows
the selected Omarchy palette.

If installation is unavailable, bookmark the site and use it in a regular tab; mobile maximization
still fills the available page, but cannot remove browser controls. Offline startup requires a
successful online visit to a production build and completion of the service worker's shell cache.
Cached apps can open offline; sign-in, sync and other live services still need a connection.
Browsers that block service workers or storage require a connection to reopen the site.

Run `pnpm build && pnpm check:pwa-mobile` to check phone Notes navigation, maximize/rotation/restore
and production offline startup in isolated Chromium. The static test server uses port 5296
(override with `PWA_CHECK_PORT`) and stops when the check finishes.

## Releases and hosting

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) typechecks and builds every push to
`main` and every pull request, and runs `pnpm check:perf` on them (see Performance guardrails).

Publishing a GitHub release with a semver tag (`v1.2.3`) runs
[`.github/workflows/release.yml`](.github/workflows/release.yml): it refreshes the activity
snapshot, builds the site, and pushes a multi-arch (amd64 + arm64) image to
`ghcr.io/vleeuwenmenno/mennovanleeuwen.nl` tagged `1.2.3`, `1.2`, `1` and `latest`. Prereleases
skip `latest`.

Run it with [`compose.yml`](compose.yml), on a server or locally: `docker compose up -d` pulls
the released image, `docker compose up -d --build` builds this checkout instead. For working on the site,
use `pnpm dev`: it reloads instantly and serves the live `/api` endpoints too. Put
`GITHUB_TOKEN=...` in a `.env` next to it (git-ignored) to give `git log` GitHub's signed-in rate
limit; a fine-grained token with read-only access to public repositories is enough. `PORT=...` in the
same file changes the host port (default 8080).

The container runs [`server/index.ts`](server/index.ts), a Node server whose only npm packages are `tldts` and `tldts-core` (copied into the image as plain folders), as a
non-root user on port 8080 (`PORT` changes it). Its API routes live in
[`server/api.ts`](server/api.ts), shared with `pnpm dev`. It serves the built site, answers `/healthz`, serves
`/api/activity` (git.mvl.sh's activity feeds, which browsers can't read cross-origin), 
`/api/git/<owner>/<repo>/commits` (for `git log`, cached; set `GITHUB_TOKEN` to lift GitHub's
anonymous limit of 60 requests an hour), `/api/git/<owner>/<repo>/releases` (for the Changelog app,
same cache and token; at most 500 answers are kept, failures for 5 seconds, and 6 requests to GitHub run at once, with a quick 503 beyond that), `/api/suggest` (Spotlight's web search suggestions: 1000 answers kept, failures for 30 seconds, 8 engine requests at once, an empty list beyond that; `pnpm check:public-cache` checks both caches' limits), and `/api/minecraft`: a live Server List Ping of the Minecraft server, cached for 10 seconds,
so the status and join/leave notifications don't wait on public status APIs that cache for
minutes. On a static host without that endpoint the site falls back to those APIs. `pnpm dev`
and `pnpm preview` serve the endpoint too. Build the image locally with `docker build -t mvlos .`.

Every answer carries baseline security headers (`SECURITY` in [`server/http.ts`](server/http.ts)):
`nosniff`, `Referrer-Policy`, `X-Frame-Options: SAMEORIGIN`, `Strict-Transport-Security:
max-age=31536000` (no `includeSubDomains` or `preload`, since not every subdomain is known to be
HTTPS; browsers ignore it over plain HTTP) and a general `Content-Security-Policy: script-src 'self';
object-src 'none'; base-uri 'none'; frame-ancestors 'self'`. That blocks injected script and plugins
and nothing else: there is no `default-src`, `connect-src`, `img-src` or `style-src`, because the
site uses third-party fonts, public APIs, blob and data media, inline styles and framed content.
The app's own HTML pages (`/`, `/cv`, `/play/...` and the fallback for unknown paths) send a stricter
script policy instead (`documentCsp` in `server/http.ts`): `script-src 'nonce-<random>'
'strict-dynamic' 'self'`, with the same `object-src`, `base-uri` and `frame-ancestors`. The server
puts a fresh nonce on every response, on the boot `<script>` and the `modulepreload` links, and
builds and compresses that small page per request (still `Cache-Control: no-cache`, `Vary:
Accept-Encoding`). `'strict-dynamic'` is what lets the boot script load the rest of the app and
the Office app load `api.js` from the OnlyOffice document server each account configures, without
allowing any other `https:` origin to run script: an inline script or a `<script src>` in markup,
without the nonce, stays blocked. `'self'` is only a fallback for browsers that lack
`'strict-dynamic'`. The nonce is never shared between responses; the service worker's cached copy
of the page keeps its own nonce and header together.
Routes that send untrusted bytes spread `UNTRUSTED` (`default-src 'none'; sandbox`) after `SECURITY`,
and share pages send their own stricter policy, so both replace the general one: keep that order
when adding a route. `pnpm build && pnpm check:headers` boots the server and checks the nonce policy
on the page variants and encodings, `/api/me`, a share page and the merge order, then runs headless
Chromium: the real page boots, and under the same policy a trusted script's dynamic script from
another origin loads while inline and injected script is blocked.

While it runs, the server also pings the Minecraft server every 30 seconds
([`server/minecraft.ts`](server/minecraft.ts)) and keeps 30 days of it in SQLite under `DATA_DIR`: online or
not, the player count, the ping time, and each player's visits (from the names the ping lists).
`/api/minecraft/overview?range=24h|7d|30d` turns that into the **Minecraft server** window: uptime,
players over time with the server's availability underneath, who is on and since when, recent
visits and who played most. Open it from Spotlight (Enter on the Minecraft entry), the
*Overview* button in the top bar's Minecraft popup, or `open mcserver`. `MC_WATCH=off` stops the
pinger; the window then shows the live status only.

A ping that goes unanswered is tried again twice, 2 seconds apart, before the server counts as
offline, and the "went offline" notification only comes after three such pings in a row (about a
minute and a half), so a dropped packet or a slow answer doesn't send a false alarm.

The ping's player list is not reliable for names: players who switch off *Allow Server Listings*
in Minecraft come through as "Anonymous Player", and the same player can be named in one ping and
anonymous in the next. Those are left out, and while anyone is hidden nobody is marked as gone.
For exact names, set `MC_RCON` (`host:port`, the port defaults to 25575) and `MC_RCON_PASSWORD`:
the server then asks RCON's `list` command who is on, and falls back to the ping when RCON doesn't
answer. Turn RCON on in the Minecraft server's `server.properties` (`enable-rcon=true`,
`rcon.port`, `rcon.password`). Keep its port off the internet and reachable only from the site,
for example over a shared Docker network: RCON sends the password in plain text and can run any
server command.

With RCON set up, the pinger's tick also asks, on the same RCON login as `list`: the world's clock
(`time query daytime` and `time query day`, shown as "☀ Day 412 · 14:20" in the window's header,
the top bar popup and the widget), each online player's dimension, XP level and health (`data get
entity <name> Dimension|XpLevel|Health`, for up to 12 players, only names that are valid Minecraft
names), and every 10 minutes the difficulty, the world border (shown only when smaller than the
default) and whether the server is vanilla or Paper (`version`). All of it is read-only and goes
into the public status as optional fields; an answer that doesn't parse leaves its field out, and
values are dropped after a few minutes without a fresh one. Player positions, the whitelist and the
seed are never asked for there. The players chart also shows who was on in each bar (from the
recorded visits): a mark on top of bars where someone joined, and their names, heads and join and
leave times in the tooltip (tap a bar on a touch screen).

Admins (`ADMIN_GITHUB_IDS`) also get a **Server console** in the Minecraft server window: say something
in chat, message or kick a player from *On now*, list the whitelist and add or remove names, and
run any command with its output in a scrollback (↑ for earlier ones). It goes through
`POST /api/minecraft/rcon`, which only answers signed-in admins (everyone else gets 403, and
nobody else sees the panel), takes one command per request (no newlines, at most 256 characters,
player names checked), allows 30 commands a minute per admin and logs each one with the admin's
login to the server's console. Commands that are hard to undo (`stop`, `ban`, `op`,
`whitelist off`, `kill @a` and the like) ask first.
