import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { DIFFICULTY, type Difficulty } from './ai'
import { FACTIONS, type FactionId } from './data'
import { Frame, Icon } from './Hud'
import { DEFAULT_RULES, GENERATED, MAP, MAPS, MAX_BEACONS, MAX_SEED, cleanRules, generateMap, type Amount, type MapDef, type MapRules } from './maps'
import { ALLY, ENEMY, OWN, drawTerrainOverview, relColor } from './render'
import { ACTIONS, RESERVED, bindKey, keyName, keyOf, resetKeys, setSettings, useSettings, type Action, type Settings } from './settings'
import { newWorld, type Owner, type World } from './sim'
import type { Bus, EmpiresSound } from './sound'

// Everything outside a battle: the main menu, the skirmish lobby (map, players, teams), and the
// settings and key bindings, which the battle's own menu opens too.

export type SlotKind = 'you' | 'ai' | 'closed'
/** One spawn point in the lobby: who plays there, as what, on which side. Team 0 is yours. */
export type Slot = { kind: SlotKind; faction: FactionId; team: 0 | 1; difficulty: Difficulty }
/** `map` is a fixed map's id, or GENERATED to build one from `gen`. */
export type Setup = { map: string; slots: Slot[]; credits: number; gen: MapRules }

const SETUP_KEY = 'mvlos.empires.lobby'
export const CREDIT_STEPS = [500, 1000, 1600, 2500, 4000, 6000, 10000]

/** The map a setup plays on. */
export const setupMap = (s: Setup): MapDef => (s.map === GENERATED ? generateMap(s.gen) : (MAP[s.map] ?? MAPS[0]))

/** Slots for a map, keeping what was chosen before where the spawn still exists. */
function slotsFor(map: MapDef, prev: Slot[] = []): Slot[] {
  return map.spawns.map((_, i) => {
    if (prev[i]) return prev[i]
    if (i === 0) return { kind: 'you', faction: 'republic', team: 0, difficulty: 'easy' }
    return { kind: i === 1 ? 'ai' : 'closed', faction: i % 2 ? 'droid' : 'republic', team: 1, difficulty: prev[1]?.difficulty ?? 'easy' }
  })
}

/** The lobby as it was left, remembered in this browser. */
function lastSetup(): Setup {
  try {
    const v = JSON.parse(localStorage.getItem(SETUP_KEY) ?? 'null') as Partial<Setup> | null
    // Setups saved before the generator existed have no rules: they get the defaults.
    const gen = cleanRules(v?.gen)
    const map = v?.map === GENERATED ? generateMap(gen) : v?.map && MAP[v.map] ? MAP[v.map] : MAPS[0]
    const ok = (s: Partial<Slot>): s is Slot =>
      !!s && (s.kind === 'ai' || s.kind === 'closed' || s.kind === 'you') && (s.faction === 'republic' || s.faction === 'droid') && (s.team === 0 || s.team === 1) && !!s.difficulty && s.difficulty in DIFFICULTY
    const slots = Array.isArray(v?.slots) ? v.slots.filter(ok) : []
    if (slots[0]) slots[0] = { ...slots[0], kind: 'you', team: 0 }
    const credits = typeof v?.credits === 'number' && CREDIT_STEPS.includes(v.credits) ? v.credits : 1600
    return {
      map: v?.map === GENERATED ? GENERATED : map.id,
      slots: slotsFor(map, slots.slice(0, map.spawns.length)).map((s, i) => (i ? { ...s, kind: s.kind === 'you' ? 'ai' : s.kind } : s)),
      credits,
      gen,
    }
  } catch {
    return { map: MAPS[0].id, slots: slotsFor(MAPS[0]), credits: 1600, gen: { ...DEFAULT_RULES } }
  }
}

function saveSetup(s: Setup) {
  try {
    localStorage.setItem(SETUP_KEY, JSON.stringify(s))
  } catch {
    // Private mode: the lobby just won't be remembered.
  }
}

/** What a slot shows on maps and in messages: "You", "Ally 2 (Republic AI)", "Enemy 3 (Confederacy AI)". */
export const slotName = (s: Slot, i: number) => (s.kind === 'you' ? 'You' : `${s.team === 0 ? 'Ally' : 'Enemy'} ${i + 1} (${FACTIONS[s.faction].name} AI)`)

// --- Bits shared by the menus ------------------------------------------------------------------------

/** No browser or window menu on right-click anywhere in the game. */
const noMenu = (e: React.MouseEvent) => {
  e.preventDefault()
  e.stopPropagation()
}

function Seg<T extends string | number | boolean>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="ew-seg" role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={String(v)} className={value === v ? 'is-on' : ''} onClick={() => onChange(v)} aria-pressed={value === v}>
          {text}
        </button>
      ))}
    </div>
  )
}

/** A centred panel over a dimmed background; clicking outside closes it. */
export function Modal({ title, onClose, children, wide, className = '' }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; className?: string }) {
  return (
    <div className="ew-modal-back" onClick={onClose}>
      <div className={`ew-modal ${wide ? 'is-wide' : ''} ${className}`} onClick={(e) => e.stopPropagation()}>
        <Frame title={title} aside={<button className="ew-close" onClick={onClose} aria-label="Close">✕</button>}>
          {children}
        </Frame>
      </div>
    </div>
  )
}

// --- Settings and keys ----------------------------------------------------------------------------------

/** Every sound in the game on a button, to audition them. */
function SoundTest({ sound }: { sound: EmpiresSound }) {
  const at = { pan: 0, gain: 1 }
  const groups: [string, [string, () => void][]][] = [
    ['Weapons', [
      ['Blaster (Republic)', () => sound.fire('laser', at, 'republic')],
      ['Blaster (droid)', () => sound.fire('laser', at, 'droid')],
      ['Turbolaser', () => sound.fire('turbo', at, 'republic')],
      ['Flak', () => sound.fire('flak', at, 'republic')],
      ['Missile', () => sound.fire('missile', at, 'republic')],
    ]],
    ['Hits and damage', [
      ['Shield hit', () => sound.hit(true, false, at)],
      ['Hull hit', () => sound.hit(false, false, at)],
      ['Heavy hull hit', () => sound.hit(false, true, at)],
      ['Shields down', () => sound.shieldsDown(at)],
      ['Hardpoint destroyed', () => sound.hardpointDown(at)],
      ['Fighter explodes', () => sound.boom(30, at)],
      ['Frigate explodes', () => sound.boom(130, at)],
      ['Capital explodes', () => sound.boom(380, at)],
      ['Fighters launch', () => sound.launch(at)],
    ]],
    ['Republic crew', [
      ['Select fighter', () => sound.select('republic', 'fighter')],
      ['Select cruiser', () => sound.select('republic', 'cruiser')],
      ['Select flagship', () => sound.select('republic', 'capital')],
      ['Move', () => sound.order('move', 'republic')],
      ['Attack', () => sound.order('attack', 'republic')],
      ['Attack move', () => sound.order('attackMove', 'republic')],
      ['Patrol', () => sound.order('patrol', 'republic')],
      ['Hold', () => sound.order('hold', 'republic')],
      ['Stop', () => sound.order('stop', 'republic')],
      ['Rally', () => sound.order('rally', 'republic', 'station')],
      ['Target hardpoint', () => sound.order('target', 'republic')],
    ]],
    ['Droid crew', [
      ['Select fighter', () => sound.select('droid', 'fighter')],
      ['Select flagship', () => sound.select('droid', 'capital')],
      ['Move', () => sound.order('move', 'droid')],
      ['Attack', () => sound.order('attack', 'droid')],
      ['Hold', () => sound.order('hold', 'droid')],
      ['Target hardpoint', () => sound.order('target', 'droid')],
    ]],
    ['Station and economy', [
      ['Queue ship', () => sound.queued()],
      ['Cancel ship', () => sound.unqueued()],
      ['Ship ready', () => sound.shipReady('republic', 'frigate')],
      ['Flagship ready', () => sound.shipReady('republic', 'capital')],
      ['Research started', () => sound.researchStarted()],
      ['Research done', () => sound.researchDone()],
      ['Station level up', () => sound.levelUp()],
      ['Construction', () => sound.constructing()],
      ['Mine online', () => sound.structureDone('mine')],
      ['Defense online', () => sound.structureDone('defense')],
      ['Ore surveyed', () => sound.surveyed()],
      ['Beacon taken', () => sound.capture(true)],
      ['Beacon lost', () => sound.capture(false)],
    ]],
    ['Abilities', [
      ['Shield boost', () => sound.ability('shieldBoost')],
      ['Flak barrage', () => sound.ability('flakBarrage')],
      ['Repair swarm', () => sound.ability('repairSwarm')],
      ['Tractor lock', () => sound.ability('tractor')],
      ['Full broadside', () => sound.ability('broadside')],
      ['Launch swarm', () => sound.ability('launchSwarm')],
    ]],
    ['Alerts and interface', [
      ['Under attack', () => sound.alarm(false)],
      ['Station under attack', () => sound.alarm(true)],
      ['Ally eliminated', () => sound.eliminated(true)],
      ['Enemy eliminated', () => sound.eliminated(false)],
      ['Command armed', () => sound.arm()],
      ['Click', () => sound.click()],
      ['Denied', () => sound.error()],
      ['Menu open', () => sound.menu(true)],
      ['Menu close', () => sound.menu(false)],
      ['Pause', () => sound.pause(true)],
      ['Resume', () => sound.pause(false)],
      ['Victory', () => sound.victory()],
      ['Defeat', () => sound.defeat()],
    ]],
  ]
  return (
    <div className="ew-soundtest">
      {groups.map(([g, items]) => (
        <section key={g}>
          <h5>{g}</h5>
          <div className="ew-soundgrid">
            {items.map(([label, play]) => (
              <button key={label} onClick={() => (sound.unlock(), play())}>
                {label}
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

export function SettingsPanel({ sound }: { sound: EmpiresSound }) {
  const s = useSettings()
  const [vol, setVol] = useState(sound.volume)
  const [muted, setMuted] = useState(sound.muted)
  const [mix, setMix] = useState(sound.mix)
  const [testing, setTesting] = useState(false)
  const set = (next: Partial<Settings>) => setSettings(next)
  return (
    <div className="ew-form">
      <h5>Sound</h5>
      <label className="ew-row">
        <span>Master volume</span>
        <span className="ew-range">
          <input type="range" min={0} max={1} step={0.05} value={vol} onChange={(e) => (sound.setVolume(Number(e.target.value)), setVol(Number(e.target.value)))} />
          <b>{Math.round(vol * 100)}%</b>
        </span>
      </label>
      {(
        [
          ['sfx', 'Battle'],
          ['voice', 'Unit responses'],
          ['ui', 'Interface and alerts'],
          ['amb', 'Ambience'],
        ] as [Bus, string][]
      ).map(([bus, label]) => (
        <label key={bus} className="ew-row">
          <span>{label}</span>
          <span className="ew-range">
            <input type="range" min={0} max={1} step={0.05} value={mix[bus]} onChange={(e) => (sound.setMix(bus, Number(e.target.value)), setMix({ ...sound.mix }))} />
            <b>{Math.round(mix[bus] * 100)}%</b>
          </span>
        </label>
      ))}
      <div className="ew-row">
        <span>Sound</span>
        <Seg label="Sound effects" value={!muted} options={[[true, 'On'], [false, 'Off']]} onChange={(on) => (sound.setMuted(!on), setMuted(!on))} />
      </div>
      <h5>Camera</h5>
      <label className="ew-row">
        <span>Scroll speed</span>
        <span className="ew-range">
          <input type="range" min={0.4} max={2.5} step={0.1} value={s.cameraSpeed} onChange={(e) => set({ cameraSpeed: Number(e.target.value) })} />
          <b>{s.cameraSpeed.toFixed(1)}×</b>
        </span>
      </label>
      <div className="ew-row">
        <span>Edge scrolling</span>
        <Seg label="Edge scrolling" value={s.edgeScroll} options={[['off', 'Off'], ['fullscreen', 'Fullscreen only'], ['always', 'Always']]} onChange={(v) => set({ edgeScroll: v })} />
      </div>
      <h5>Battlefield</h5>
      <div className="ew-row">
        <span>Health bars</span>
        <Seg label="Health bars" value={s.bars} options={[['damaged', 'Damaged'], ['always', 'Always'], ['selected', 'Selected only']]} onChange={(v) => set({ bars: v })} />
      </div>
      <div className="ew-row">
        <span>Team rings under ships</span>
        <Seg label="Team rings" value={s.rings} options={[[true, 'On'], [false, 'Off']]} onChange={(v) => set({ rings: v })} />
      </div>
      <div className="ew-row">
        <span>Messages</span>
        <Seg label="Messages" value={s.toasts} options={[[true, 'All'], [false, 'Alerts only']]} onChange={(v) => set({ toasts: v })} />
      </div>
      <h5>Sound test</h5>
      {testing ? <SoundTest sound={sound} /> : <button className="ew-soundtest-open" onClick={() => (sound.unlock(), setTesting(true))}>Play every sound in the game…</button>}
    </div>
  )
}

export function KeybindsPanel() {
  const s = useSettings()
  const [waiting, setWaiting] = useState<Action | null>(null)
  // While waiting, the next key press is the new binding; Esc gives up. Listening in the capture
  // phase keeps the battle from acting on it too.
  useEffect(() => {
    if (!waiting) return
    const on = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopImmediatePropagation()
      const k = keyOf(e)
      if (k !== 'escape' && !RESERVED.has(k) && !e.ctrlKey && !e.metaKey && !e.altKey && !['shift', 'control', 'alt', 'meta'].includes(k)) bindKey(waiting, k)
      setWaiting(null)
    }
    window.addEventListener('keydown', on, true)
    return () => window.removeEventListener('keydown', on, true)
  }, [waiting])
  const groups = [...new Set(ACTIONS.map((a) => a.group))]
  return (
    <div className="ew-form">
      <p className="ew-muted ew-small">Click a binding, then press the new key. A key that's already used swaps places. Arrow keys always move the camera; 1–9 are control groups.</p>
      <div className="ew-keys">
        {groups.map((g) => (
          <section key={g}>
            <h5>{g}</h5>
            {ACTIONS.filter((a) => a.group === g).map((a) => (
              <div key={a.id} className="ew-row">
                <span>{a.label}</span>
                <button className={`ew-keycap ${waiting === a.id ? 'is-on' : ''}`} onClick={() => setWaiting(waiting === a.id ? null : a.id)}>
                  {waiting === a.id ? 'Press a key…' : keyName(s.keys[a.id])}
                </button>
              </div>
            ))}
          </section>
        ))}
      </div>
      <div className="ew-form-foot">
        <button onClick={resetKeys}>Reset to defaults</button>
      </div>
    </div>
  )
}

export function HowToPlay() {
  const { keys } = useSettings()
  const k = (a: Action) => <kbd>{keyName(keys[a])}</kbd>
  return (
    <div className="ew-form ew-howto">
      <ul>
        <li>Destroy every enemy station. A side is out when its stations are gone.</li>
        <li>Drag to select ships. Right-click to move, or to attack what's under the cursor.</li>
        <li>Park ships at glowing ore for a few seconds to survey it, then click it to build a mining platform (credits) or a defense platform (guns).</li>
        <li>Hold ships near a beacon to capture it: more income and a bigger fleet for your whole team.</li>
        <li>Select your station ({k('station')}) to build ships. Open the tech tree ({k('techTree')}) to research upgrades, including station levels that unlock frigates, cruisers and a flagship. The battle carries on while it's open.</li>
        <li>Big ships have hardpoints. Hover one and right-click a marker to target it: knock out shield generators first.</li>
        <li>Fighters beat cruisers and flagships, gunships beat fighters, frigates beat gunships, cruisers beat frigates.</li>
        <li>Asteroid fields wear down frigates, cruisers and flagships flying through them (fighters and gunships dodge the rocks). Nebulas knock out shields and halve sensor range.</li>
      </ul>
      <p className="ew-muted ew-small">
        Commands: {k('move')} move, {k('attack')} attack move, {k('patrol')} patrol, {k('hold')} hold, {k('stop')} stop, {k('ability')} ability, {k('rally')} rally point. Camera: {k('panUp')}
        {k('panLeft')}
        {k('panDown')}
        {k('panRight')} or arrows, wheel to zoom. Ctrl+1–9 sets a control group. {k('pause')} pauses, Esc opens the menu.
      </p>
    </div>
  )
}

// --- Main menu ------------------------------------------------------------------------------------------

export function MainMenu({ sound, victories, onPlay }: { sound: EmpiresSound; victories: number; onPlay: () => void }) {
  const [panel, setPanel] = useState<'settings' | 'keys' | 'howto' | null>(null)
  const click = (fn: () => void) => () => {
    sound.unlock()
    sound.click()
    fn()
  }
  return (
    <div className="ew-root ew-deck ew-menu" style={{ backgroundImage: 'url(/games/empires/world/title.webp)' }} onContextMenu={noMenu}>
      <div className="ew-menu-col">
        <h1 className="ew-logo">
          Empires <span>at</span> War
        </h1>
        <p className="ew-tagline">A war in the stars, fought one fleet at a time.</p>
        <Frame className="ew-menu-frame">
          <button className="ew-menu-btn is-primary" onClick={click(onPlay)}>
            <Icon name="attack" size={20} /> Skirmish
          </button>
          <button className="ew-menu-btn" onClick={click(() => setPanel('settings'))}>
            <Icon name="gear" size={20} /> Settings
          </button>
          <button className="ew-menu-btn" onClick={click(() => setPanel('keys'))}>
            <Icon name="menu" size={20} /> Keybinds
          </button>
          <button className="ew-menu-btn" onClick={click(() => setPanel('howto'))}>
            <Icon name="help" size={20} /> How to play
          </button>
        </Frame>
        <p className="ew-muted ew-small">Victories: {victories}</p>
      </div>
      {panel === 'settings' && (
        <Modal title="Settings" onClose={() => setPanel(null)}>
          <SettingsPanel sound={sound} />
        </Modal>
      )}
      {panel === 'keys' && (
        <Modal title="Keybinds" onClose={() => setPanel(null)} wide>
          <KeybindsPanel />
        </Modal>
      )}
      {panel === 'howto' && (
        <Modal title="How to play" onClose={() => setPanel(null)}>
          <HowToPlay />
        </Modal>
      )}
    </div>
  )
}

// --- Lobby ---------------------------------------------------------------------------------------------

const slotColor = (s: Slot) => (s.kind === 'closed' ? '#5a6478' : s.kind === 'you' ? OWN : s.team === 0 ? ALLY : ENEMY)

/** The map from above: nebulas, asteroid fields, rocks, ore, beacons, and the spawns numbered and
 * coloured by slot. */
function MapPreview({ map, slots, className = '' }: { map: MapDef; slots?: Slot[]; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  // The real map, with dummy players, for its asteroid layout (maps are seeded, so it matches).
  const [world] = useState(() => new Map<string, ReturnType<typeof newWorld>>())
  useEffect(() => {
    const c = ref.current
    if (!c) return
    let w = world.get(map.id)
    if (!w) {
      // Rerolling a generated map makes a new one each time: keep only the last few.
      if (world.size > 12) world.clear()
      world.set(map.id, (w = newWorld(map, map.spawns.map((_, i) => ({ faction: 'republic', team: i, spawn: i })))))
    }
    const draw = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const cw = c.clientWidth
      const ch = c.clientHeight
      c.width = Math.max(1, Math.round(cw * dpr))
      c.height = Math.max(1, Math.round(ch * dpr))
      const g = c.getContext('2d')!
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      const s = Math.min(cw / map.w, ch / map.h)
      const ox = (cw - map.w * s) / 2
      const oy = (ch - map.h * s) / 2
      g.clearRect(0, 0, cw, ch)
      g.fillStyle = '#050813'
      g.fillRect(ox, oy, map.w * s, map.h * s)
      g.strokeStyle = 'rgba(140,180,240,0.08)'
      for (let x = 700; x < map.w; x += 700) g.strokeRect(ox + x * s, oy, 0, map.h * s)
      for (let y = 700; y < map.h; y += 700) g.strokeRect(ox, oy + y * s, map.w * s, 0)
      drawTerrainOverview(g, map, ox, oy, s)
      g.fillStyle = 'rgba(150,150,165,0.45)'
      for (const r of w!.rocks) {
        g.beginPath()
        g.arc(ox + r.x * s, oy + r.y * s, Math.max(1, r.r * s * 0.8), 0, Math.PI * 2)
        g.fill()
      }
      g.fillStyle = '#4fe3d8'
      for (const n of map.ore) {
        const x = ox + n.x * s
        const y = oy + n.y * s
        g.beginPath()
        g.moveTo(x, y - 4)
        g.lineTo(x + 3, y)
        g.lineTo(x, y + 4)
        g.lineTo(x - 3, y)
        g.fill()
      }
      g.strokeStyle = '#c8d4ee'
      g.lineWidth = 1.5
      for (const b of map.beacons) {
        g.beginPath()
        g.arc(ox + b.x * s, oy + b.y * s, 5, 0, Math.PI * 2)
        g.stroke()
      }
      const big = cw > 260
      map.spawns.forEach((p, i) => {
        const slot = slots?.[i]
        const x = ox + p.x * s
        const y = oy + p.y * s
        const r = big ? 11 : 6
        g.fillStyle = slot ? slotColor(slot) : '#c8d4ee'
        g.globalAlpha = slot?.kind === 'closed' ? 0.5 : 1
        g.beginPath()
        g.arc(x, y, r, 0, Math.PI * 2)
        g.fill()
        g.globalAlpha = 1
        if (big) {
          g.fillStyle = '#050813'
          g.font = '700 12px system-ui'
          g.textAlign = 'center'
          g.textBaseline = 'middle'
          g.fillText(String(i + 1), x, y + 0.5)
        }
      })
      g.strokeStyle = 'rgba(183,154,98,0.5)'
      g.lineWidth = 1
      g.strokeRect(ox + 0.5, oy + 0.5, map.w * s - 1, map.h * s - 1)
    }
    draw()
    const ro = new ResizeObserver(draw)
    ro.observe(c)
    return () => ro.disconnect()
  }, [map, slots, world])
  return <canvas ref={ref} className={`ew-mappreview ${className}`} />
}

const AMOUNTS: [Amount, string][] = [
  ['none', 'None'],
  ['few', 'Few'],
  ['many', 'Many'],
]

/** The generator's rules: compact rows under the map preview, which redraws as they change. */
function GenControls({ rules, onChange, onReroll }: { rules: MapRules; onChange: (patch: Partial<MapRules>) => void; onReroll: () => void }) {
  return (
    <div className="ew-genrules">
      <div className="ew-row">
        <span>Players</span>
        <Seg<2 | 3 | 4> label="Players" value={rules.players} options={[[2, '2'], [3, '3'], [4, '4']]} onChange={(v) => onChange({ players: v })} />
      </div>
      <div className="ew-row">
        <span>Size</span>
        <Seg label="Size" value={rules.size} options={[['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']]} onChange={(v) => onChange({ size: v })} />
      </div>
      <div className="ew-row">
        <span>Ore</span>
        <Seg label="Ore" value={rules.resources} options={[['scarce', 'Scarce'], ['normal', 'Normal'], ['rich', 'Rich']]} onChange={(v) => onChange({ resources: v })} />
      </div>
      <div className="ew-row">
        <span>Beacons</span>
        <select value={String(rules.beacons)} onChange={(e) => onChange({ beacons: e.target.value === 'auto' ? 'auto' : Number(e.target.value) })} aria-label="Beacons">
          <option value="auto">Auto</option>
          {Array.from({ length: MAX_BEACONS + 1 }, (_, i) => (
            <option key={i} value={i}>{i}</option>
          ))}
        </select>
      </div>
      <div className="ew-row">
        <span>Asteroid fields</span>
        <Seg label="Asteroid fields" value={rules.asteroidFields} options={AMOUNTS} onChange={(v) => onChange({ asteroidFields: v })} />
      </div>
      <div className="ew-row">
        <span>Nebulas</span>
        <Seg label="Nebulas" value={rules.nebulas} options={AMOUNTS} onChange={(v) => onChange({ nebulas: v })} />
      </div>
      <div className="ew-row">
        <span>Seed</span>
        <span className="ew-seed">
          <input
            type="number"
            min={0}
            max={MAX_SEED}
            value={rules.seed}
            onChange={(e) => onChange({ seed: Math.min(MAX_SEED, Math.max(0, Math.floor(Number(e.target.value)) || 0)) })}
            aria-label="Seed"
          />
          <button onClick={onReroll} title="A new random seed">Reroll</button>
        </span>
      </div>
    </div>
  )
}

export function Lobby({ sound, onBack, onLaunch }: { sound: EmpiresSound; onBack: () => void; onLaunch: (s: Setup) => void }) {
  const [setup, setSetup] = useState(lastSetup)
  const generated = useMemo(() => generateMap(setup.gen), [setup.gen])
  const isGen = setup.map === GENERATED
  const map = isGen ? generated : (MAP[setup.map] ?? MAPS[0])
  const update = (next: Setup) => {
    setSetup(next)
    saveSetup(next)
  }
  const setSlot = (i: number, patch: Partial<Slot>) => update({ ...setup, slots: setup.slots.map((s, j) => (j === i ? { ...s, ...patch } : s)) })
  const pickMap = (m: MapDef, id = m.id) => {
    sound.click()
    update({ ...setup, map: id, slots: slotsFor(m, setup.slots.slice(0, m.spawns.length)) })
  }
  const setRules = (patch: Partial<MapRules>) => {
    const gen = cleanRules({ ...setup.gen, ...patch })
    const m = generateMap(gen)
    update({ ...setup, gen, slots: isGen ? slotsFor(m, setup.slots.slice(0, m.spawns.length)) : setup.slots })
  }
  const enemies = setup.slots.filter((s) => s.kind === 'ai' && s.team === 1).length
  const allies = setup.slots.filter((s) => s.kind === 'ai' && s.team === 0).length
  const step = Math.max(0, CREDIT_STEPS.indexOf(setup.credits))
  return (
    <div className="ew-root ew-deck ew-lobby" style={{ backgroundImage: 'url(/games/empires/world/title.webp)' }} onContextMenu={noMenu}>
      <header className="ew-lobby-head">
        <button onClick={() => (sound.click(), onBack())}>← Main menu</button>
        <h2>Skirmish</h2>
      </header>
      <div className="ew-lobby-grid">
        <Frame title="Map" className="ew-lobby-maps">
          <div className="ew-maplist">
            {MAPS.map((m) => (
              <button key={m.id} className={`ew-mapcard ${!isGen && m.id === map.id ? 'is-on' : ''}`} onClick={() => pickMap(m)} aria-pressed={!isGen && m.id === map.id}>
                <MapPreview map={m} className="is-thumb" />
                <span>
                  <strong>{m.name}</strong>
                  <small>{m.spawns.length} players</small>
                </span>
              </button>
            ))}
            <button className={`ew-mapcard ${isGen ? 'is-on' : ''}`} onClick={() => pickMap(generated, GENERATED)} aria-pressed={isGen}>
              <MapPreview map={generated} className="is-thumb" />
              <span>
                <strong>Generated</strong>
                <small>{generated.spawns.length} players · seed {setup.gen.seed}</small>
              </span>
            </button>
          </div>
        </Frame>
        <Frame title={map.name} className="ew-lobby-preview" aside={<span className="ew-muted ew-small">{map.spawns.length} spawns · {map.beacons.length} beacons · {map.ore.length} ore</span>}>
          <MapPreview map={map} slots={setup.slots} />
          <p className="ew-muted">{map.blurb}</p>
          {isGen && (
            <GenControls
              rules={setup.gen}
              onChange={setRules}
              onReroll={() => {
                sound.click()
                setRules({ seed: Math.floor(Math.random() * (MAX_SEED + 1)) })
              }}
            />
          )}
        </Frame>
        <Frame title="Players" className="ew-lobby-slots">
          <div className="ew-slotlist">
            {setup.slots.map((s, i) => (
              <div key={i} className={`ew-slotrow ${s.kind === 'closed' ? 'is-closed' : ''}`}>
                <span className="ew-spawnno" style={{ background: slotColor(s) }}>{i + 1}</span>
                {s.kind === 'you' ? (
                  <strong className="ew-slotwho">You</strong>
                ) : (
                  <select className="ew-slotwho" value={s.kind} onChange={(e) => setSlot(i, { kind: e.target.value as SlotKind })} aria-label={`Spawn ${i + 1}`}>
                    <option value="ai">AI</option>
                    <option value="closed">Closed</option>
                  </select>
                )}
                {s.kind !== 'closed' && (
                  <>
                    <div className="ew-seg ew-factionseg" role="group" aria-label="Faction">
                      {(['republic', 'droid'] as FactionId[]).map((f) => (
                        <button key={f} className={s.faction === f ? 'is-on' : ''} onClick={() => setSlot(i, { faction: f })} title={FACTIONS[f].long} aria-pressed={s.faction === f}>
                          <img src={`/games/empires/world/emblem-${f}.webp`} alt="" />
                          {FACTIONS[f].name}
                        </button>
                      ))}
                    </div>
                    {s.kind === 'you' ? (
                      <span className="ew-teamtag is-own">Your team</span>
                    ) : (
                      <button className={`ew-teamtag ${s.team === 0 ? 'is-ally' : 'is-enemy'}`} onClick={() => setSlot(i, { team: s.team === 0 ? 1 : 0 })} title="Click to switch sides">
                        {s.team === 0 ? 'Ally' : 'Enemy'}
                      </button>
                    )}
                    {s.kind === 'ai' && (
                      <select value={s.difficulty} onChange={(e) => setSlot(i, { difficulty: e.target.value as Difficulty })} aria-label="Difficulty" title={DIFFICULTY[s.difficulty].blurb}>
                        {(Object.keys(DIFFICULTY) as Difficulty[]).map((d) => (
                          <option key={d} value={d}>{DIFFICULTY[d].name}</option>
                        ))}
                      </select>
                    )}
                  </>
                )}
              </div>
            ))}
          </div>
          <p className="ew-muted ew-small">
            {setup.slots.length > 2 ? 'Open more spawns for bigger battles: allies fight beside you, enemies against you. ' : ''}
            {DIFFICULTY[setup.slots.find((s) => s.kind === 'ai' && s.team === 1)?.difficulty ?? 'easy'].blurb}
          </p>
          <h5>Starting credits</h5>
          <label className="ew-range">
            <input type="range" min={0} max={CREDIT_STEPS.length - 1} step={1} value={step} onChange={(e) => update({ ...setup, credits: CREDIT_STEPS[Number(e.target.value)] })} aria-label="Starting credits" />
            <b>{setup.credits.toLocaleString('en-US')}</b>
          </label>
          <div className="ew-launch">
            <span className="ew-muted ew-small">
              {enemies ? `You${allies ? ` and ${allies} ${allies === 1 ? 'ally' : 'allies'}` : ''} against ${enemies} ${enemies === 1 ? 'enemy' : 'enemies'}` : 'Add at least one enemy.'}
            </span>
            <button className="ew-go" disabled={!enemies} onClick={() => (sound.unlock(), sound.click(), onLaunch(setup))}>
              Launch battle
            </button>
          </div>
        </Frame>
      </div>
    </div>
  )
}

// --- After the battle --------------------------------------------------------------------------------

const fmt = (n: number) => Math.floor(n).toLocaleString('en-US')
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

export function Result({ w, me, names, won, onAgain, onExit }: { w: World; me: Owner; names: string[]; won: boolean; onAgain: () => void; onExit: () => void }) {
  const order = w.players.map((p, i) => ({ p, i })).sort((a, b) => (a.p.team === w.players[me].team ? 0 : 1) - (b.p.team === w.players[me].team ? 0 : 1))
  return (
    <div className="ew-modal-back">
      <div className={`ew-modal ew-result ${won ? 'is-won' : 'is-lost'}`}>
        <Frame title={won ? 'Victory' : 'Defeat'} aside={<span className="ew-muted ew-small">{clock(w.time)} · {w.map.name}</span>}>
          <h2>{won ? 'Victory' : 'Defeat'}</h2>
          <p className="ew-muted">{won ? 'Every enemy station is destroyed.' : 'Our side has no stations left.'}</p>
          <table>
            <thead>
              <tr>
                <th />
                <th>Built</th>
                <th>Kills</th>
                <th>Losses</th>
                <th>Earned</th>
              </tr>
            </thead>
            <tbody>
              {order.map(({ p, i }) => (
                <tr key={i} className={p.alive ? '' : 'is-out'}>
                  <td>
                    <i className="ew-dot" style={{ background: relColor(w, me, i) }} />
                    {names[i]}
                  </td>
                  <td>{p.stats.built}</td>
                  <td>{p.stats.killed}</td>
                  <td>{p.stats.lost}</td>
                  <td>{fmt(p.stats.earned)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="ew-menu-list is-row">
            <button className="ew-menu-btn is-primary" onClick={onAgain}>Fight again</button>
            <button className="ew-menu-btn" onClick={onExit}>Back to the lobby</button>
          </div>
        </Frame>
      </div>
    </div>
  )
}
