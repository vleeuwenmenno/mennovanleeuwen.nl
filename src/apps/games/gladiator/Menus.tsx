import { useRef, useState } from 'react'
import { signIn, useAccount } from '../../../os/account'
import { pullAll, useSyncStatus } from '../../../os/synced'
import type { Save, HallEntry, Mode } from './career'
import { randomLook, randomName, type Gladiator, newGladiator } from './character'
import { BASE_STAT, BEARDS, CREATION_POINTS, DIFFICULTIES, DIFFICULTY_IDS, emptyStats, HAIR_COLOURS, HAIR_STYLES, SKIN_TONES, STATS, TUNIC_COLOURS, type Difficulty, type Look, type StatKey, type Stats } from './data'
import { applyImport, exportSaves, parseImport, type GladiatorStore } from './saves'
import { Modal, Portrait } from './ui'

// The title screen with its save slots, the character creator and the Hall of Fame.

/** Where the saves live: this browser only, or your account, with the last sync and a nudge. */
function SyncPanel() {
  const account = useAccount()
  const sync = useSyncStatus()
  if (account.status === 'loading') return null
  if (account.status !== 'user')
    return (
      <div className="gl-sync">
        <span className="gl-sync-dot is-local" />
        <span>Saves stay in this browser.</span>
        {account.status === 'anon' && (
          <button className="gl-btn is-small" onClick={signIn}>
            Sign in with GitHub to play anywhere
          </button>
        )}
      </div>
    )
  const when = sync.at ? new Date(sync.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null
  const text = sync.state === 'syncing' ? 'Syncing…' : sync.state === 'error' ? `Sync failed: ${sync.error ?? 'unknown error'}` : when ? `Synced at ${when}` : 'Synced'
  return (
    <div className="gl-sync">
      {account.user?.avatar ? <img className="gl-sync-avatar" src={account.user.avatar} alt="" /> : <span className={`gl-sync-dot is-${sync.state}`} />}
      <span>
        Saves and high scores sync to <b>{account.user?.login}</b>. <span className={`gl-sync-state is-${sync.state}`}>{text}</span>
      </span>
      <button className="gl-btn is-small" disabled={sync.state === 'syncing'} onClick={() => void pullAll()}>
        Sync now
      </button>
    </div>
  )
}

export function TitleScreen({ slots, hall, onLoad, onNew, onDelete, onHall, onImported }: { slots: (Save | null)[]; hall: HallEntry[]; onLoad: (i: number) => void; onNew: (i: number) => void; onDelete: (i: number) => void; onHall: () => void; onImported: () => void }) {
  const [confirm, setConfirm] = useState<number | null>(null)
  const [incoming, setIncoming] = useState<GladiatorStore | null>(null)
  const [error, setError] = useState<string | null>(null)
  const file = useRef<HTMLInputElement>(null)
  const pick = async (f: File | undefined) => {
    if (!f) return
    try {
      setIncoming(parseImport(await f.text()))
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
    if (file.current) file.current.value = ''
  }
  const finish = (how: 'merge' | 'replace') => {
    if (!incoming) return
    applyImport(incoming, how)
    setIncoming(null)
    onImported()
  }
  const any = slots.some(Boolean) || hall.length > 0
  return (
    <div className="gl-title">
      <h1 className="gl-logo">
        <span>Gladiator</span>
        <small>Swords · Sandals · Glory</small>
      </h1>
      <SyncPanel />
      <div className="gl-slot-cards">
        {slots.map((s, i) =>
          s ? (
            <div key={i} className={`gl-card gl-slot-card ${s.dead ? 'is-dead' : ''}`}>
              <span className="gl-card-ribbon">
                {DIFFICULTIES[s.difficulty ?? 'normal'].name}
                {s.mode === 'hardcore' ? ' · Hardcore' : ''}
              </span>
              <div className="gl-card-art">
                <Portrait look={s.g.look} gear={s.g.gear} still={!!s.dead} />
              </div>
              <div className="gl-card-body">
                <strong>{s.g.name}</strong>
                <span className="gl-muted">{s.dead ? 'Fell in the arena' : s.g.title ?? 'Gladiator'}</span>
                <div className="gl-chips">
                  <span className="gl-chip">Level {s.g.level}</span>
                  <span className="gl-chip">
                    {s.record.wins}–{s.record.losses}
                  </span>
                  <span className="gl-chip">★ {s.fame}</span>
                </div>
              </div>
              <div className="gl-card-foot">
                {confirm === i ? (
                  <>
                    <button className="gl-btn is-danger" onClick={() => (onDelete(i), setConfirm(null))}>
                      Delete for good
                    </button>
                    <button className="gl-btn is-quiet" onClick={() => setConfirm(null)}>
                      Keep
                    </button>
                  </>
                ) : (
                  <>
                    <button className="gl-btn is-quiet gl-slot-delete" onClick={() => setConfirm(i)} title="Delete this gladiator" aria-label={`Delete ${s.g.name}`}>
                      🗑
                    </button>
                    {!s.dead && (
                      <button className="gl-btn is-primary" onClick={() => onLoad(i)}>
                        Continue
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          ) : (
            <button key={i} className="gl-card gl-slot-empty" onClick={() => onNew(i)}>
              <span className="gl-slot-plus">+</span>
              <strong>New gladiator</strong>
              <span className="gl-muted">Slot {i + 1} is free</span>
            </button>
          ),
        )}
      </div>
      <div className="gl-title-actions">
        <button className="gl-btn" onClick={onHall} disabled={!hall.length}>
          🏛 Hall of Fame{hall.length ? ` (${hall.length})` : ''}
        </button>
        <button className="gl-btn" onClick={exportSaves} disabled={!any} title="Download every gladiator and the Hall of Fame as a file">
          ⬇ Export saves
        </button>
        <button className="gl-btn" onClick={() => file.current?.click()} title="Load gladiators from an exported file">
          ⬆ Import saves
        </button>
        <input ref={file} type="file" accept="application/json,.json" hidden onChange={(e) => void pick(e.target.files?.[0])} />
      </div>
      {error && (
        <Modal onClose={() => setError(null)}>
          <h2>Can’t import that</h2>
          <p>{error}</p>
          <div className="gl-modal-btns">
            <button className="gl-btn is-primary" onClick={() => setError(null)}>
              OK
            </button>
          </div>
        </Modal>
      )}
      {incoming && (
        <Modal onClose={() => setIncoming(null)}>
          <h2>Import saves</h2>
          <p>
            This file holds{' '}
            {incoming.slots.filter(Boolean).length
              ? incoming.slots
                  .filter((x): x is Save => !!x)
                  .map((x) => `${x.g.name} (level ${x.g.level})`)
                  .join(', ')
              : 'no saved runs'}
            {incoming.hall.length ? ` and ${incoming.hall.length} Hall of Fame ${incoming.hall.length === 1 ? 'entry' : 'entries'}` : ''}.
          </p>
          <p className="gl-muted">Merge keeps the most recently played run in each slot and everyone in the Hall of Fame. Replace makes your saves exactly the file.</p>
          <div className="gl-modal-btns">
            <button className="gl-btn is-quiet" onClick={() => setIncoming(null)}>
              Cancel
            </button>
            <button className="gl-btn is-danger" onClick={() => finish('replace')}>
              Replace all
            </button>
            <button className="gl-btn is-primary" onClick={() => finish('merge')}>
              Merge
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}

export function HallScreen({ hall, onBack }: { hall: HallEntry[]; onBack: () => void }) {
  return (
    <div className="gl-page">
      <div className="gl-page-head">
        <button className="gl-btn is-quiet" onClick={onBack}>
          ← Back
        </button>
        <h2>Hall of Fame</h2>
      </div>
      <div className="gl-hall">
        {hall.map((h, i) => (
          <div key={i} className={`gl-panel gl-hall-row is-${h.fate}`}>
            <Portrait look={h.look} gear={h.gear} zoom={2.2} still className="gl-slot-face" />
            <div>
              <strong>{h.name}</strong>
              <span>
                Level {h.level} · {h.wins} wins, {h.losses} losses · {h.fame} fame{h.difficulty ? ` · ${DIFFICULTIES[h.difficulty].name}` : ''}{h.mode === 'hardcore' ? ' · Hardcore' : ''}
              </span>
              <span className="gl-muted">
                {h.fate === 'emperor' ? 'Crowned Champion of Rome' : h.fate === 'fell' ? `Fell in the arena${h.by ? ` to ${h.by}` : ''}` : 'Retired'} · {new Date(h.date).toLocaleDateString()}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

const PRESETS: { name: string; text: string; w: Partial<Stats> }[] = [
  { name: 'Brute', text: 'Hits like a cart', w: { str: 2, vit: 1, end: 1 } },
  { name: 'Duelist', text: 'Fast and precise', w: { atk: 2, agi: 2 } },
  { name: 'Tank', text: 'A wall with legs', w: { def: 2, vit: 2 } },
  { name: 'Showman', text: 'The crowd’s darling', w: { cha: 2, agi: 1, atk: 1 } },
  { name: 'Battlemage', text: 'Steel and fire', w: { mag: 3, vit: 1 } },
]

function Swatches({ list, value, onPick, label }: { list: string[]; value: string; onPick: (c: string) => void; label: string }) {
  return (
    <div className="gl-swatches" role="radiogroup" aria-label={label}>
      {list.map((c) => (
        <button key={c} role="radio" aria-checked={value === c} className={value === c ? 'is-active' : ''} style={{ background: c }} onClick={() => onPick(c)} aria-label={c} />
      ))}
    </div>
  )
}

function Choice<T extends string>({ list, value, onPick, label }: { list: readonly T[]; value: T; onPick: (v: T) => void; label: string }) {
  return (
    <div className="gl-seg" role="radiogroup" aria-label={label}>
      {list.map((v) => (
        <button key={v} role="radio" aria-checked={value === v} className={value === v ? 'is-active' : ''} onClick={() => onPick(v)}>
          {v[0].toUpperCase() + v.slice(1)}
        </button>
      ))}
    </div>
  )
}

export function DifficultyPicker({ value, onPick }: { value: Difficulty; onPick: (d: Difficulty) => void }) {
  return (
    <div className="gl-difficulty">
      <div className="gl-seg" role="radiogroup" aria-label="Difficulty">
        {DIFFICULTY_IDS.map((d) => (
          <button key={d} role="radio" aria-checked={value === d} className={value === d ? 'is-active' : ''} onClick={() => onPick(d)}>
            {DIFFICULTIES[d].name}
          </button>
        ))}
      </div>
      <span className="gl-muted">
        {DIFFICULTIES[value].text}
        {DIFFICULTIES[value].reward !== 1 ? ` Rewards ×${DIFFICULTIES[value].reward}, shop prices ×${DIFFICULTIES[value].prices}.` : ''}
      </span>
    </div>
  )
}

export function CreatorScreen({ onDone, onBack }: { onDone: (g: Gladiator, mode: Mode, difficulty: Difficulty) => void; onBack: () => void }) {
  const [name, setName] = useState(() => randomName())
  const [look, setLook] = useState<Look>(() => randomLook())
  const [stats, setStats] = useState<Stats>(() => emptyStats(BASE_STAT))
  const [mode, setMode] = useState<Mode>('normal')
  const [difficulty, setDifficulty] = useState<Difficulty>('normal')
  const spent = Object.values(stats).reduce((a, b) => a + b, 0) - STATS.length * BASE_STAT
  const left = CREATION_POINTS - spent
  const set = (k: StatKey, d: number) => {
    if ((d > 0 && left <= 0) || (d < 0 && stats[k] <= BASE_STAT)) return
    setStats({ ...stats, [k]: stats[k] + d })
  }
  const preset = (w: Partial<Stats>) => {
    const s = emptyStats(BASE_STAT)
    for (const k of Object.keys(w) as StatKey[]) s[k] += w[k]!
    setStats(s)
  }
  const patch = (p: Partial<Look>) => setLook({ ...look, ...p })

  return (
    <div className="gl-page gl-creator">
      <div className="gl-page-head">
        <button className="gl-btn is-quiet" onClick={onBack}>
          ← Back
        </button>
        <h2>A new gladiator</h2>
      </div>
      <div className="gl-creator-grid">
        <div className="gl-panel gl-creator-look">
          <Portrait look={look} gear={{ weapon: 'weapon-gladius-0', feet: 'feet-0' }} />
          <label className="gl-field">
            <span>Name</span>
            <div className="gl-name">
              <input value={name} maxLength={24} onChange={(e) => setName(e.target.value)} />
              <button className="gl-btn is-quiet" onClick={() => setName(randomName())} title="Random name">
                🎲
              </button>
            </div>
          </label>
          <div className="gl-field">
            <span>Skin</span>
            <Swatches list={SKIN_TONES} value={look.skin} onPick={(skin) => patch({ skin })} label="Skin" />
          </div>
          <div className="gl-field">
            <span>Hair</span>
            <Choice list={HAIR_STYLES} value={look.hair} onPick={(hair) => patch({ hair })} label="Hair style" />
            <Swatches list={HAIR_COLOURS} value={look.hairColour} onPick={(hairColour) => patch({ hairColour })} label="Hair colour" />
          </div>
          <div className="gl-field">
            <span>Beard</span>
            <Choice list={BEARDS} value={look.beard} onPick={(beard) => patch({ beard })} label="Beard" />
          </div>
          <div className="gl-field">
            <span>Tunic</span>
            <Swatches list={TUNIC_COLOURS} value={look.tunic} onPick={(tunic) => patch({ tunic })} label="Tunic colour" />
          </div>
          <label className="gl-field">
            <span>Build</span>
            <input type="range" min={0} max={1} step={0.05} value={look.build} onChange={(e) => patch({ build: Number(e.target.value) })} />
          </label>
          <button className="gl-btn is-quiet" onClick={() => setLook(randomLook())}>
            🎲 Random look
          </button>
        </div>

        <div className="gl-panel gl-creator-stats">
          <h3>
            Training <span className={`gl-points ${left ? 'is-left' : ''}`}>{left} points left</span>
          </h3>
          <div className="gl-presets">
            {PRESETS.map((p) => (
              <button key={p.name} className="gl-btn is-small" onClick={() => preset(p.w)} title={p.text}>
                {p.name}
              </button>
            ))}
          </div>
          {STATS.map((s) => (
            <div key={s.key} className="gl-stat">
              <div>
                <strong>{s.name}</strong>
                <span className="gl-muted">{s.text}</span>
              </div>
              <div className="gl-stepper">
                <button onClick={() => set(s.key, -1)} disabled={stats[s.key] <= BASE_STAT} aria-label={`Less ${s.name}`}>
                  −
                </button>
                <b>{stats[s.key]}</b>
                <button onClick={() => set(s.key, 1)} disabled={left <= 0} aria-label={`More ${s.name}`}>
                  +
                </button>
              </div>
            </div>
          ))}
          <h3>Difficulty</h3>
          <DifficultyPicker value={difficulty} onPick={setDifficulty} />
          <h3>Fate</h3>
          <div className="gl-modes">
            <button className={`gl-mode ${mode === 'normal' ? 'is-active' : ''}`} onClick={() => setMode('normal')}>
              <strong>Normal</strong>
              <span>Lose a fight and the doctor patches you up. You lose some gold and fame.</span>
            </button>
            <button className={`gl-mode is-hard ${mode === 'hardcore' ? 'is-active' : ''}`} onClick={() => setMode('hardcore')}>
              <strong>Hardcore</strong>
              <span>Fall, and the crowd decides with its thumbs. Thumbs down ends the run for good.</span>
            </button>
          </div>
          <button className="gl-btn is-primary is-big" onClick={() => onDone({ ...newGladiator(name, look, stats), points: left }, mode, difficulty)}>
            Enter the ludus
          </button>
        </div>
      </div>
    </div>
  )
}
