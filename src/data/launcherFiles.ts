import { formatDesktopFile, getLocalized, getValue, joinList, newDesktopFile, setValue, splitList, tryParseDesktopFile } from './desktopEntry.ts'

// Launchers as .desktop files: what a launcher is, how one is read from a file and written to
// one, the file names they get, and moving the launchers of before (one list, kept with notes)
// into files. Nothing here touches the browser or a filesystem directly: the files go through a
// port (src/data/launchers.ts gives the real one; scripts/launchers-check.ts gives stand-ins), so
// the same code is checked headless.

export type Launcher = {
  /** Stays the same when the file moves or is renamed: X-MvL-Id, or one made from the file's path */
  id: string
  label: string
  /** The web address it opens ('' for one that opens an MvL OS app) */
  url: string
  /** An emoji instead of the site's favicon */
  glyph?: string
  /** A picture instead of the site's favicon (Icon= with an image address) */
  image?: string
  /** false: dock and menus only (kept in ~/.local/share/applications rather than ~/Desktop) */
  desktop?: boolean
  /** Its .desktop file, as Files has it (seafile://… or a filesystem path); none for a visitor's */
  file?: string
  /** An MvL OS app it opens, with these props (X-MvL-App, X-MvL-Props), instead of a web address */
  app?: string
  props?: Record<string, string>
}

export const ID_KEY = 'X-MvL-Id'
export const APP_KEY = 'X-MvL-App'
export const PROPS_KEY = 'X-MvL-Props'
/** In the applications folder: the ids of the old launchers already written as files. */
export const MIGRATED = '.mvlos-migrated'

export const isLauncherName = (name: string) => /\.desktop$/i.test(name)

/** Adds https:// when the scheme is missing; refuses anything that isn't http(s). */
export function cleanUrl(input: string): string | null {
  const raw = input.trim()
  if (!raw) return null
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  } catch {
    return null
  }
}

/** An id for a launcher file that has none of its own, the same every time for the same path. */
export function idForPath(path: string): string {
  let h = 2166136261
  for (let i = 0; i < path.length; i++) h = Math.imul(h ^ path.charCodeAt(i), 16777619) >>> 0
  return `f${h.toString(36)}`
}

/** What Icon= holds: a picture's address, an emoji, or (an icon theme's name) nothing we can show. */
export function readIcon(icon: string | null): { glyph?: string; image?: string } {
  const v = icon?.trim()
  if (!v) return {}
  if (/^(https?:\/\/|data:image\/)/i.test(v) || /^\/[^/]/.test(v)) return { image: v }
  if ([...v].length <= 8 && /[^\x00-\x7f]/.test(v)) return { glyph: v }
  return {}
}

/** X-MvL-Props: a list of key=value. */
const readProps = (v: string | null): Record<string, string> | undefined => {
  if (!v) return undefined
  const out: Record<string, string> = {}
  for (const item of splitList(v)) {
    const eq = item.indexOf('=')
    if (eq > 0) out[item.slice(0, eq)] = item.slice(eq + 1)
  }
  return Object.keys(out).length ? out : undefined
}

/**
 * A launcher from a .desktop file's text: Type=Link with an http(s) URL=, or an MvL OS app
 * (X-MvL-App) that `isApp` knows. Anything else (a program to run, a broken file, Hidden=true)
 * is not a launcher here, and shows as the plain file it is.
 */
export function launcherFromText(text: string, file: string, opts: { desktop?: boolean; languages?: readonly string[]; isApp?: (app: string) => boolean } = {}): Launcher | null {
  const f = tryParseDesktopFile(text)
  if (!f) return null
  if (getValue(f, 'Hidden') === 'true') return null
  const type = getValue(f, 'Type')
  const app = getValue(f, APP_KEY)?.trim() || undefined
  const name = file.split('/').pop()!.replace(/\.desktop$/i, '')
  const label = (getLocalized(f, 'Name', opts.languages) ?? '').trim() || name
  const id = getValue(f, ID_KEY)?.trim() || idForPath(file)
  const icon = readIcon(getValue(f, 'Icon'))
  if (app && (opts.isApp ? opts.isApp(app) : true)) return { id, label, url: '', ...icon, desktop: opts.desktop, file, app, props: readProps(getValue(f, PROPS_KEY)) }
  if (type !== 'Link') return null
  const url = cleanUrl(getValue(f, 'URL') ?? '')
  if (!url) return null
  return { id, label, url, ...icon, desktop: opts.desktop, file }
}

/**
 * The text of a launcher's .desktop file. With `previous` (the file as it is), only the keys a
 * launcher has are changed and everything else in it stays; a new name replaces the localised
 * ones too, so a rename shows in every language.
 */
export function launcherText(l: Omit<Launcher, 'file' | 'desktop'>, previous?: string): string {
  const icon = l.glyph?.trim() || l.image?.trim() || null
  const props = l.props && Object.keys(l.props).length ? joinList(Object.entries(l.props).map(([k, v]) => `${k}=${v}`)) : null
  const base = previous ? tryParseDesktopFile(previous) : null
  if (!base)
    return formatDesktopFile(
      newDesktopFile(
        l.app
          ? [
              ['Type', 'Application'],
              ['Name', l.label],
              ['Exec', `open ${l.app}`],
              ['Icon', icon],
              [APP_KEY, l.app],
              [PROPS_KEY, props],
              [ID_KEY, l.id],
            ]
          : [
              ['Type', 'Link'],
              ['Name', l.label],
              ['URL', l.url],
              ['Icon', icon],
              [ID_KEY, l.id],
            ],
      ),
    )
  let f = base
  const named = getLocalized(f, 'Name', []) !== l.label
  f = setValue(f, 'Name', l.label, { dropLocalized: named })
  if (l.app) {
    f = setValue(f, APP_KEY, l.app)
    f = setValue(f, PROPS_KEY, props)
  } else f = setValue(f, 'URL', l.url)
  f = setValue(f, 'Icon', icon)
  f = setValue(f, ID_KEY, l.id)
  return formatDesktopFile(f)
}

/** The id a launcher file says it has (X-MvL-Id), without reading the rest. */
export const idInText = (text: string) => {
  const f = tryParseDesktopFile(text)
  return f ? getValue(f, ID_KEY)?.trim() || null : null
}

/** A file name for a launcher: its name, made safe, ".desktop"; "Name 2.desktop" when that is taken. */
export function launcherFileName(label: string, taken: Set<string>): string {
  const stem =
    label
      .replace(/[/\\\x00-\x1f\x7f:*?"<>|]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^\.+/, '')
      .slice(0, 60)
      .trim() || 'Launcher'
  if (!taken.has(`${stem}.desktop`)) return `${stem}.desktop`
  for (let n = 2; ; n++) if (!taken.has(`${stem} ${n}.desktop`)) return `${stem} ${n}.desktop`
}

// --- the files, through a port ------------------------------------------------------------------

export type LauncherPort = {
  /** A folder's entries, asked fresh; null when it is not there. */
  list: (dir: string) => Promise<{ name: string; dir: boolean }[] | null>
  read: (path: string) => Promise<string>
  /** Writes a file, replacing one of that name; its folder exists. */
  write: (path: string, text: string) => Promise<void>
  /** Makes a folder and the ones above it, if they are not there. */
  mkdirp: (dir: string) => Promise<void>
}

export type LauncherDirs = { desktop: string; apps: string }

/** Every launcher in the two folders: the desktop's and the applications folder. */
export async function readLaunchers(port: LauncherPort, dirs: LauncherDirs, opts: { languages?: readonly string[]; isApp?: (app: string) => boolean } = {}): Promise<Launcher[]> {
  const out: Launcher[] = []
  for (const [dir, desktop] of [
    [dirs.desktop, true],
    [dirs.apps, false],
  ] as const) {
    for (const e of (await port.list(dir)) ?? []) {
      if (e.dir || !isLauncherName(e.name)) continue
      const path = `${dir}/${e.name}`
      const l = launcherFromText(await port.read(path).catch(() => ''), path, { desktop, ...opts })
      if (l) out.push(l)
    }
  }
  return out
}

/**
 * Writes the launchers of before (a list kept with notes and the dock) as files: those on the
 * desktop into its folder, the rest into the applications folder, each keeping its id (the dock
 * and Spotlight's favourites point at it). Once only, wherever it runs: the ids written are kept
 * in the applications folder (MIGRATED), so a second device on the same home (Seafile) finds them
 * done, and a launcher deleted since does not come back. A launcher whose id is already in a file
 * there (another device got halfway) is skipped, and file names follow from the names alone, so
 * two devices doing it at the same moment write the same files rather than two of each. A home
 * of its own (files in this browser) gets its own copy. Nothing is taken out of the old list.
 */
export async function migrateLaunchers(port: LauncherPort, legacy: Omit<Launcher, 'file'>[], dirs: LauncherDirs): Promise<{ written: string[]; skipped: string[] }> {
  const written: string[] = []
  const skipped: string[] = []
  if (!legacy.length) return { written, skipped }
  const marker = `${dirs.apps}/${MIGRATED}`
  await port.mkdirp(dirs.apps)
  const appsList = (await port.list(dirs.apps)) ?? []
  const done = new Set(appsList.some((e) => e.name === MIGRATED && !e.dir) ? (await port.read(marker)).split('\n').map((s) => s.trim()).filter(Boolean) : [])
  const todo = legacy.filter((l) => !done.has(l.id))
  if (!todo.length) return { written, skipped: legacy.map((l) => l.id) }
  await port.mkdirp(dirs.desktop)
  // What is there already: names taken in each folder, and the launcher ids in them.
  const taken = new Map<string, Set<string>>()
  const ids = new Map<string, string>() // id -> file
  for (const dir of [dirs.desktop, dirs.apps]) {
    const list = dir === dirs.apps ? appsList : ((await port.list(dir)) ?? [])
    taken.set(dir, new Set(list.map((e) => e.name)))
    for (const e of list) {
      if (e.dir || !isLauncherName(e.name)) continue
      const id = idInText(await port.read(`${dir}/${e.name}`).catch(() => ''))
      if (id) ids.set(id, `${dir}/${e.name}`)
    }
  }
  for (const l of todo) {
    if (ids.has(l.id)) {
      skipped.push(l.id)
      continue
    }
    const dir = l.desktop === false ? dirs.apps : dirs.desktop
    const names = taken.get(dir)!
    const name = launcherFileName(l.label, names)
    names.add(name)
    const path = `${dir}/${name}`
    await port.write(path, launcherText(l))
    ids.set(l.id, path)
    written.push(path)
  }
  await port.write(marker, `${[...done, ...todo.map((l) => l.id)].join('\n')}\n`)
  return { written, skipped }
}
