# mennovanleeuwen.nl

My CV as a tiny operating system: a sticky note, a terminal that actually works, and a dock
with apps for projects, contributions, recent activity, the CV itself and contact details.

Built with Vite, React and TypeScript. The CV runs entirely in the browser; a small dependency-free
Node server adds live status, GitHub sign-in for the owner and synced notes (see below).

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
shares, `jq`, `sha*sum`/`md5sum`, `figlet` and `lolcat`.

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
accent), the dock, launchers, search, links, notifications, go links, code hosts, calendar, sync and about.
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

Only GitHub logins in `ALLOWED_USERS` (default `vleeuwenmenno`) can sign in; everyone else keeps
the CV. Gitea/Forgejo instances are linked from Settings → Code hosts, in a window of their own, with a personal access token (read access to
repository, issue, user and organization). Tokens are stored encrypted (AES-256-GCM) in SQLite
(`node:sqlite`, no extra dependency) under `DATA_DIR` (default `./data`, a volume in compose).

Setup:

1. Create a GitHub OAuth app (GitHub → Settings → Developer settings → OAuth Apps) with callback
   URL `https://<your site>/api/auth/github/callback`. Local dev needs its own app with
   `http://localhost:5173/api/auth/github/callback`.
2. Put `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` in `.env`. Optional: `ALLOWED_USERS`
   (comma-separated logins), `PUBLIC_URL` (when the reverse proxy doesn't send `Host` and
   `X-Forwarded-Proto`), `SESSION_SECRET` (otherwise a random key is generated once into
   `DATA_DIR/secret.key`), `GITHUB_SCOPES` (default `read:user repo read:org`; `repo` is what
   lets Spotlight see private repositories).

Without the OAuth settings, sign-in is simply off and everything else works as before.

**Google Calendar** attaches to the GitHub sign-in (system menu or Settings → Calendar) for the
Calendar app, the Agenda widget and the clock: your calendars, shared ones included, with Google's
refresh token stored encrypted next to the Gitea tokens ([`server/google.ts`](server/google.ts)). It
needs `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` from a Google Cloud OAuth client (type *Web
application*) with the Calendar API enabled, the scopes `calendar.readonly` and `calendar.events`
(plus `openid` and `email`), and the redirect URI `https://<your site>/api/google/callback` (and
`http://localhost:5173/api/google/callback` for development). Publish the consent screen to *In
production*: in *Testing*, Google expires the access after seven days. Accounts connected before
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
folder of its own, `UUID=<library id> /home/menno seafile` makes one home (Settings' *Use as home*
and primary library write that line), and a bind line such as
`/mnt/seafile/Photos/2024 /home/menno/Pictures none bind` maps a place somewhere else. Until anything
edits it, the file is written from the older settings. The owner can `sudo nano /etc/fstab`, `sudo
mount` and `sudo umount` (visitors are not in sudoers); Files' Home, places, breadcrumbs and Seafile
section follow at once, and the site's own home is at `/srv/site` while Seafile is on `~`. In the
terminal ([`src/terminal/fs.ts`](src/terminal/fs.ts)) `ls`, `cd`, `cat`, `grep -r`, `find`, `fd`,
`tree`, `touch`, `mkdir`, `cp`, `mv`, `rm` (into Seafile's trash; in a library without history it
asks first, unless `-f`), `tee`, `>` and **nano** ([`src/terminal/nano.ts`](src/terminal/nano.ts),
GNU nano 8.2's keys on an alternate screen) work
across the mounts; before a command runs, the Seafile folders and files it names are fetched.
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

**Extract** unpacks everything, or the selected rows, into a Seafile folder (a
folder named after the archive, next to it, unless you choose another), with *keep both*, *replace*
or *skip* for names already there; Files' menu has *Extract here* and *Extract to…* on ZIPs. The
server does the work ([`server/unzip.ts`](server/unzip.ts)): it reads only the chosen files' bytes
from Seafile, never the whole archive, unpacks each to a temporary file, checks its CRC and size,
and uploads it (Seafile's upload makes the folders). Stored and deflated files unpack;
password-protected entries and other methods are reported and left out. The terminal's `unzip`
does the same with Info-ZIP's options and output (`-l`, `-v`, `-p`, `-z`, `-d`, `-x`, `-o`, `-n`,
and its `replace …? [y]es, [n]o, [A]ll, [N]one, [r]ename` question).

Each of Files' places (Home, Desktop, Documents, Downloads, Music, Pictures, Videos) can be pointed
at any folder of any library: right-click it → *Choose folder…*; a place left alone is the
same-named folder of the primary library. The desktop follows Desktop, and new Office files go to
Documents. Right-click a Seafile folder's empty space for New (folder, text file, document,
spreadsheet, presentation), Upload, View, Sort, and Seafile (copy a share link, open it in
Seafile's own web interface, the library's trash, lock now).

The mouse's Back and Forward buttons, and the browser's own Back, go back in the focused window
(Files a folder, Preview a picture, Archive up a folder) instead of leaving the site.

Questions (delete this? empty the trash?) are the desktop's own dialogs, never the browser's.

The **Code inbox** widget lists pull requests waiting for your review, your own open pull requests
and issues assigned to you, on GitHub and linked Gitea/Forgejo instances
([`server/inbox.ts`](server/inbox.ts)), with the access sign-in and linking already give.

## Widgets

Widgets sit on the desktop like sticky notes: no title bar, tape on top, a sway when dragged, a
right-click menu, and no text selection (except a sticky being edited). Desktop icons sway when
dragged too; Settings → Appearance → Motion turns either off. Several icons dragged at once gather
in a pile under the pointer with a count badge, like Finder, and fan back out into the arrangement
they had, moved to where you drop them. Add widgets from the desktop's menu (*Add widget*), All apps → Widgets or Spotlight.
Today there are five: **Sticky note** (one of your notes, with checklists you can tick),
**Weather** (now, the next hours and three days from [Open-Meteo](https://open-meteo.com), for the
browser's location or a city you pick; your pick syncs, the browser's location stays on that
device), **Agenda** (Google Calendar and CalDAV, see above), **Code inbox** and **Status** (updown.io).

The framework lives in [`src/widgets`](src/widgets). A widget is one `WidgetDef`
([`types.ts`](src/widgets/types.ts)): a name, a glyph, a size, its component, and optional hooks
for its frame colours and tilt (`useFrame`), its own menu items (`useMenu`) and how a new one is
made (`create`). List it in [`registry.tsx`](src/widgets/registry.tsx) and it gets the frame,
dragging, the menus and an *Add widget* entry everywhere. Per-widget settings go through
[`config.ts`](src/widgets/config.ts) (`useWidgetConfig` / `setWidgetConfig`), which syncs like
notes; where a widget sits is part of the synced window layout.

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
