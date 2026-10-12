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
```

## Look and themes

The design follows Omarchy: square windows with a 2px accent border on the active one, a solid
bar, one monospace face, and colours from Omarchy's own theme palettes
([`src/os/omarchyThemes.ts`](src/os/omarchyThemes.ts), generated from
`/usr/share/omarchy/themes/*/colors.toml`). Day is Flexoki Light, night is Tokyo Night, and
"auto" follows the OS. The sun/moon button in the bar toggles; right-click it (or the desktop)
for every Omarchy theme and accent overrides. `theme list` / `theme <name>` in the terminal too.

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
on the open windows.

Real tools live in [`src/terminal/extra.ts`](src/terminal/extra.ts) and run from the visitor's
browser: `curl`/`wget` (any site that allows cross-origin requests, e.g. `curl wttr.in/Amsterdam`,
never the visitor's own network), `whois` (RDAP), `git log`/`git show` on the real repos,
`htop`, `watch`, `cmatrix`, `df`/`free`/`nproc`/`lscpu`/`xrandr`/`ip` with the numbers the browser
shares, `jq`, `sha*sum`/`md5sum`, `figlet` and `lolcat`. With Seafile linked, `df` also lists its
mounts: the account's quota and usage (`/api/seafile/quota`), and each library's own size next to
what is left of the quota; `du` (`-a`, `-s`, `-c`, `-d`, `-h`, `-x`) adds up folders through the
mounts, Seafile's included.

`find` and `fd` ([`src/terminal/find.ts`](src/terminal/find.ts)) follow GNU findutils 4.10 and fd 10.2
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

### Terminal settings

The Terminal has its own settings sheet ([`src/terminal/TerminalSettings.tsx`](src/terminal/TerminalSettings.tsx)),
opened from its window menu (Terminal settings…), its right-click menu, or `settings` at the prompt
(`settings system` opens the Settings app instead). The same settings, less the per-window zoom,
are in Settings → Apps → Terminal, and the sheet's *Open in Settings…* goes there. They are kept in
this browser and synced like notes when signed in ([`src/terminal/prefs.ts`](src/terminal/prefs.ts)):
- **Text size**, separately for desktops and for phones (below the 720 px breakpoint, where
  windows fill the screen). Changes apply live. The single size saved before carries over to both.
- **Zoom** for one window only, until it closes: Ctrl + / − / 0, Ctrl with the scroll wheel, or a
  two-finger pinch on a touch screen, with a badge showing the new size. It multiplies the text
  size. Full-screen programs (nano, htop, `agents`) redraw to the new rows and columns, which
  `stty size` prints.
- **Extra keys** on touch screens ([`src/terminal/ExtraKeys.tsx`](src/terminal/ExtraKeys.tsx)),
  like Termux's: Esc, Tab, Ctrl, Alt, Shift, arrows, Home, End and `~ | / -` above the keyboard
  while the prompt has it. Ctrl, Alt and Shift apply to the next key when tapped, lock when
  tapped twice, and apply while held; they also apply to letters typed on the keyboard (Ctrl, then
  c, is Ctrl+C). The keys go through the same handler as a real keyboard, so completion, history
  and full-screen programs get them as usual. The row can be turned off.

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

- **Context.** There is no `/compact` and no summarising. Older tool output is cut to 1,500
  characters, but a long coding session can still outgrow the model's context window.
- **Not in the TUI yet:**
  - Claude Code's undo/rewind, custom slash commands, hooks, MCP servers, subagents,
    background tasks and usage display
  - image paste (`@path` attaches text files only)
- **Tried in the browser:** messages, approvals, forms, plan mode, `!`, `#`, `@`, `/status`,
  `/context`, `/model`, `/resume`, `-c`, `-p`, `ls`. **Not tried:** Esc interrupting a turn,
  messages queued while it works, `/export`, `/copy`, `/open`, `/delete`, `/archive`,
  `/projects`, `/tools`, Ctrl+O and Ctrl+L.
- **Rendering.**
  - The live block redraws whole on each streamed chunk, and a long reply only shows its tail
    until it is done.
  - Markdown has no syntax highlighting, and the terminal's markup does not nest (no bold in
    colour).
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

## Notes, launchers and sign-in (home page mode)

Anyone can write notes and add launchers: **Notebook** (dock) lists every note in Markdown, and
each one can sit on the desktop as a sticky (right-click the desktop → *New sticky note*). Stickies
get a random tilt and colour, both changeable from the sticky's hover bar or menu. **Settings**
(system menu, [`src/apps/Settings.tsx`](src/apps/Settings.tsx)) is laid out like macOS System
Settings: the account on top of a sidebar, then one pane each for appearance (mode, Omarchy themes,
accent), the dock, launchers, Spotlight, windows, links, notifications, go links, code hosts and
integrations; then, under an **Apps** heading, one pane per app with settings of its own, with the
app's dock icon ([`src/apps/AppSettings.tsx`](src/apps/AppSettings.tsx)); then sync, users and about.
The Apps panes are Agents, Calendar (its accounts and calendars, the view it opens in and where new
events go), Files (view, icon size, sort order, hidden files, sidebar), Games (Pool's helpers,
sensitivity, computer and sound; Gladiator's sound and music; Empires At War's sound, battlefield,
camera and a summary of its key bindings, with a button into the game's own key bindings and sound
mix), Omamp (shuffle, repeat, equalizer and preset, visualizer, time, its windows), PDF (sidebar,
night mode), Preview (sidebar) and Terminal. Each pane reads and writes the very store the app uses
([`src/data/appPrefs.ts`](src/data/appPrefs.ts), [`src/apps/games/prefs.ts`](src/apps/games/prefs.ts),
through [`src/os/localPref.ts`](src/os/localPref.ts) for what stays in this browser), so an open
window follows a change at once and the other way round. Those apps' window menus have *… settings…*
to jump to their pane.
Settings → Spotlight picks what the empty Spotlight shows (favourites, recently visited websites,
status, apps, your repositories) and how many recent items of each, which kinds of results it searches, whether Enter on an unmatched query searches the
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
Spotlight or All apps to pin it. Settings → Dock lists what was taken off, to add it back, and
restores the default dock. Everyone can still drag dock icons to reorder them.

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

**Google Calendar** attaches to the GitHub sign-in (system menu or Settings → Calendar) for the
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
the Calendar app stay read-only until connected again (Settings → Calendar → *Allow editing*).

**CalDAV** calendars (Fastmail, Nextcloud, iCloud and others) work next to Google: Settings →
Calendar → add an account with its server URL (Fastmail's is filled in), username and an app
password, stored encrypted ([`server/caldav.ts`](server/caldav.ts)). Read-only is enough to look;
the Calendar app needs read-write to change things (adding the same account again replaces its
password). The calendars are found from the URL, and events are fetched by date range with the
server expanding repeating events, so everything shows both sources together.

The **Calendar** app ([`src/apps/calendar`](src/apps/calendar)) shows the switched-on calendars by
day, three days, week, month or year. Drag on an empty spot to make an event, drag an event to
move it, drag its bottom edge to change its length; open one to change its title, time, place,
notes, calendar and guests (invited by email by Google or the CalDAV server). For one occurrence
of a repeating event it asks whether the change is for that one or the whole series. Changes go
through [`server/calendars.ts`](server/calendars.ts): Google's API, or the event's own iCalendar
text on the CalDAV server, written back with its ETag so other apps' properties stay.

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
the Viewer; the rest downloads. Encrypted libraries ask for their password in the window and lock
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
pdf.js) and pictures, from Seafile, this computer, a drop or a paste. Its tools: web search
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
keep up to date (and how often they are checked), what a new thread starts with, and shows the system prompt: `~/AGENTS.md`, your own from Seafile when Seafile is
home, otherwise a read-only built-in one ([`src/data/agentsPrompt.ts`](src/data/agentsPrompt.ts)).
Spotlight takes questions too: *Ask Agents* is under the web search, and a `?` in front makes it
the top hit. `OLLAMA_URL` points it at a stand-in for ollama.com when testing.

The Calendar tools ([`server/agentCalendar.ts`](server/agentCalendar.ts)) work on the calendars
connected in Settings → Apps → Calendar, Google and CalDAV, shared ones included, through the same
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
it opens the thread. The server's keys are `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`, or generated
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
GitHub and git.mvl.sh (every 5 minutes, each item once, back as far as Settings says), and calendar
reminders (Google and CalDAV, read every 5 minutes, a reminder 0–30 minutes before an event). The
list of sources and the rules for the choices are one file both sides import
([`src/data/notifySources.ts`](src/data/notifySources.ts)), so Settings lists exactly what the
server can send. Signed out, a visitor's pop-ups and list stay in that browser, from the page's
own watchers. `NOTIFY_WATCH=off` leaves the watchers off.

The **Code inbox** widget lists pull requests waiting for your review, your own open pull requests
and issues assigned to you, on GitHub and linked Gitea/Forgejo instances
([`server/inbox.ts`](server/inbox.ts)), with the access sign-in and linking already give.

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
does not select its labels or show the browser's callout.

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

## Empires At War weapon ranges and repair craft

Hovering a ship or structure in battle (ours, or an enemy we can see) rings it with its weapon
ranges ([`render.ts`](src/apps/games/empires/render.ts) `drawRanges`): one ring per kind of gun
and reach, each kind in its own colour and dash (lasers solid red, flak amber, turbolasers blue,
missiles pink dots, ion violet), labelled with its name and range, plus a faint dashed ring for its
sensors. On a touch screen, which has no hover, the selected ships show theirs. The setting
*Show weapon ranges on hover* (on by default) is in the game's Settings and in Settings → Apps →
Games → Empires At War.

Each side has a repair squadron of two strike craft, the Republic's Suture repair fighter and the
droids' Weaver repair droid ([`data.ts`](src/apps/games/empires/data.ts)). They launch from the
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
Republic's five Aegis pickets or the droids' six Gnat guard droids, smaller and frailer than line
fighters. They cost nothing, take no fleet space and can't be built, retreat or escape with a
conquest fleet. Their station is their parent, as a carrier's fighters are theirs, so when idle
they circle it and take on whatever comes near, chasing it only so far. They can be ordered
anywhere and come home once their orders are done, but more than 1,400 from their station, or
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

In Empires At War's Galactic conquest each side keeps at most **4 fleets at a planet**
(`MAX_FLEETS` in [`galaxy.ts`](src/apps/games/empires/galaxy.ts)). Selecting a planet, or a fleet
of ours at one, opens **Fleets at <planet>** ([`Inventory.tsx`](src/apps/games/empires/Inventory.tsx)):
our fleets there side by side, each an inventory of slots holding a stack per kind of ship, with an
empty *New fleet* column while there are fewer than 4.
- **Mouse:** drag a stack onto another fleet to move it (it stacks with the same kind there); Shift
  or the right button drags half, Ctrl one. Click a stack to pick it up and click a fleet to put it
  there; double-click sends it to the next fleet. After every move a bar under the title sets the
  exact count (− + All). Dragging a fleet's header onto another joins them; clicking a header
  selects that fleet for orders.
- **Touch:** tap a stack to pick it up and tap a fleet to put it there (the touch bar's Shift takes
  half); a long press opens a wheel: *Move all*, *Move half*, *Move…* (with − + for the count), *New
  fleet*, *Hold back* or *Deploy*, *Select fleet*. A long press on a fleet's header: select, hold
  back all, join another fleet.
- **Held back:** the shield row under each fleet holds ships back (`Fleet.reserve`, how many of
  each kind). Move ships into it like into another fleet, or click a stack's corner icon (the
  header's shield does the whole fleet). When the fleet fights, the rest jump in as before and the
  held back ships start in the battle's reserve tray, to be called in during the fight; ones never
  called in come out of a won battle untouched (and jump out with the rest of a lost one, except
  fighters, as with any reserve). The battle prompt shows the split. Auto-resolve counts held back
  ships in full but brings them in 4 seconds late (`RESERVE_CALL`), or at once when nothing else of
  their side is left: holding back a third of an even fleet costs about a third of its chances.
- **Moves** only happen between our fleets at the same planet; a fleet in flight shows its
  inventory read-only (it can still change what it holds back). A fleet that gives away its last
  ship is gone, and the selection follows its ships.
- **The cap:** fleets of ours arriving where we already have 4 join the biggest there (one with
  the same stops queued first); new ships join the first fleet at their planet; the AI keeps its
  fleets at a planet together, as before, and deploys everything. Fleets keep their make-up and
  held back ships through a battle. Old saves with more than 4 fleets at a planet are merged down
  to 4 on load, keeping the ones with orders. Fleets that meet at a planet stay apart; *Gather*
  sends them to the biggest one to join up.

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
  fleet; only the AI's income multiplier differs (0.55, 0.7, 1 and 1.15).
- **Battles** ([`ai.ts`](src/apps/games/empires/ai.ts)): at most 25, 35, 60 or 100 actions a
  minute (a move for a group of ships is one), and it notices an attack on its base 6 to 1 seconds
  late. It runs on the battle's own clock and dice, so multiplayer copies stay in step.

```sh
pnpm check:empires-galaxy [weeks] [runs] [turtle|expand]  # campaigns vs a scripted player: orders a minute, fleets, wandering, the fleet cap
pnpm check:empires-fleets                                 # the fleet inventory: moves, the cap, held back ships into battles, old saves
pnpm empires:battle-ai [games] [minutes]                  # AI-only battles: wins per pairing, actions a minute against the cap
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
takes it by itself when you come back; if someone online has it right now (you, on another
device), it says so and offers a free one instead. A host sets up a battle (map, rules, starting
credits, and each spawn as open, AI or closed); players join from the list, pick their spawn,
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
steps you away: your seat is kept for 60 seconds, and the battle pauses for everyone meanwhile
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
Empires → Multiplayer again rejoins the battle; the main menu shows *Rejoin battle* while your seat
may still be waiting. Come back too late and the game says what happened to your fleet.

Battles survive a restart of the site (a deploy, or watchtower pulling a new image). On SIGTERM
the server writes every player (name and token), lobby and battle (the server's own copy, at its
last tick) to `DATA_DIR/empires-state.json`, tells the players it is restarting (WebSocket close
code 1012), and exits. The new server reads the file back and deletes it (one older than 10
minutes, from another version or unreadable is ignored). Players have 3 minutes to reconnect, which
their games do by themselves with their token, and each gets the server's battle back. A battle
waits at the tick it stopped on: everyone in it has stepped away, with nobody counting down until
the first player is back; from then the others get the usual 60 seconds (and the vote), and the
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
`main` and every pull request.

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
