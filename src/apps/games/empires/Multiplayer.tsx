import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { DIFFICULTY, type Difficulty } from './ai'
import { CREDIT_STEPS, FACTIONS, type FactionId } from './data'
import { Frame, Icon, Tips } from './Hud'
import { GENERATED, MAP, MAPS, MAX_SEED, generateMap, type MapDef } from './maps'
import { GenControls, MapCard, MapLegend, MapPreview, Modal, mapSize, slotColor, type Slot } from './Menus'
import { NAME_MAX, nameProblem, randomName, tidyName } from './names'
import type { Net, NetView } from './net'
import { CHAT_MAX, type MpLobby, type MpSlot, type SlotPatch } from './protocol'
import type { EmpiresSound } from './sound'
import { useCoarse } from './Touch'

// The multiplayer screens: pick a name, browse the battles being set up (or host one), and the
// lobby itself, where the host picks the map and everyone their spawn, faction and side. All of it
// is drawn from the connection's view (net.ts); every change goes to the server, which sends the
// lobby back to everyone in it.

const BG = { backgroundImage: 'url(/games/empires/world/title.webp)' }

const noMenu = (e: React.MouseEvent) => {
  e.preventDefault()
  e.stopPropagation()
}

export function Multiplayer({ net, sound, onBack }: { net: Net; sound: EmpiresSound; onBack: () => void }) {
  const v = useSyncExternalStore(net.subscribe, net.getView)
  const [toast, setToast] = useState<string | null>(null)
  // Whatever the server turned down shows for a few seconds.
  useEffect(() => {
    if (!v.problem) return
    setToast(v.problem.why)
    sound.error()
    const t = setTimeout(() => setToast(null), 4500)
    return () => clearTimeout(t)
  }, [v.problem, sound])
  const shown = toast && <div className="ew-mp-toast" role="status">{toast}</div>
  if (!v.me)
    return (
      <JoinScreen v={v} net={net} sound={sound} onBack={onBack}>
        {shown}
      </JoinScreen>
    )
  if (!v.lobby)
    return (
      <Browser v={v} net={net} sound={sound} onBack={onBack}>
        {shown}
      </Browser>
    )
  return (
    <Room v={v} lobby={v.lobby} net={net} sound={sound}>
      {shown}
    </Room>
  )
}

// --- Name -------------------------------------------------------------------------------------------

/** A name box with a dice for a random one, and what's wrong with what's typed. */
function NameField({ v, net, sound, initial, onDone }: { v: NetView; net: Net; sound: EmpiresSound; initial: string; onDone?: () => void }) {
  const [name, setName] = useState(initial)
  const [sent, setSent] = useState(false)
  const typed = useRef(!!initial)
  // Until something is typed, the box offers the server's suggestion (or the signed-in login).
  useEffect(() => {
    if (!typed.current && v.suggestion) setName(v.suggestion)
  }, [v.suggestion])
  // A refused claim can be tried again.
  useEffect(() => setSent(false), [v.problem])
  const tidy = tidyName(name)
  const why = nameProblem(tidy)
  const submit = async () => {
    if (why || sent) return sound.error()
    sound.unlock()
    sound.click()
    setSent(true)
    if (!(await net.claim(tidy))) onDone?.()
  }
  return (
    <form
      className="ew-mp-name"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <label className="ew-mp-namefield">
        <span>Your name</span>
        <span className="ew-mp-namerow">
          <input
            value={name}
            maxLength={NAME_MAX + 4}
            autoFocus
            spellCheck={false}
            onChange={(e) => {
              typed.current = true
              setName(e.target.value)
            }}
            aria-invalid={!!why}
          />
          <button
            type="button"
            onClick={() => {
              sound.click()
              typed.current = true
              setName(randomName())
            }}
            data-tip="A random name"
            aria-label="Random name"
          >
            <Icon name="dice" size={16} />
          </button>
        </span>
      </label>
      <small className={why && name ? 'ew-mp-bad' : 'ew-muted'}>{why && name ? why : v.login ? `Signed in as ${v.login}: that name is yours alone.` : 'Anyone online can see it. Names are unique while you play.'}</small>
      <button className="ew-go" type="submit" disabled={!!why || sent || v.status !== 'online'}>
        {onDone ? 'Change name' : 'Play'}
      </button>
    </form>
  )
}

function Status({ v }: { v: NetView }) {
  if (v.status === 'online') return null
  return <p className="ew-mp-status">{v.status === 'connecting' ? 'Connecting to the server…' : "Can't reach the server. Trying again…"}</p>
}

function JoinScreen({ v, net, sound, onBack, children }: { v: NetView; net: Net; sound: EmpiresSound; onBack: () => void; children?: ReactNode }) {
  return (
    <div className="ew-root ew-deck ew-menu" style={BG} onContextMenu={noMenu}>
      <Tips />
      <div className="ew-menu-col">
        <h1 className="ew-logo">
          Empires <span>at</span> War
        </h1>
        <p className="ew-tagline">Battles against other players, live.</p>
        <Frame className="ew-menu-frame" title="Multiplayer">
          <Status v={v} />
          <NameField v={v} net={net} sound={sound} initial="" />
          <button className="ew-menu-btn" onClick={() => (sound.click(), onBack())}>
            <Icon name="back" size={20} /> Back
          </button>
        </Frame>
      </div>
      {children}
    </div>
  )
}

/** Who we are, the ping, and a way to change name, at the right of the header. */
function MeChip({ v, net, sound }: { v: NetView; net: Net; sound: EmpiresSound }) {
  const [renaming, setRenaming] = useState(false)
  const ping = v.status !== 'online' ? 'offline' : v.rtt ? `${Math.round(v.rtt)} ms` : '…'
  // Without hover, say what the number is.
  const coarse = useCoarse()
  return (
    <div className="ew-mp-me">
      <i className={`ew-mp-dot is-${v.status}`} />
      <span className="ew-muted ew-small" data-tip="Round trip to the server">
        {coarse && v.status === 'online' ? `Ping ${ping}` : ping}
      </span>
      <strong>{v.me?.name}</strong>
      <button className="ew-chip" onClick={() => (sound.click(), setRenaming(true))}>
        Change name
      </button>
      {renaming && (
        <Modal title="Change name" onClose={() => setRenaming(false)}>
          <NameField v={v} net={net} sound={sound} initial={v.me?.name ?? ''} onDone={() => setRenaming(false)} />
        </Modal>
      )}
    </div>
  )
}

// --- Battles to join --------------------------------------------------------------------------------

function Browser({ v, net, sound, onBack, children }: { v: NetView; net: Net; sound: EmpiresSound; onBack: () => void; children?: ReactNode }) {
  const open = v.lobbies.filter((l) => l.state === 'open')
  const playing = v.lobbies.filter((l) => l.state !== 'open')
  return (
    <div className="ew-root ew-deck ew-lobby" style={BG} onContextMenu={noMenu}>
      <Tips />
      <header className="ew-lobby-head">
        <button onClick={() => (sound.click(), onBack())}>← Main menu</button>
        <h2>Multiplayer</h2>
        <MeChip v={v} net={net} sound={sound} />
      </header>
      <Status v={v} />
      <div className="ew-lobby-grid ew-mp-grid">
        <Frame title="Battles" aside={<span className="ew-muted ew-small">{open.length} open</span>}>
          {v.lobbies.length === 0 ? (
            <p className="ew-muted ew-mp-empty">No battles yet. Host one, and anyone online can join it.</p>
          ) : (
            <div className="ew-mp-list" role="list">
              {[...open, ...playing].map((l) => {
                const full = l.players >= l.seats
                const can = l.state === 'open' && !full
                return (
                  <div key={l.id} className={`ew-mp-lobbyrow ${can ? '' : 'is-off'}`} role="listitem">
                    <span className="ew-mp-lobbyname">
                      <strong>{l.name}</strong>
                      <small className="ew-muted">{l.map}</small>
                    </span>
                    <span className="ew-mp-count" data-tip="Players, and spawns open to players">
                      <Icon name="army" size={14} /> {l.players}/{l.seats}
                    </span>
                    <button className={can ? 'ew-go ew-mp-join' : 'ew-mp-join'} disabled={!can} onClick={() => (sound.click(), net.send({ t: 'join', id: l.id }))}>
                      {l.state !== 'open' ? 'In battle' : full ? 'Full' : 'Join'}
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </Frame>
        <Frame title="Host a battle">
          <p className="ew-muted">Pick the map and the rules, fill the other spawns with players or AI, and start when everyone is ready.</p>
          <button className="ew-go" disabled={v.status !== 'online'} onClick={() => (sound.unlock(), sound.click(), net.send({ t: 'create' }))}>
            Host a battle
          </button>
          <p className="ew-muted ew-small">
            Every player's game runs the same battle in step with the others, so only orders cross the network: it stays quick even with big fleets. The server keeps the time and checks every order.
          </p>
        </Frame>
      </div>
      {children}
    </div>
  )
}

// --- The lobby --------------------------------------------------------------------------------------

const lobbyMap = (l: MpLobby): MapDef => (l.map === GENERATED ? generateMap(l.gen) : (MAP[l.map] ?? MAPS[0]))

function Room({ v, lobby, net, sound, children }: { v: NetView; lobby: MpLobby; net: Net; sound: EmpiresSound; children?: ReactNode }) {
  const me = v.me!.id
  const host = lobby.host === me
  const mine = lobby.slots.findIndex((s) => s.kind === 'human' && s.player === me)
  const myTeam = lobby.slots[mine]?.team ?? 0
  const [picker, setPicker] = useState(false)
  const map = useMemo(() => lobbyMap(lobby), [lobby.map, lobby.gen])
  const generated = useMemo(() => generateMap(lobby.gen), [lobby.gen])
  // The preview colours spawns as the single-player lobby does: ours, allies, enemies.
  const asSlots = useMemo<Slot[]>(
    () =>
      lobby.slots.map((s, i) => ({
        kind: i === mine ? 'you' : s.kind === 'human' || s.kind === 'ai' ? 'ai' : 'closed',
        faction: s.faction,
        team: s.team === myTeam ? 0 : 1,
        difficulty: s.difficulty,
      })),
    [lobby.slots, mine, myTeam],
  )
  const slot = (i: number, patch: SlotPatch) => {
    sound.click()
    net.send({ t: 'slot', i, patch })
  }
  const setup = (m: { map?: string; gen?: MpLobby['gen']; credits?: number }) => {
    sound.click()
    net.send({ t: 'setup', ...m })
  }
  const filled = lobby.slots.filter((s) => s.kind === 'human' || s.kind === 'ai')
  const sides = [0, 1].map((t) => filled.filter((s) => s.team === t).length)
  const waiting = lobby.slots.filter((s) => s.kind === 'human' && s.player !== lobby.host && !s.ready)
  const away = lobby.slots.filter((s) => s.kind === 'human' && s.away)
  const blocker = !sides[0] || !sides[1] ? 'Both sides need someone on them.' : away.length ? `Waiting for ${away[0].name} to reconnect.` : waiting.length ? `Waiting for ${waiting.map((s) => s.name).join(', ')} to be ready.` : null
  const step = Math.max(0, CREDIT_STEPS.indexOf(lobby.credits))
  const ready = lobby.slots[mine]?.ready ?? false
  return (
    <div className="ew-root ew-deck ew-lobby" style={BG} onContextMenu={noMenu}>
      <Tips />
      <header className="ew-lobby-head">
        <button onClick={() => (sound.click(), net.leave())}>← Leave</button>
        <h2>{lobby.name}</h2>
        <MeChip v={v} net={net} sound={sound} />
      </header>
      <Status v={v} />
      <div className="ew-lobby-grid ew-mp-room">
        <div className="ew-mp-left">
          <Frame title="Players" className="ew-lobby-slots" aside={<span className="ew-muted ew-small">{map.spawns.length} spawns</span>}>
            <div className="ew-slottable" role="table" aria-label="Players">
              <div className="ew-slotrow is-head" role="row">
                <span />
                <span>Player</span>
                <span>Faction</span>
                <span>Side</span>
                <span>Status</span>
              </div>
              {lobby.slots.map((s, i) => (
                <SlotRow key={i} s={s} i={i} color={slotColor(asSlots[i])} me={me} mine={i === mine} host={host} isHost={s.player === lobby.host} myTeam={myTeam} onSlot={slot} onSeat={() => (sound.click(), net.send({ t: 'seat', i }))} />
              ))}
            </div>
            <h5>Starting credits</h5>
            {host ? (
              <label className="ew-range">
                <input type="range" min={0} max={CREDIT_STEPS.length - 1} step={1} value={step} onChange={(e) => setup({ credits: CREDIT_STEPS[Number(e.target.value)] })} aria-label="Starting credits" />
                <b>{lobby.credits.toLocaleString('en-US')}</b>
              </label>
            ) : (
              <p className="ew-mp-value">{lobby.credits.toLocaleString('en-US')}</p>
            )}
            <div className="ew-launch">
              <span className="ew-muted ew-small">{blocker ?? `${sides[0]} against ${sides[1]}. Ready to go.`}</span>
              {host ? (
                <button className="ew-go" disabled={!!blocker} data-tip={blocker ?? 'Start the battle for everyone'} onClick={() => (sound.unlock(), sound.click(), net.send({ t: 'start' }))}>
                  Start battle
                </button>
              ) : (
                <button className={ready ? 'is-on ew-mp-ready' : 'ew-go'} onClick={() => (sound.click(), net.send({ t: 'ready', on: !ready }))}>
                  {ready ? 'Ready ✓' : "I'm ready"}
                </button>
              )}
            </div>
          </Frame>
          <Chat v={v} net={net} />
        </div>
        <Frame
          title={map.name}
          className="ew-lobby-preview"
          aside={
            host && (
              <span className="ew-chips">
                {lobby.map === GENERATED && (
                  <button className="ew-chip" onClick={() => setup({ gen: { ...lobby.gen, seed: Math.floor(Math.random() * (MAX_SEED + 1)) } })} data-tip="A different map with the same rules">
                    <Icon name="dice" size={13} /> New seed
                  </button>
                )}
                <button className="ew-chip" onClick={() => (sound.click(), setPicker(true))}>
                  Change map
                </button>
              </span>
            )
          }
        >
          <MapPreview map={map} slots={asSlots} />
          <MapLegend map={map} />
          <p className="ew-muted">
            {map.blurb}{' '}
            <span className="ew-small">
              {mapSize(map).cls} map ({mapSize(map).dims}) · {map.spawns.length} spawns · {map.beacons.length} beacons · {map.ore.length} ore.
            </span>
          </p>
          {host && lobby.map === GENERATED && <GenControls rules={lobby.gen} onChange={(patch) => setup({ gen: { ...lobby.gen, ...patch } })} onReroll={() => setup({ gen: { ...lobby.gen, seed: Math.floor(Math.random() * (MAX_SEED + 1)) } })} />}
          {!host && lobby.map === GENERATED && <p className="ew-muted ew-small">Generated map, seed {lobby.gen.seed}.</p>}
        </Frame>
      </div>
      {picker && (
        <Modal title="Choose a map" onClose={() => setPicker(false)} wide className="ew-mappicker-modal">
          <div className="ew-mappicker">
            {MAPS.map((m) => (
              <MapCard key={m.id} m={m} title={m.name} blurb={m.blurb} on={lobby.map === m.id} onPick={() => (setPicker(false), setup({ map: m.id }))} />
            ))}
            <MapCard
              m={generated}
              title="Generated"
              blurb={`Built from rules and a seed (now: ${generated.name}, seed ${lobby.gen.seed}). Change them under the map after picking it.`}
              on={lobby.map === GENERATED}
              onPick={() => (setPicker(false), setup({ map: GENERATED }))}
            />
          </div>
        </Modal>
      )}
      {children}
    </div>
  )
}

type SlotChange = SlotPatch

function SlotRow({ s, i, color, me, mine, host, isHost, myTeam, onSlot, onSeat }: {
  s: MpSlot
  i: number
  color: string
  me: string
  mine: boolean
  host: boolean
  isHost: boolean
  myTeam: number
  onSlot: (i: number, patch: SlotChange) => void
  onSeat: () => void
}) {
  const filled = s.kind === 'human' || s.kind === 'ai'
  // Our own seat is ours to set; the host sets the AIs (and may move anyone to the other side).
  const canFaction = mine || (host && s.kind === 'ai')
  const canTeam = mine || (host && filled)
  const side = s.team === myTeam ? (mine ? 'Your team' : 'Ally') : 'Enemy'
  let who: ReactNode
  if (s.kind === 'human' && (mine || !host)) who = (
      <strong className="ew-slotwho ew-mp-who" title={s.player === me ? `${s.name} (you)` : s.name}>
        {s.name}
      </strong>
    )
  else if (host)
    who = (
      <select className="ew-slotwho" value={s.kind} onChange={(e) => onSlot(i, { kind: e.target.value as SlotChange['kind'] })} aria-label={`Spawn ${i + 1}`}>
        {s.kind === 'human' && <option value="human">{s.name}</option>}
        <option value="open">{s.kind === 'human' ? 'Remove (open)' : 'Open'}</option>
        <option value="ai">AI</option>
        <option value="closed">Closed</option>
      </select>
    )
  else if (s.kind === 'open')
    who = (
      <button className="ew-slotwho ew-mp-sit" onClick={onSeat} data-tip="Move to this spawn">
        Sit here
      </button>
    )
  else who = <span className="ew-slotwho ew-muted">{s.kind === 'ai' ? 'AI' : 'Closed'}</span>
  return (
    <div role="row" className={`ew-slotrow ${filled ? '' : 'is-closed'} ${mine ? 'is-active' : ''}`}>
      <span className="ew-spawnno" style={{ background: color }}>
        {i + 1}
      </span>
      {who}
      {!filled ? (
        <span className="ew-muted ew-small ew-slotopen">{s.kind === 'open' ? 'Open for a player to join' : 'Nobody plays here'}</span>
      ) : (
        <>
          <div className="ew-seg ew-factionseg" role="group" aria-label="Faction">
            {(['republic', 'droid'] as FactionId[]).map((f) => (
              <button key={f} className={s.faction === f ? 'is-on' : ''} disabled={!canFaction && s.faction !== f} onClick={() => canFaction && onSlot(i, { faction: f })} data-tip={FACTIONS[f].long} aria-label={FACTIONS[f].name} aria-pressed={s.faction === f}>
                <img src={`/games/empires/world/emblem-${f}.webp`} alt="" />
                <span>{FACTIONS[f].name}</span>
              </button>
            ))}
          </div>
          <button className={`ew-teamtag ${mine ? 'is-own' : s.team === myTeam ? 'is-ally' : 'is-enemy'}`} disabled={!canTeam} onClick={() => onSlot(i, { team: s.team === 0 ? 1 : 0 })} data-tip={canTeam ? 'Click to switch sides' : undefined}>
            {side}
          </button>
          {s.kind === 'ai' ? (
            host ? (
              <select value={s.difficulty} onChange={(e) => onSlot(i, { difficulty: e.target.value as Difficulty })} aria-label="Difficulty" data-tip={DIFFICULTY[s.difficulty].blurb}>
                {(Object.keys(DIFFICULTY) as Difficulty[]).map((d) => (
                  <option key={d} value={d}>
                    {DIFFICULTY[d].name}
                  </option>
                ))}
              </select>
            ) : (
              <span className="ew-mp-state">{DIFFICULTY[s.difficulty].name} AI</span>
            )
          ) : (
            <span className={`ew-mp-state ${s.away ? 'is-away' : isHost || s.ready ? 'is-ready' : ''}`}>{s.away ? 'Away' : isHost ? 'Host' : s.ready ? 'Ready' : 'Not ready'}</span>
          )}
        </>
      )}
    </div>
  )
}

function Chat({ v, net }: { v: NetView; net: Net }) {
  const [text, setText] = useState('')
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = list.current
    if (el) el.scrollTop = el.scrollHeight
  }, [v.chat])
  return (
    <Frame title="Chat" className="ew-mp-chat">
      <div className="ew-mp-lines" ref={list} aria-live="polite">
        {v.chat.length === 0 && <p className="ew-muted ew-small">Say hello. Everyone in this battle sees it.</p>}
        {v.chat.map((c, i) =>
          c.from ? (
            <p key={i}>
              <b>{c.from}</b> {c.text}
            </p>
          ) : (
            <p key={i} className="ew-mp-notice">
              {c.text}
            </p>
          ),
        )}
      </div>
      <form
        className="ew-mp-say"
        onSubmit={(e) => {
          e.preventDefault()
          const t = text.trim()
          if (!t) return
          net.send({ t: 'chat', text: t })
          setText('')
        }}
      >
        <input value={text} maxLength={CHAT_MAX} onChange={(e) => setText(e.target.value)} placeholder="Message" aria-label="Chat message" />
        <button type="submit" disabled={!text.trim()}>
          Send
        </button>
      </form>
    </Frame>
  )
}
