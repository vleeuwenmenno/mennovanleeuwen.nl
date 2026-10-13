import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AMP_PRESETS, ampPrefs, ampPresetOf, FILES_SORTS, FILES_VIEWS, FILES_ZOOM_MAX, FILES_ZOOM_MIN, filesPrefs, pdfPrefs, previewPrefs, type AmpRepeat, type AmpVis } from '../data/appPrefs'
import { useCalendarList, useLastCalendar, setLastCalendar } from '../data/calendar'
import { useAccount } from '../os/account'
import { IntegrationNotice } from '../os/IntegrationNotice'
import { Select } from '../os/Select'
import { useWM } from '../os/wm'
import { TerminalPrefsBody, ZOOM_HELP } from '../terminal/TerminalSettings'
import { calendarView, VIEWS } from './calendar/time'
import { gameInfo } from './games/catalog'
import { NAME_MAX, nameProblem, tidyName } from './games/empires/names'
import { mpName } from './games/empires/net'
import { ACTIONS, askPanel, DEFAULT_KEYS, keyName, resetKeys, setSettings as setEmpires, useSettings as useEmpires, type AskedPanel } from './games/empires/settings'
import { empiresMusic, empiresMuted, empiresVolume, gladiatorMusic, gladiatorMuted, gladiatorVolume, POOL_DRAG, POOL_LEVELS, poolMuted, poolSettings, poolVolume, type PoolSensitivity } from './games/prefs'

// Settings → Apps: one pane per app with preferences of its own (the Agents pane is in
// AgentsSettings.tsx, the Calendar accounts in Settings.tsx). Each reads and writes the same store
// the app does (src/data/appPrefs.ts, src/apps/games/prefs.ts, src/terminal/prefs.ts...), so an
// open window follows a change here at once, and the other way round. Only real, lasting
// preferences are here: not what a window remembers of itself (its size, the folder it was on).

export const SetGroup = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="set-section">
    <h4>{title}</h4>
    {children}
  </section>
)

export function Toggle({ on, onChange, label }: { on: boolean; onChange: (on: boolean) => void; label: string }) {
  return <button role="switch" aria-checked={on} aria-label={label} className={`set-toggle ${on ? 'is-on' : ''}`} onClick={() => onChange(!on)} />
}

/** One choice of a few, as segmented buttons. */
export function Seg<T extends string | boolean>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg set-seg" role="radiogroup" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={String(v)} role="radio" aria-checked={value === v} className={value === v ? 'is-active' : ''} onClick={() => onChange(v)}>
          {text}
        </button>
      ))}
    </div>
  )
}

/** A row with a name, a line under it, and its control on the right. */
export function Row({ title, hint, children, stack }: { title: string; hint?: ReactNode; children: ReactNode; stack?: boolean }) {
  return (
    <li className={`set-row ${stack ? 'set-row-stack' : ''}`}>
      <span className="set-row-text">
        <strong>{title}</strong>
        {/* Wraps: a hint here is a short sentence (the changed key bindings can be several). */}
        {hint && <span className="muted set-row-wrap">{hint}</span>}
      </span>
      {children}
    </li>
  )
}

/** A 0 to 1 volume as a slider, in percent. */
function Volume({ value, onChange, label, disabled }: { value: number; onChange: (v: number) => void; label: string; disabled?: boolean }) {
  return (
    <span className="set-range">
      <input type="range" min={0} max={1} step={0.05} value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} aria-label={label} />
      <output>{Math.round(value * 100)}%</output>
    </span>
  )
}

const now = () => String(Date.now())

// --- Terminal ------------------------------------------------------------------------------------

/** The same settings as the sheet in a terminal window, without the zoom (that is per window). */
export function TerminalPane() {
  const wm = useWM()
  return (
    <TerminalPrefsBody
      onAppearance={() => wm.open('settings', { section: 'appearance', t: now() })}
      zoom={
        <SetGroup title="Zoom">
          <p className="muted set-help">Zoom is for one terminal window at a time, until it closes: {ZOOM_HELP} The window's own settings (its menu → Terminal settings…, or the settings command) show it too.</p>
        </SetGroup>
      }
    />
  )
}

// --- Files ---------------------------------------------------------------------------------------

export function FilesPane() {
  const prefs = filesPrefs.use()
  const account = useAccount()
  const zoom = (z: number) => filesPrefs.patch({ zoom: Math.min(FILES_ZOOM_MAX, Math.max(FILES_ZOOM_MIN, z)) })
  return (
    <>
      {account.status === 'user' && <IntegrationNotice sub="seafile" linked={!!account.seafile} app="Files" invite="Link Seafile to get your libraries in Files." />}
      <SetGroup title="View">
        <Seg label="View" value={prefs.view} options={FILES_VIEWS} onChange={(view) => filesPrefs.patch({ view })} />
        <p className="muted set-help">Ctrl+1 to Ctrl+4 in Files.</p>
      </SetGroup>
      <ul className="set-list">
        <Row title="Icon size" hint="Ctrl + and Ctrl − in Files">
          <span className="t-stepper" role="group" aria-label="Icon size">
            <button type="button" className="btn btn-small" aria-label="Smaller icons" disabled={prefs.zoom <= FILES_ZOOM_MIN} onClick={() => zoom(prefs.zoom - 10)}>
              −
            </button>
            <output aria-live="polite">{prefs.zoom}%</output>
            <button type="button" className="btn btn-small" aria-label="Larger icons" disabled={prefs.zoom >= FILES_ZOOM_MAX} onClick={() => zoom(prefs.zoom + 10)}>
              +
            </button>
            <button type="button" className="btn btn-small btn-ghost" disabled={prefs.zoom === 100} onClick={() => zoom(100)}>
              Default
            </button>
          </span>
        </Row>
        <Row title="Sort by" hint="Folders always come first">
          <Select className="set-select" value={prefs.sort} onChange={(sort) => filesPrefs.patch({ sort })} aria-label="Sort by" options={FILES_SORTS.map(([value, label]) => ({ value, label }))} />
        </Row>
        <Row title="Show hidden files" hint="Names starting with a dot · Ctrl+H">
          <Toggle on={prefs.hidden} onChange={(hidden) => filesPrefs.patch({ hidden })} label="Show hidden files" />
        </Row>
        <Row title="Sidebar" hint="Places, libraries and bookmarks, in a wide window">
          <Toggle on={prefs.sidebar} onChange={(sidebar) => filesPrefs.patch({ sidebar })} label="Show the sidebar" />
        </Row>
        <Row title="Video thumbnails" hint="A frame from each video, here, on the desktop and in Photos">
          <Toggle on={prefs.videoThumbs} onChange={(videoThumbs) => filesPrefs.patch({ videoThumbs })} label="Video thumbnails" />
        </Row>
      </ul>
      <p className="muted set-help">The same in every folder and every Files window. Saved in this browser.</p>
      {account.seafile && (
        <p className="muted set-help">
          Seafile as home, its trash and where new Office files go are in Integrations → Seafile.
        </p>
      )}
    </>
  )
}

// --- Omamp ---------------------------------------------------------------------------------------

export function AmpPane() {
  const prefs = ampPrefs.use()
  const preset = ampPresetOf(prefs.bands)
  return (
    <>
      <SetGroup title="Playback">
        <ul className="set-list">
          <Row title="Shuffle" hint="S in Omamp">
            <Toggle on={prefs.shuffle} onChange={(shuffle) => ampPrefs.patch({ shuffle })} label="Shuffle" />
          </Row>
          <Row title="Repeat" hint="R in Omamp" stack>
            <Seg<AmpRepeat>
              label="Repeat"
              value={prefs.repeat}
              options={[
                ['off', 'Off'],
                ['all', 'The folder'],
                ['one', 'One track'],
              ]}
              onChange={(repeat) => ampPrefs.patch({ repeat })}
            />
          </Row>
        </ul>
      </SetGroup>
      <SetGroup title="Equalizer">
        <ul className="set-list">
          <Row title="Equalizer on">
            <Toggle on={prefs.eq} onChange={(eq) => ampPrefs.patch({ eq })} label="Equalizer on" />
          </Row>
          <Row title="Preset" hint={preset ? undefined : 'Custom: set band by band in Omamp'}>
            <Select className="set-select" value={preset ?? ''} placeholder="Custom" onChange={(k) => ampPrefs.patch({ bands: AMP_PRESETS[k], eq: true })} aria-label="Equalizer preset" options={Object.keys(AMP_PRESETS).map((k) => ({ value: k, label: k }))} />
          </Row>
        </ul>
      </SetGroup>
      <SetGroup title="Display">
        <ul className="set-list">
          <Row title="Visualizer" hint="Or click it in the display" stack>
            <Seg<AmpVis>
              label="Visualizer"
              value={prefs.vis}
              options={[
                ['bars', 'Spectrum'],
                ['scope', 'Oscilloscope'],
                ['off', 'Off'],
              ]}
              onChange={(vis) => ampPrefs.patch({ vis })}
            />
          </Row>
          <Row title="Time" hint="Or click the clock" stack>
            <Seg
              label="Time"
              value={prefs.remaining}
              options={[
                [false, 'Elapsed'],
                [true, 'Remaining'],
              ]}
              onChange={(remaining) => ampPrefs.patch({ remaining })}
            />
          </Row>
          <Row title="Equalizer window">
            <Toggle on={prefs.showEq} onChange={(showEq) => ampPrefs.patch({ showEq })} label="Show the equalizer" />
          </Row>
          <Row title="Playlist window">
            <Toggle on={prefs.showPl} onChange={(showPl) => ampPrefs.patch({ showPl })} label="Show the playlist" />
          </Row>
        </ul>
      </SetGroup>
      <p className="muted set-help">Volume and balance stay with the player itself. Saved in this browser.</p>
    </>
  )
}

// --- PDF and Preview -----------------------------------------------------------------------------

export function PdfPane() {
  const prefs = pdfPrefs.use()
  return (
    <>
      <ul className="set-list">
        <Row title="Sidebar" hint="Page thumbnails and the outline">
          <Toggle on={prefs.sidebar} onChange={(sidebar) => pdfPrefs.patch({ sidebar })} label="Show the sidebar" />
        </Row>
        <Row title="Night mode" hint="Pages dark, with light text">
          <Toggle on={prefs.night} onChange={(night) => pdfPrefs.patch({ night })} label="Night mode" />
        </Row>
      </ul>
      <p className="muted set-help">Every PDF window uses these. Saved in this browser.</p>
    </>
  )
}

export function PreviewPane() {
  const prefs = previewPrefs.use()
  return (
    <>
      <ul className="set-list">
        <Row title="Sidebar" hint="The other pictures in the folder · S in Preview">
          <Toggle on={prefs.sidebar} onChange={(sidebar) => previewPrefs.patch({ sidebar })} label="Show the sidebar" />
        </Row>
      </ul>
      <p className="muted set-help">Every Preview window uses this. Saved in this browser.</p>
    </>
  )
}

// --- Calendar ------------------------------------------------------------------------------------

/** Under the accounts in Settings → Apps → Calendar: how the Calendar app opens, and where new events go. */
export function CalendarAppPrefs() {
  const view = calendarView.use()
  const last = useLastCalendar()
  const { calendars } = useCalendarList()
  const writable = (calendars ?? []).filter((c) => c.writable !== false)
  return (
    <SetGroup title="Calendar app">
      <ul className="set-list">
        <Row title="Opens in" hint="The view you used last, until you pick another" stack>
          <Seg label="Opens in" value={view} options={VIEWS.map((v) => [v.id, v.label])} onChange={(v) => calendarView.set(v)} />
        </Row>
        {writable.length > 0 && (
          <Row title="New events go in" hint="Until you pick another calendar for one">
            <Select className="set-select" value={writable.some((c) => c.id === last) ? last! : ''} placeholder={writable[0].name} onChange={setLastCalendar} aria-label="New events go in" options={writable.map((c) => ({ value: c.id, label: c.name }))} />
          </Row>
        )}
      </ul>
    </SetGroup>
  )
}

// --- Games ---------------------------------------------------------------------------------------

/** One game's part of the Games pane: its name, a way to play, and its settings. */
function GameSection({ id, opened, children }: { id: string; /** When this game was asked for (its window menu → settings) */ opened?: string; children: ReactNode }) {
  const wm = useWM()
  const info = gameInfo(id)!
  const ref = useRef<HTMLElement>(null)
  // Asked for this game: scroll it into view.
  useEffect(() => {
    if (opened) ref.current?.scrollIntoView({ block: 'start' })
  }, [opened])
  return (
    <section className="set-section set-game" ref={ref} id={`set-game-${id}`}>
      <div className="set-detail-head">
        <span className="set-glyph" aria-hidden>
          {info.glyph}
        </span>
        <strong>{info.name}</strong>
        <span className="nb-spacer" />
        <button className="btn btn-small" onClick={() => wm.open('games', { game: id, t: now() })}>
          Play
        </button>
      </div>
      {children}
    </section>
  )
}

const SENSITIVITY: [PoolSensitivity, string][] = [
  ['low', 'Low'],
  ['medium', 'Medium'],
  ['high', 'High'],
]
const cap = (s: string) => s[0].toUpperCase() + s.slice(1)

function PoolSettings() {
  const s = poolSettings.use()
  const muted = poolMuted.use()
  const volume = poolVolume.use()
  return (
    <ul className="set-list">
      <Row title="Helpers" hint={s.helpers ? 'Aim line and power meter shown' : 'No aim line or power meter'}>
        <Toggle on={s.helpers} onChange={(helpers) => poolSettings.patch({ helpers })} label="Pool helpers" />
      </Row>
      <Row title="Sensitivity" hint={`Full power takes a ${Math.round(POOL_DRAG[s.sensitivity] * 100)} cm pull on the table`} stack>
        <Seg label="Sensitivity" value={s.sensitivity} options={SENSITIVITY} onChange={(sensitivity) => poolSettings.patch({ sensitivity })} />
      </Row>
      <Row title="Computer" hint="How well the computer plays" stack>
        <Seg label="Computer difficulty" value={s.level} options={POOL_LEVELS.map((l) => [l, cap(l)])} onChange={(level) => poolSettings.patch({ level })} />
      </Row>
      <Row title="Sound" hint="M in the game">
        <Volume label="Pool volume" value={volume} disabled={muted} onChange={(v) => (poolVolume.set(v), v > 0 && poolMuted.set(false))} />
        <Toggle on={!muted} onChange={(on) => poolMuted.set(!on)} label="Pool sound" />
      </Row>
    </ul>
  )
}

function GladiatorSettings() {
  const muted = gladiatorMuted.use()
  const music = gladiatorMusic.use()
  const volume = gladiatorVolume.use()
  return (
    <ul className="set-list">
      <Row title="Sound" hint="M in a fight">
        <Volume label="Gladiator volume" value={volume} disabled={muted} onChange={(v) => (gladiatorVolume.set(v), v > 0 && gladiatorMuted.set(false))} />
        <Toggle on={!muted} onChange={(on) => gladiatorMuted.set(!on)} label="Gladiator sound" />
      </Row>
      <Row title="Music" hint="War drums in the arena, a lyre in town">
        <Toggle on={music} onChange={(on) => gladiatorMusic.set(on)} label="Gladiator music" />
      </Row>
    </ul>
  )
}

/** The name Empires At War takes by itself on joining multiplayer (empires/net.ts): changed here
 * for next time, or forgotten so the next visit asks for one. */
function EmpiresName() {
  const name = mpName.use()
  const [draft, setDraft] = useState<string | null>(null)
  const why = draft === null ? null : nameProblem(tidyName(draft))
  const hint = draft !== null ? (draft && why) || 'Taken by itself the next time you join' : name ? `${name}, taken by itself when you join` : 'None yet: asked when you join'
  return (
    <Row title="Multiplayer name" hint={hint}>
      {draft === null ? (
        <>
          {name && (
            <button className="btn btn-small btn-ghost" onClick={() => mpName.set(null)}>
              Forget
            </button>
          )}
          <button className="btn btn-small" onClick={() => setDraft(name ?? '')}>
            {name ? 'Change…' : 'Pick one…'}
          </button>
        </>
      ) : (
        <form
          className="set-inline-edit"
          onSubmit={(e) => {
            e.preventDefault()
            if (why) return
            mpName.set(tidyName(draft))
            setDraft(null)
          }}
        >
          <input value={draft} maxLength={NAME_MAX + 4} autoFocus spellCheck={false} onChange={(e) => setDraft(e.target.value)} aria-label="Multiplayer name" aria-invalid={!!why} />
          <button className="btn btn-small" type="submit" disabled={!!why}>
            Save
          </button>
          <button className="btn btn-small btn-ghost" type="button" onClick={() => setDraft(null)}>
            Cancel
          </button>
        </form>
      )}
    </Row>
  )
}

function EmpiresSettings() {
  const wm = useWM()
  const s = useEmpires()
  const muted = empiresMuted.use()
  const music = empiresMusic.use()
  const volume = empiresVolume.use()
  const changed = ACTIONS.filter((a) => s.keys[a.id] !== DEFAULT_KEYS[a.id])
  // The game's own panels, for what only makes sense there: the key bindings and the sound mix.
  const open = (panel: AskedPanel) => {
    askPanel(panel)
    wm.open('games', { game: 'empires', t: now() })
  }
  return (
    <>
      <ul className="set-list">
        <Row title="Sound">
          <Volume label="Empires At War volume" value={volume} disabled={muted} onChange={(v) => empiresVolume.set(v)} />
          <Toggle on={!muted} onChange={(on) => empiresMuted.set(!on)} label="Empires At War sound" />
        </Row>
        <Row title="Music">
          <Toggle on={music} onChange={(on) => empiresMusic.set(on)} label="Empires At War music" />
        </Row>
        <Row title="Day ends sound" hint="A soft tick each day in Galactic conquest">
          <Toggle on={s.daySound} onChange={(on) => setEmpires({ daySound: on })} label="Sound when a day ends" />
        </Row>
        <Row title="Sound mix" hint="Battle, unit responses, interface, ambience and music each have their own volume">
          <button className="btn btn-small" onClick={() => open('settings')}>
            In the game…
          </button>
        </Row>
      </ul>
      <ul className="set-list">
        <EmpiresName />
      </ul>
      <ul className="set-list">
        <Row title="Health bars" stack>
          <Seg
            label="Health bars"
            value={s.bars}
            options={[
              ['damaged', 'Damaged'],
              ['always', 'Always'],
              ['selected', 'Selected only'],
            ]}
            onChange={(bars) => setEmpires({ bars })}
          />
        </Row>
        <Row title="Team rings under ships">
          <Toggle on={s.rings} onChange={(rings) => setEmpires({ rings })} label="Team rings under ships" />
        </Row>
        <Row title="Show weapon ranges on hover" hint="Rings for each gun's reach and the sensors round the ship or station under the pointer; on a touch screen, round the selected ones">
          <Toggle on={s.ranges} onChange={(ranges) => setEmpires({ ranges })} label="Show weapon ranges on hover" />
        </Row>
        <Row title="Fog of war grid" hint={`Where sight ends, cell by cell · ${keyName(s.keys.fogGrid)} in a battle`}>
          <Toggle on={s.fogGrid} onChange={(fogGrid) => setEmpires({ fogGrid })} label="Fog of war grid" />
        </Row>
        <Row title="Messages" hint="Builds, captures and research, or only what goes wrong" stack>
          <Seg
            label="Messages"
            value={s.toasts}
            options={[
              [true, 'All'],
              [false, 'Alerts only'],
            ]}
            onChange={(toasts) => setEmpires({ toasts })}
          />
        </Row>
        <Row title="Ships the station isn't upgraded for" hint="In the shipyard" stack>
          <Seg
            label="Locked ships"
            value={s.lockedShips}
            options={[
              [false, 'Hide'],
              [true, 'Show greyed out'],
            ]}
            onChange={(lockedShips) => setEmpires({ lockedShips })}
          />
        </Row>
      </ul>
      <ul className="set-list">
        <Row title="Camera scroll speed" hint="With a mouse">
          <span className="set-range">
            <input type="range" min={0.4} max={2.5} step={0.1} value={s.cameraSpeed} onChange={(e) => setEmpires({ cameraSpeed: Number(e.target.value) })} aria-label="Camera scroll speed" />
            <output>{s.cameraSpeed.toFixed(1)}×</output>
          </span>
        </Row>
        <Row title="Edge scrolling" hint="Moving the mouse to the edge of the screen" stack>
          <Seg
            label="Edge scrolling"
            value={s.edgeScroll}
            options={[
              ['off', 'Off'],
              ['fullscreen', 'Fullscreen only'],
              ['always', 'Always'],
            ]}
            onChange={(edgeScroll) => setEmpires({ edgeScroll })}
          />
        </Row>
        <Row title="Key bindings" hint={changed.length ? `${changed.length} of ${ACTIONS.length} changed: ${changed.map((a) => `${a.label} ${keyName(s.keys[a.id])}`).join(', ')}` : `The defaults for all ${ACTIONS.length}: WASD moves the camera, Q stops, E attack-moves`}>
          {changed.length > 0 && (
            <button className="btn btn-small btn-ghost" onClick={resetKeys}>
              Defaults
            </button>
          )}
          <button className="btn btn-small" onClick={() => open('keys')}>
            Change…
          </button>
        </Row>
      </ul>
    </>
  )
}

/** Every game with settings of its own, one section each; `sub` scrolls to one. */
export function GamesPane({ sub, t }: { sub?: string; t?: string }) {
  const at = (id: string) => (sub === id ? (t ?? id) : undefined)
  return (
    <>
      <GameSection id="pool" opened={at('pool')}>
        <PoolSettings />
      </GameSection>
      <GameSection id="gladiator" opened={at('gladiator')}>
        <GladiatorSettings />
      </GameSection>
      <GameSection id="empires" opened={at('empires')}>
        <EmpiresSettings />
      </GameSection>
      <p className="muted set-help">Tetris, Pac-Man, Snake, Minesweeper and Breakout have no settings. These stay in this browser; high scores, Gladiator's saves and your Empires At War multiplayer name follow you between devices once signed in.</p>
    </>
  )
}
