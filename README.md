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
dependency-free Node server adds live status, GitHub sign-in and synced notes (see below).

## Develop

```sh
pnpm install
pnpm dev          # http://localhost:5173
pnpm typecheck
pnpm build        # static site in dist/
pnpm check:perf   # performance budgets and pixel snapshots (see Performance guardrails)
```

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

### The shell, agents and skills

The shell is msh 2.0 ([`src/terminal/msh/`](src/terminal/msh)): a POSIX-ish parser and
interpreter. It supports if/for/while/until/case, functions, subshells, `$(…)`, `$((…))`, the
`${…}` forms, globbing, heredocs, redirects (`2>`, `2>&1`, `<`), `set -e/-x/-u/-o pipefail` and
builtins like `test`/`[`, `printf`, `read`, `source`, `eval` and `getopts`. `msh -c`, `msh file`
and `./script.sh` with a `#!/bin/msh` (or sh/bash) shebang run scripts. `man msh` shows the
reference ([`src/data/mshReference.ts`](src/data/mshReference.ts)), which the agents read as the
built-in `msh` skill.

`agents` ([`src/terminal/agents/`](src/terminal/agents)) is the Agents app as a coding-agent CLI.
In a folder on Seafile, that folder becomes the thread's work folder:
- File tools ([`server/workdir.ts`](server/workdir.ts)) let the agent read, write, edit, list,
  glob, grep, move and delete inside the folder, and it follows the folder's `AGENTS.md` or
  `CLAUDE.md`.
- A `terminal` tool runs msh command lines in the user's own terminal.
- Changes wait for approval, which can carry a note for the agent. Shift+Tab cycles between
  asking first, accepting edits, and plan mode (read only until a plan is approved).
- Prompt modes: `!cmd` runs a command, `# text` remembers something, `@path` attaches a file.
- While the agent works, Enter queues a message (shown over the prompt; the server sends it when
  the turn is done). ↑ in an empty prompt edits the last queued one, Ctrl+X removes it (or the last
  one), Ctrl+Enter sends it, or the next one, now (stopping the agent). While it asks for an
  approval or a form, just typing tells it what to do instead: Enter declines every waiting change
  with that message, or answers the form with it.
- A dropped stream reconnects by itself (for a minute) and an interrupted turn says so; Ctrl+R or
  `/retry` runs the last message again, and `/rewind` picks one of your messages to go back to.
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
  - image paste (`@path` attaches text files only)
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
camera and a summary of its key bindings, with a button into the game's own key bindings and sound
mix), Mail (when mail counts as read, remote content, the allowed senders, quoted text, signatures and replies, with a pointer to Notifications for new-mail alerts), Omamp (shuffle, repeat, equalizer and preset, visualizer, time, its windows), PDF (sidebar,
night mode), Preview (sidebar) and Terminal. Each pane reads and writes the very store the app uses
([`src/data/appPrefs.ts`](src/data/appPrefs.ts), [`src/apps/games/prefs.ts`](src/apps/games/prefs.ts),
through [`src/os/localPref.ts`](src/os/localPref.ts) for what stays in this browser), so an open
window follows a change at once and the other way round. Every field for a secret that belongs to another
service (API tokens, app passwords, a library's password) is a
[`SecretInput`](src/os/SecretInput.tsx): a text input masked with CSS and marked for password
managers to leave alone, with a show/hide button, because browsers fill a saved password into any
`type="password"` field and ignore `autocomplete="off"` there. Those apps' window menus have *… settings…*
to jump to their pane.
Settings → Spotlight picks what the empty Spotlight shows (favourites, recently visited websites,
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
Launchers are a URL, a name and an optional emoji (otherwise the site's own favicon). Notes, launchers, desktop icons, the dock order and the open windows are kept per browser
in localStorage ([`src/os/synced.ts`](src/os/synced.ts)), with one window layout for phones and one
for bigger screens.

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
clone command, link or branch name.

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
"Sign-up is closed") dialog instead; existing accounts and admins can always sign in. Logins in
`ADMIN_USERS` (default `vleeuwenmenno`) are admins: Settings → Users lists the accounts (counts and
sizes only, never their contents), bans, signs out and deletes them, and opens or closes sign-up.
Keys set on the server (`OLLAMA_API_KEY`, `UPDOWN_API_KEY`) are only used for admins; everyone
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

Setup:

1. Create a GitHub OAuth app (GitHub → Settings → Developer settings → OAuth Apps) with callback
   URL `https://<your site>/api/auth/github/callback`. Local dev needs its own app with
   `http://localhost:5173/api/auth/github/callback`.
2. Put `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` in `.env`. Optional: `ADMIN_USERS`
   (comma-separated logins), `MAX_USERS` (the starting cap; Settings → Users changes it), `PUBLIC_URL` (the site's
   address, e.g. `https://mennovanleeuwen.nl`; set it in production, since without it the server
   takes `Host` and `X-Forwarded-*` from each request, and logs a warning at startup), `SESSION_SECRET` (otherwise a random key is generated once into
   `DATA_DIR/secret.key`), `GITHUB_SCOPES` (what "Allow private" in Settings → Code hosts asks
   for, default `read:user repo read:org`; sign-in itself only asks for `read:user`).

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
`/privacy.html`). Accounts connected before
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
seeking; every answer has `nosniff` and a sandboxing CSP). The chip's ⤓ button, its right-click
menu and *Download all* still download. Other attachments (Office files and the rest) download as
before. Attachments save to Files too. Keys: `j`/`k` (or the arrows) to move, Enter to open, `e` archive, `#` delete, `!` junk,
`s` flag, `u` read or unread, `r` reply, `a` reply all, `f` forward, `c` compose, `/` search,
Ctrl+Enter to send (a setting). In a narrow window or on a phone it shows one pane at a time: mailboxes, list,
conversation, each with a way back.

Several conversations can be selected at once, as in Files and Photos: Ctrl or Cmd+click (or the
circle over a sender's picture) takes one in or out, Shift+click or Shift+↑/↓ a range, Ctrl+A every
conversation loaded, Esc none; on a touch screen a long press starts selecting and taps then add
and take away. With two or more, the reading pane says how many (a bar over the list on a phone)
with Archive, Delete, Mark as junk or Not junk, Mark as read or unread, Flag or Unflag, and Move to…;
the keys above, the right-click menu on a selected row and dragging a selected row onto a mailbox
(the drag shows how many) act on all of them. A selected conversation is all its messages, and each
action is one request, one `Email/set` on the server. The selection stays when new mail comes in and
goes with a change of mailbox or a search.

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
stream to the window, with the model's thinking folded under each reply; Stop ends one. The
composer holds the mode, the model, which tools the thread may use, a context-window ring (tap it
for what fills the window) and attachments: text files, PDFs (their text, read in the browser with
pdf.js) and pictures, from Seafile, this computer, a drop (from the computer, Files or the desktop) or a paste. Its tools: web search
(Ollama's own by default; Settings → Agents → Web search switches it to SearXNG, Brave Search, Kagi,
Tavily or any JSON search API described by a URL template, headers and result paths, with keys
stored encrypted, see [`server/websearch.ts`](server/websearch.ts)) and Ollama's web fetch, your notes, your calendars (below), your code hosts, Seafile (list, search by name, read), Seafile
changes (each one waits for *Allow* in the window, since a page the agent read could have asked
for it), `update_todos` (a plan for long jobs, shown as "3/12" over the composer; while items are
open a turn may run up to 150 rounds, and it keeps going on the server when the window closes, until
Stop) and `remember`/`update_memory`. Memory is yours (every thread) or a project's (that
project's threads), filed by the agent under category paths such as People/Family or Work/Tools;
the Memory view shows it as a tree to search, add to, edit, move and forget. Projects group threads
in the sidebar: drag them into order, drag threads into or out of them, fold them; threads in and
out of projects can be pinned. The agent can manage projects too (list, create, rename, move the
thread), asking first. When it needs a decision or details it asks with `ask_user`: a small form in
the conversation (choice, multiple choice, yes or no, text, number, rating, date, or text to read;
several questions at once), and its turn waits for the answers. Each question type is one renderer
in `FIELDS` ([`src/apps/Agents.tsx`](src/apps/Agents.tsx)) and an unknown type falls back to a text
field, so new types can be added one at a time. Threads get a title from a small model, can be renamed (with a
suggestion), archived and deleted, and the sidebar folds to a rail.

A reply that only thinks gets one more round asking for the answer, and an answer given while the
todo list still has open items gets one asking to update it. Those asks go to the model as a user
message marked as the app's (never saved or shown), not in the system prompt, because some models'
servers (Mistral's) refuse a conversation that ends on the assistant's reply. As a safety net, any
request that would still end there gets a short "Continue." after it.

```sh
pnpm check:agents-roles   # The nudge, the todo wrap-up and a restart mid-reply, against a stand-in Ollama that refuses a trailing assistant message
```

**Titles keep up to date** (Settings → Agents → Models → *Thread titles*, on by default). A first
title names how a thread started, and threads wander, so every few of your messages (3, 4, 6 or 10;
4 by default, sooner when a thread grows by more than about 24,000 characters over at least two
messages) the server asks the title model once more, after the turn has answered and without
holding up the answer or the next queued message. It gets the current title and a small digest of
the latest exchanges (your last few messages and the start of each answer; no tool results,
thinking or files beyond their names) and answers `{"keep": true}` or `{"title": "…"}`. The prompt
leans hard towards keeping: a follow-up, a deeper question or new details keep the title, and only
a real change of subject renames the thread. A failed check is only logged, and waits as long as a
normal one before it is tried again. A title you set yourself (renaming in the app, or `/rename`)
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
…/retry`, streamed like a message) also sits under the last answer to have it written again: the
last turn's output (a partial or failed reply, its tool calls and results, or the answer) goes and
the same message, with its files, is answered again with the thread's model, mode and tools; queued
messages run after it. Each of your messages has **Copy**, **Edit & resend** and **Rewind to here**
(on hover, always on touch, and in its right-click menu): after a desktop dialog that says how many
messages go, it and everything after it leave the thread (`POST …/rewind`; a running turn is
stopped first, the queue stays) and it comes back into the message box with its files. What the
tools did is not undone: memories, the plan, notes, calendar events and files the agent changed in
the work folder stay as they are.

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
**Share** under each answer (on hover, always on touch) make a link to the whole thread or to one
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
offers only the reads, which ask as well), and no "allow from now on" reaches it. Each call is
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
ETag and a week's Cache-Control; the full photo comes straight from Seafile's file server with a
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
device), **Agenda** (Google Calendar and CalDAV, see above), **Code inbox**, **Status** (updown.io)
and **Minecraft server** (up or not, the address to copy, who is on with their heads, and the
in-game day and time when RCON is set up; a click opens the Minecraft server window).

The framework lives in [`src/widgets`](src/widgets). A widget is one `WidgetDef`
([`types.ts`](src/widgets/types.ts)): a name, a glyph, a size, its component, and optional hooks
for its frame colours and tilt (`useFrame`), its own menu items (`useMenu`) and how a new one is
made (`create`). List it in [`registry.tsx`](src/widgets/registry.tsx) and it gets the frame,
dragging, the menus and an *Add widget* entry everywhere. Per-widget settings go through
[`config.ts`](src/widgets/config.ts) (`useWidgetConfig` / `setWidgetConfig`), which syncs like
notes; where a widget sits is part of the synced window layout.

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
phone's window layout (`stack` in [`src/os/wm.tsx`](src/os/wm.tsx)); on a big screen notes stay
wherever they were put.

The MvL OS menu (top left) has *Hide notes and widgets* to put them all away and see the desktop
itself (per browser; adding a note brings them back). On a phone, where the icons otherwise sit
behind the notes, the desktop's icons then show as a grid of tiles: tap one to open it, long-press
for its menu.

Dragging works with a finger too: hold a desktop icon (in the phone's grid) or a row in Files still
for a moment and it lifts with a buzz; move the finger then and it drags, to
the same places a mouse drags to. Holding on without moving opens its menu as before, and moving
after that closes the menu and drags.

## Games

The Games app ([`src/apps/games/Games.tsx`](src/apps/games/Games.tsx)) is the arcade: picking a game
opens it in a window of its own, titled with the game's name and grouped under Games in the dock.
Each game has one window; picking it again (in the arcade, Spotlight, Launchpad, or `games tetris`
and `./tetris.game` in the terminal) brings that window forward.

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
MvL OS. **`/play`** lists the games; a link to a game that doesn't exist lands there with a note.
The server gives each page the game's title and description for link previews
([`server/index.ts`](server/index.ts)).

The game window's menu (⋯ or right-click) and a right-click on a card in the arcade have **Copy
direct link** and **Open without MvL OS**.

Saves, settings and high scores are the same ones the OS uses (same site, same browser storage), so
progress carries over both ways, and signing in from Gladiator comes back to the game's page.
Multiplayer works the same. The game in progress belongs to the browser tab instead of a window: a
reload carries on where it was, closing the tab ends it.

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

## Galactic conquest fog of war

Each side sees only part of the galaxy ([`galaxy.ts`](src/apps/games/empires/galaxy.ts)
`updateSight`, `known`, `canSee`). A side **sees a star system** while it owns a planet there, has
a fleet there (in orbit, or flying between its planets), or the system is contested for it (one of
its planets being taken, or a battle it's in). Everything else is **hidden**:
- In a hidden system we see the star, the planets and their kinds, and **what we last saw**
  (`Side.intel`): who held each planet, its station level and the enemy ships in its orbit, drawn
  faded with dashed rings and "Last seen day N" under each planet (the planet dock and tips say the
  same). A new campaign starts with the **pre-war charts**: who held what and their stations, no
  word of any fleet. Never live fleets, stations being built, captures or shipyards.
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

```sh
pnpm check:empires-spacing   # the arc, the stopping distances, following a target that moves, determinism
```

## Empires At War messages and AI

Messages about a place carry a ⌖: clicking one (or tapping it, or Enter when it has focus) takes
the camera there and selects what it's about. On the galaxy map that's the planet taken, lost,
fought over or given a station, our fleet a new ship joined, or a fleet that arrived or was
stopped by a blockade; in battle it's the ship that was built, promoted or repaired, or the spot
of an alarm, a beacon, a survey or a salvaged wreck. The × still only puts the message away.

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
| Gun platforms (level 1-2 / 3 / 4) | 1 / 2 / 3 | 0 / 1 / 1 | 0 / 0 / 1 |
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
Paladin cruiser with its turbolasers in a row on an armoured spine, and the Sovereign dreadnought
with a flight-deck trench and twin bridge towers. Its Bastion station is a squared-off military
platform of plates and girders that grows with its level: a compact eight-sided core at level 1,
short arms with docking pods and a girder frame at level 2, long arms, big pods and dry docks at
level 3, and a great outer frame on struts at level 4, square with corner bastions or octagonal
(the battle uses `STATION_FRAME` in [`republic.ts`](src/apps/games/empires/models/republic.ts);
the Codex shows both). The **Confederacy** is an industrial droid navy
([`droid.ts`](src/apps/games/empires/models/droid.ts)): weathered sand and bone plating over dark
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

The Confederacy's first, insect-like designs are kept in
[`swarm.ts`](src/apps/games/empires/models/swarm.ts) as the **Swarm**, a concept for a possible
future third faction: one design for each droid unit on that unit's box and hardpoints, in their
tan and violet palette. They are never used in battle; the Codex shows them under *Swarm
(concept)*, on the droid units' numbers, and `check:empires-models` checks them like the rest.

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
  and mirrored pairs (`sym`), and hold each faction's palette (off-white,
  deep red and blue light for the Republic; bone tan and violet for the droids; plus green for
  repair craft and gold for a station's own defense wing).
- **Hardpoints:** turrets, shield generators, hangars and station modules are mounts placed by
  the model builder on the unit's own hardpoints from [`data.ts`](src/apps/games/empires/data.ts),
  one per hardpoint and in the same order, so they sit exactly where the battle aims and the
  markers show. Destroyed flak turrets blow off (a burnt socket stays); heavy guns, shield
  generators and modules stay on, wrecked. Mount designs are in
  [`mounts.ts`](src/apps/games/empires/models/mounts.ts).
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
- **Hardpoints** (`BIG_LAYOUT`): every warship with hardpoints has a layout on its 0-10 grid, one
  turret per gun, spread over the hull with room between them. Carrier fighters launch from the
  hangars where they sit.
- **Handling** (`HANDLING`): turn rate ×0.9 / 0.8 / 0.72 / 0.65, acceleration and braking ×0.9 /
  0.8 / 0.7 / 0.6, top speed ×1 / 0.95 / 0.92 / 0.88 for gunships / frigates / cruisers /
  flagships, on the numbers as written.
- **Reach**: every gun reaches as far past its hull as it did, its range growing by as much as the
  hull's radius grew, so a 2.5× flagship doesn't spend half its range on its own hull. Formations
  and the repair tenders' reach spread out by `BIG_SPREAD` (×1.3, or the biggest ship's class).
- **Designs**: every ship bigger than strike craft is drawn in the same calm style, for all three
  sides: the Republic's in [`proto.ts`](src/apps/games/empires/models/proto.ts), the droid navy's
  in [`proto-droid.ts`](src/apps/games/empires/models/proto-droid.ts) (the Gyre in both its ring
  and carrier designs) and the Swarm concept's in
  [`proto-swarm.ts`](src/apps/games/empires/models/proto-swarm.ts). Big, quiet surfaces (long
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

1. In `data.ts`, give the unit its box (`aspect`, `size`) and its hardpoints and engines on the
   0-10 grid, as before.
2. Write a `ModelDef` in the faction's file
   ([`republic.ts`](src/apps/games/empires/models/republic.ts),
   [`droid.ts`](src/apps/games/empires/models/droid.ts)) that returns its parts on the unit's box,
   100 units on the long side, nose up (a hardpoint at grid (gx, gy) sits at
   ((gx / 10 − 0.5) × w, (gy / 10 − 0.5) × h)). Leave solid hull under every hardpoint, give
   frigates and bigger at least four parts that come off as they are battered, and tie engine
   pods to engine hardpoints (`detach: { hp }`) or engine glows (`engine`).
3. List it in `DEFS` in [`index.ts`](src/apps/games/empires/models/index.ts), and give any new
   part names a friendly name in [`codexInfo.ts`](src/apps/games/empires/codexInfo.ts).
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

```sh
pnpm check:empires-models   # every unit has a model that builds, its mounts match the hardpoints, parts come off soundly, breaks are deterministic and weighted, small craft and structures burst into real fragments
```

## Empires At War rush launch

A desperate measure for a base under attack. Once **Rushed construction** (the droids' **Hasty
assembly protocols**) is researched (800 credits, 45 s, station level 3, and it needs a Capital Yard
standing; it shows on the tech tree's Capital Yard line), the Capital Yard's build queue shows
**Rush launch (62%)** once the ship in progress is at least half built. A click sends it out now; on
a touch screen the button is held for 0.6 s (a ring fills round it) so a stray tap can't do it.

- The ship jumps in with its hull at the share that was built, no shields, and as many of its
  turrets and modules as were still to be built not yet installed: the ones furthest aft, drawn as
  scaffolding (not smoke or fire), and they don't fire or work. Its card and tooltip say
  "Rushed: 3 of 11 turrets and modules not yet installed · 23 s of work to finish it".
- Finishing it takes the build time it had left, at the build pace, only while a Drydock, repair
  craft or engineers work on it (engineers ordered onto it, or idle ones nearby by themselves);
  several of them don't make it faster. Its unbuilt hull fills in and its parts go on one by one
  (whole) as it goes, free of credits. Ordinary repairs (the Drydock's 2.5%/s, repair docks, repair
  tenders, Field repair, the repair swarm) mend battle damage but never the unbuilt hull
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

## Empires At War on touch screens

Phones and tablets play the whole game by touch ([`src/apps/games/empires/Touch.tsx`](src/apps/games/empires/Touch.tsx)),
and mouse and keyboard play is unchanged: every touch path checks `pointerType === 'touch'` or the
`(pointer: coarse)` media query.
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
- the menus and lobby scroll and fit;
- portrait shows a hint to turn the phone sideways.

## Empires At War multiplayer

The arcade's space RTS has online skirmishes: Main menu → Multiplayer → Skirmish. Anyone can play,
signed in or not, under a typed or random name; names are unique among everyone online, and a
signed-in user's GitHub login is theirs alone. The game remembers the last name you played under
(in this browser, and with your account when signed in, so it follows you to other devices) and
takes it by itself when you come back, straight to the list of battles; on a device that hasn't
loaded the account's copy yet, it waits for it rather than asking. If someone online has the name
right now, the name screen says so, with the name filled in to try again. *Change* in the
multiplayer header renames you at once; the game's Settings (and Settings → Apps → Empires At War)
show the remembered name, to change it for next time or *Forget* it, so the next visit asks. A
host sets up a battle (map, rules, starting
credits, and each spawn as open, AI (with its difficulty and style) or closed); players join from the list, pick their spawn,
faction and side, chat, and say they're ready.

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
pnpm check:empires                                              # two copies of a battle stay identical
pnpm check:empires-ws ws://localhost:5173/api/empires/ws        # names, limits and lobbies (needs pnpm dev)
pnpm check:empires-match 40 ws://localhost:5173/api/empires/ws  # a scripted battle: drift, rejoin, leave
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
middle of the map, the camera panning across); the galactic conquest map of a new and a late
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
- **Keep text out of transformed SVG.** SVG text inside a zoomed SVG is laid out again at every step
  of a zoom; put labels in an HTML layer over it (the galaxy's `.ew-gover` pins).
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

The container runs [`server/index.ts`](server/index.ts), a dependency-free Node server, as a
non-root user on port 8080 (`PORT` changes it). Its API routes live in
[`server/api.ts`](server/api.ts), shared with `pnpm dev`. It serves the built site, answers `/healthz`, serves
`/api/activity` (git.mvl.sh's activity feeds, which browsers can't read cross-origin), 
`/api/git/<owner>/<repo>/commits` (for `git log`, cached; set `GITHUB_TOKEN` to lift GitHub's
anonymous limit of 60 requests an hour), and `/api/minecraft`: a live Server List Ping of the Minecraft server, cached for 10 seconds,
so the status and join/leave notifications don't wait on public status APIs that cache for
minutes. On a static host without that endpoint the site falls back to those APIs. `pnpm dev`
and `pnpm preview` serve the endpoint too. Build the image locally with `docker build -t mvlos .`.

While it runs, the server also pings the Minecraft server every 30 seconds
([`server/minecraft.ts`](server/minecraft.ts)) and keeps 30 days of it in SQLite under `DATA_DIR`: online or
not, the player count, the ping time, and each player's visits (from the names the ping lists).
`/api/minecraft/overview?range=24h|7d|30d` turns that into the **Minecraft server** window: uptime,
players over time with the server's availability underneath, who is on and since when, recent
visits and who played most. Open it from Spotlight (Enter on the Minecraft entry), the
*Overview* button in the top bar's Minecraft popup, or `open mcserver`. `MC_WATCH=off` stops the
pinger; the window then shows the live status only.

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

Admins (`ADMIN_USERS`) also get a **Server console** in the Minecraft server window: say something
in chat, message or kick a player from *On now*, list the whitelist and add or remove names, and
run any command with its output in a scrollback (↑ for earlier ones). It goes through
`POST /api/minecraft/rcon`, which only answers signed-in admins (everyone else gets 403, and
nobody else sees the panel), takes one command per request (no newlines, at most 256 characters,
player names checked), allows 30 commands a minute per admin and logs each one with the admin's
login to the server's console. Commands that are hard to undo (`stop`, `ban`, `op`,
`whitelist off`, `kill @a` and the like) ask first.
