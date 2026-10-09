import { useState, type CSSProperties } from 'react'
import { perk, PERK_LEVELS, type PerkId } from './data'
import { useOverlay } from './ui'

// Perks as cards from a card game: the doctore deals three when you level, you keep one, and the
// ones you kept make up your deck on the gladiator's sheet.

type Suit = 'blade' | 'shield' | 'crowd' | 'arcane'

const SUITS: Record<Suit, { name: string; glyph: string }> = {
  blade: { name: 'Blade', glyph: '⚔️' },
  shield: { name: 'Shield', glyph: '🛡️' },
  crowd: { name: 'Crowd', glyph: '👑' },
  arcane: { name: 'Arcane', glyph: '✨' },
}

const CARD: Record<PerkId, { suit: Suit; glyph: string }> = {
  riposte: { suit: 'blade', glyph: '↩️' },
  cleave: { suit: 'blade', glyph: '🪓' },
  bloodlust: { suit: 'blade', glyph: '🩸' },
  executioner: { suit: 'blade', glyph: '💀' },
  ironSkin: { suit: 'shield', glyph: '🛡️' },
  thickSkull: { suit: 'shield', glyph: '🪖' },
  secondWind: { suit: 'shield', glyph: '💨' },
  fleetFoot: { suit: 'shield', glyph: '👟' },
  showman: { suit: 'crowd', glyph: '🎭' },
  goldTongue: { suit: 'crowd', glyph: '🪙' },
  arcane: { suit: 'arcane', glyph: '🔮' },
}

export const perkGlyph = (id: PerkId) => CARD[id].glyph

function CardArt({ id }: { id: PerkId }) {
  const [missing, setMissing] = useState(false)
  return (
    <div className="gl-tcard-art">
      {missing ? <i>{CARD[id].glyph}</i> : <img src={`/games/gladiator/cards/${id}.webp`} alt="" draggable={false} onError={() => setMissing(true)} />}
    </div>
  )
}

/** The face of a perk card. `level` is when it was earned, shown on cards in the deck. */
export function PerkCard({ id, level, className = '', style }: { id: PerkId; level?: number; className?: string; style?: CSSProperties }) {
  const p = perk(id)
  const { suit } = CARD[id]
  return (
    <div className={`gl-tcard is-${suit} ${className}`} style={style}>
      <div className="gl-tcard-face">
        <div className="gl-tcard-name">{p.name}</div>
        <CardArt id={id} />
        <span className="gl-tcard-gem" title={SUITS[suit].name}>
          {SUITS[suit].glyph}
        </span>
        <div className="gl-tcard-text">{p.text}</div>
        <div className="gl-tcard-foot">
          <span>{SUITS[suit].name}</span>
          {level !== undefined && <span>Level {level}</span>}
        </div>
      </div>
    </div>
  )
}

/** A face-down card: a perk still to come, or one being dealt. */
export function CardBack({ label, className = '' }: { label?: string; className?: string }) {
  return (
    <div className={`gl-tcard is-back ${className}`}>
      <div className="gl-tcard-back">
        <span className="gl-tcard-seal">⚔️</span>
        {label && <em>{label}</em>}
      </div>
    </div>
  )
}

/** The gladiator's perks as a deck: cards kept so far, then face-down ones for the levels to come. */
export function PerkDeck({ perks, onOpen }: { perks: PerkId[]; onOpen: (id: PerkId, level: number) => void }) {
  return (
    <div className="gl-deck">
      {perks.map((id, i) => (
        <button key={id} className="gl-deck-slot" onClick={() => onOpen(id, PERK_LEVELS[i])} title={`${perk(id).name}: ${perk(id).text}`}>
          <PerkCard id={id} level={PERK_LEVELS[i]} />
        </button>
      ))}
      {PERK_LEVELS.slice(perks.length).map((l) => (
        <div key={l} className="gl-deck-slot is-locked">
          <CardBack label={`Level ${l}`} />
        </div>
      ))}
    </div>
  )
}

/** One card, large, over the screen. */
export function CardView({ id, level, onClose }: { id: PerkId; level: number; onClose: () => void }) {
  const ref = useOverlay<HTMLDivElement>()
  return (
    <div ref={ref} className="gl-modal gl-card-table" onPointerDown={onClose}>
      <PerkCard id={id} level={level} className="is-big is-shown" />
      <p className="gl-card-hint">Tap anywhere to put it back</p>
    </div>
  )
}

/**
 * Level-up draft: three cards dealt face down that turn over one after another. Picking one lifts
 * it and sweeps the others away before `onPick` adds it to the deck.
 */
export function PerkDraft({ choices, level, onPick }: { choices: PerkId[]; level: number; onPick: (id: PerkId) => void }) {
  const [picked, setPicked] = useState<PerkId | null>(null)
  const ref = useOverlay<HTMLDivElement>()
  const pick = (id: PerkId) => {
    if (picked) return
    setPicked(id)
    setTimeout(() => onPick(id), 750)
  }
  return (
    <div ref={ref} className="gl-modal gl-card-table">
      <h2>The doctore deals you a hand</h2>
      <p className="gl-card-hint">Level {level}: keep one card. It joins your deck for good.</p>
      <div className="gl-draft">
        {choices.map((id, i) => (
          <button key={id} className={`gl-draft-slot ${picked === id ? 'is-picked' : picked ? 'is-gone' : ''}`} style={{ '--i': i } as CSSProperties} onClick={() => pick(id)} disabled={!!picked}>
            <div className="gl-flip">
              <CardBack className="gl-flip-back" />
              <PerkCard id={id} className="gl-flip-front" />
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
