import { useState } from 'react'
import type { Save, HallEntry, Mode } from './career'
import { randomLook, randomName, type Gladiator, newGladiator } from './character'
import { BASE_STAT, BEARDS, CREATION_POINTS, DIFFICULTIES, DIFFICULTY_IDS, emptyStats, HAIR_COLOURS, HAIR_STYLES, SKIN_TONES, STATS, TUNIC_COLOURS, type Difficulty, type Look, type StatKey, type Stats } from './data'
import { Portrait } from './ui'

// The title screen with its save slots, the character creator and the Hall of Fame.

export function TitleScreen({ slots, hall, onLoad, onNew, onDelete, onHall }: { slots: (Save | null)[]; hall: HallEntry[]; onLoad: (i: number) => void; onNew: (i: number) => void; onDelete: (i: number) => void; onHall: () => void }) {
  const [confirm, setConfirm] = useState<number | null>(null)
  return (
    <div className="gl-title">
      <h1 className="gl-logo">
        <span>Gladiator</span>
        <small>Swords · Sandals · Glory</small>
      </h1>
      <div className="gl-slots">
        {slots.map((s, i) => (
          <div key={i} className={`gl-panel gl-slot ${s?.dead ? 'is-dead' : ''}`}>
            {s ? (
              <>
                <Portrait look={s.g.look} gear={s.g.gear} zoom={2.2} still className="gl-slot-face" />
                <div className="gl-slot-info">
                  <strong>{s.g.name}</strong>
                  <span>
                    Level {s.g.level} · {s.record.wins}–{s.record.losses}
                    {s.mode === 'hardcore' ? ' · Hardcore' : ''}
                  </span>
                  <span className="gl-muted">{s.dead ? 'Fell in the arena' : s.g.title ?? 'Gladiator'}</span>
                </div>
                <div className="gl-slot-btns">
                  {!s.dead && (
                    <button className="gl-btn is-primary" onClick={() => onLoad(i)}>
                      Continue
                    </button>
                  )}
                  {confirm === i ? (
                    <button className="gl-btn is-danger" onClick={() => (onDelete(i), setConfirm(null))}>
                      Really delete?
                    </button>
                  ) : (
                    <button className="gl-btn is-quiet" onClick={() => setConfirm(i)}>
                      Delete
                    </button>
                  )}
                </div>
              </>
            ) : (
              <button className="gl-slot-new" onClick={() => onNew(i)}>
                <strong>+ New gladiator</strong>
                <span className="gl-muted">Empty slot {i + 1}</span>
              </button>
            )}
          </div>
        ))}
      </div>
      <button className="gl-btn" onClick={onHall} disabled={!hall.length}>
        Hall of Fame{hall.length ? ` (${hall.length})` : ''}
      </button>
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
  { name: 'Brute', text: 'Hits like a cart', w: { str: 4, vit: 2, end: 2, atk: 1 } },
  { name: 'Duelist', text: 'Fast and precise', w: { atk: 3, agi: 3, str: 2, vit: 1 } },
  { name: 'Tank', text: 'A wall with legs', w: { def: 4, vit: 3, str: 1, end: 1 } },
  { name: 'Showman', text: 'The crowd’s darling', w: { cha: 4, agi: 2, atk: 2, vit: 1 } },
  { name: 'Battlemage', text: 'Steel and fire', w: { mag: 5, vit: 2, atk: 1, agi: 1 } },
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
        {DIFFICULTIES[value].reward !== 1 ? ` Rewards ×${DIFFICULTIES[value].reward}.` : ''}
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
