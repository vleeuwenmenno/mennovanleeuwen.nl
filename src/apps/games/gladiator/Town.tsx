import { useState, type ReactNode } from 'react'
import { entrantName, foeGladiator, respecPrice, rivalLevel, rules, trainPrice, tournamentFoe, unlocked, type Foe, type Save } from './career'
import { DifficultyPicker } from './Menus'
import { canWear, derive, equip, gearStats, rng, xpFor, type Gladiator } from './character'
import {
  ARMOUR_SLOTS, BASE_STAT, ITEMS, item, league, LEAGUES, MATERIALS, MAX_POTIONS, PERKS, potionPrice, POTIONS, SLOT_NAMES, SPELLS, STATS, WEAPON_TYPES,
  type Item, type LeagueId, type PerkId, type Slot, type StatKey,
} from './data'
import { Bar, Gold, Modal, Portrait } from './ui'

// The town between fights: the hub, the arena's notice board, the shops, the trainer, your
// gladiator's sheet and the tournament bracket.

type Update = (fn: (s: Save) => Save) => void
export type Place = 'hub' | 'arena' | 'forge' | 'armoury' | 'mage' | 'apothecary' | 'training' | 'gladiator' | 'tournament'

export const PLACE_BG: Record<Place, string> = {
  hub: 'town',
  arena: 'arena-pits',
  forge: 'forge',
  armoury: 'armoury',
  mage: 'mage',
  apothecary: 'apothecary',
  training: 'training',
  gladiator: 'training',
  tournament: 'arena-city',
}

const cap = (s: string) => s[0].toUpperCase() + s.slice(1)

export function TopBar({ save, onMenu }: { save: Save; onMenu: () => void }) {
  const g = save.g
  return (
    <div className="gl-topbar">
      <button className="gl-btn is-quiet is-small" onClick={onMenu} title="Save and return to the title screen">
        ☰
      </button>
      <div className="gl-top-name">
        <strong>{g.name}</strong>
        <span>
          {g.title ?? 'Gladiator'} · {rules(save).name}
          {save.mode === 'hardcore' ? ' · Hardcore' : ''}
        </span>
      </div>
      <div className="gl-top-level" title={`${g.xp} / ${xpFor(g.level)} XP`}>
        <span>Lv {g.level}</span>
        <Bar kind="xp" value={g.xp} max={xpFor(g.level)} />
      </div>
      <Gold n={save.gold} />
      <span className="gl-fame" title="Fame">
        ★ {save.fame}
      </span>
      <span className="gl-record" title="Wins and losses">
        {save.record.wins}–{save.record.losses}
      </span>
    </div>
  )
}

const PLACES: { id: Place; name: string; text: string; glyph: string }[] = [
  { id: 'arena', name: 'The Arena', text: 'Fights, tournaments, champions', glyph: '⚔️' },
  { id: 'forge', name: 'Forge', text: 'Weapons from wood to legend', glyph: '🔨' },
  { id: 'armoury', name: 'Armoury', text: 'Helmets, plate, shields, capes', glyph: '🛡️' },
  { id: 'mage', name: 'Mage Tower', text: 'Spells for coin', glyph: '✨' },
  { id: 'apothecary', name: 'Apothecary', text: 'Potions for the fight', glyph: '⚗️' },
  { id: 'training', name: 'Training Yard', text: 'Buy extra training', glyph: '🎯' },
  { id: 'gladiator', name: 'Your Gladiator', text: 'Stats, perks, rivals', glyph: '🏛️' },
]

export function Hub({ save, go }: { save: Save; go: (p: Place) => void }) {
  const badge = save.g.points + save.pendingPerks
  return (
    <div className="gl-hub">
      <div className="gl-hub-hero">
        <Portrait look={save.g.look} gear={save.g.gear} clip={save.record.wins ? 'victory' : 'guard'} zoom={0.8} />
      </div>
      <div className="gl-hub-places">
        {save.tournament && !save.tournament.out && tournamentFoe(save.tournament) && (
          <button className="gl-place is-hot" onClick={() => go('tournament')}>
            <i>🏆</i>
            <strong>Tournament in progress</strong>
            <span>{league(save.tournament.league).name}: your next bout awaits</span>
          </button>
        )}
        {PLACES.map((p) => (
          <button key={p.id} className="gl-place" onClick={() => go(p.id)}>
            <i>{p.glyph}</i>
            <strong>{p.name}</strong>
            <span>{p.text}</span>
            {p.id === 'gladiator' && badge > 0 && <b className="gl-badge">{badge}</b>}
          </button>
        ))}
      </div>
    </div>
  )
}

function PageHead({ title, onBack, children }: { title: string; onBack: () => void; children?: ReactNode }) {
  return (
    <div className="gl-page-head">
      <button className="gl-btn is-quiet" onClick={onBack}>
        ← Town
      </button>
      <h2>{title}</h2>
      {children}
    </div>
  )
}

// --- Arena ---------------------------------------------------------------------------------------

const ARCH_TEXT: Record<string, string> = { brute: 'Brute', duelist: 'Duelist', tank: 'Shieldwall', showman: 'Showman', mage: 'Battlemage', spearman: 'Spearman' }

export function ArenaBoard({ save, onBack, onFight, onTournament, onLeague, onReroll }: { save: Save; onReroll: () => void; onBack: () => void; onFight: (foe: Foe, kind: 'exhibition' | 'rival' | 'champion') => void; onTournament: (l: LeagueId) => void; onLeague: (l: LeagueId) => void }) {
  const L = league(save.league)
  const champ = L.champion
  const champBeaten = save.beaten.includes(L.id)
  const canChamp = save.tourneyWins[L.id] > 0
  const champG = foeGladiator(save, { seed: champ.seed, level: champ.level, archetype: champ.archetype, champion: L.id })
  return (
    <div className="gl-page">
      <PageHead title="The Arena" onBack={onBack}>
        <div className="gl-seg gl-leagues">
          {LEAGUES.map((l) => (
            <button key={l.id} className={save.league === l.id ? 'is-active' : ''} disabled={!unlocked(save, l.id)} onClick={() => onLeague(l.id)} title={unlocked(save, l.id) ? l.blurb : 'Beat the champion of the league before'}>
              {unlocked(save, l.id) ? '' : '🔒 '}
              {l.name}
            </button>
          ))}
        </div>
      </PageHead>
      <p className="gl-blurb">
        {L.blurb} Opponents level {L.levels[0]}–{L.levels[1]}.
      </p>
      <div className="gl-board">
        <div className="gl-board-col">
          <h3>Bouts on offer</h3>
          {save.offers.map((o) => {
            const g = foeGladiator(save, o)
            const d = derive(g)
            const diff = o.level - save.g.level
            return (
              <div key={`${o.seed}-${o.level}`} className={`gl-panel gl-offer ${o.rival ? 'is-rival' : ''}`}>
                <Portrait look={g.look} gear={g.gear} zoom={1.9} face={-1} still className="gl-offer-face" />
                <div className="gl-offer-info">
                  <span className="gl-offer-label">{o.label}</span>
                  <strong>{g.name}</strong>
                  <span>
                    Lv {g.level} {ARCH_TEXT[g.archetype ?? 'duelist']} · {d.weaponItem?.name ?? 'Fists'} · {d.maxHp} HP
                  </span>
                  <span className={`gl-diff ${diff > 1 ? 'is-hard' : diff < 0 ? 'is-easy' : ''}`}>{diff > 1 ? 'Dangerous' : diff < 0 ? 'Easy money' : 'Fair fight'}</span>
                </div>
                <div className="gl-offer-go">
                  <Gold n={o.purse} />
                  <button className="gl-btn is-primary" onClick={() => onFight(o, o.rival ? 'rival' : 'exhibition')}>
                    Fight
                  </button>
                </div>
              </div>
            )
          })}
          <button className="gl-btn is-quiet" disabled={save.gold < 5} onClick={onReroll} title="Bribe the lanista for different opponents">
            New opponents (<Gold n={5} />)
          </button>
        </div>
        <div className="gl-board-col">
          <h3>Tournament</h3>
          <div className="gl-panel gl-tourney">
            <p>Eight gladiators, three rounds, no rest. The surgeon patches you up a little between bouts.</p>
            <p>
              Entry <Gold n={L.entry} /> · Prize <Gold n={L.prize} /> and fame. Won {save.tourneyWins[L.id]} so far.
            </p>
            {save.tournament && !save.tournament.out && tournamentFoe(save.tournament) ? (
              <button className="gl-btn is-primary" onClick={() => onTournament(save.tournament!.league)}>
                Back to your bracket
              </button>
            ) : (
              <button className="gl-btn is-primary" disabled={save.gold < L.entry || save.g.level < L.levels[0]} onClick={() => onTournament(L.id)}>
                {save.g.level < L.levels[0] ? `Needs level ${L.levels[0]}` : save.gold < L.entry ? 'Not enough gold' : 'Enter'}
              </button>
            )}
          </div>
          <h3>Champion</h3>
          <div className={`gl-panel gl-offer is-champion ${champBeaten ? 'is-beaten' : ''}`}>
            <Portrait look={champG.look} gear={champG.gear} zoom={1.9} face={-1} still className="gl-offer-face" />
            <div className="gl-offer-info">
              <span className="gl-offer-label">{champBeaten ? 'Defeated' : 'Champion'}</span>
              <strong>
                {champ.name} {champ.title}
              </strong>
              <span>
                Lv {champG.level} {ARCH_TEXT[champ.archetype]}
              </span>
              <span className="gl-muted">{canChamp ? 'Accepts your challenge.' : 'Win a tournament here to earn a challenge.'}</span>
            </div>
            <div className="gl-offer-go">
              <Gold n={L.prize} />
              <button className="gl-btn is-primary" disabled={!canChamp} onClick={() => onFight({ seed: champ.seed, level: champ.level, archetype: champ.archetype, champion: L.id }, 'champion')}>
                {champBeaten ? 'Rematch' : 'Challenge'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// --- Shops ---------------------------------------------------------------------------------------

function itemStats(it: Item) {
  const out: string[] = []
  if (it.dmg) out.push(`${it.dmg[0]}–${it.dmg[1]} dmg`)
  if (it.weapon) {
    const w = WEAPON_TYPES.find((x) => x.kind === it.weapon)!
    out.push(`reach ${w.reach}`)
    if (w.twoHanded) out.push('two-handed')
  }
  if (it.armour) out.push(`${it.armour} armour`)
  if (it.block) out.push(`${Math.round(it.block * 100)}% block`)
  for (const [k, v] of Object.entries(it.bonus)) if (v) out.push(`+${v} ${STATS.find((s) => s.key === k)!.name.toLowerCase()}`)
  if (it.weight) out.push(`weight ${it.weight}`)
  return out.join(' · ')
}

export function GearShop({ save, update, kind, onBack, sound }: { save: Save; update: Update; kind: 'forge' | 'armoury'; onBack: () => void; sound: { coins: () => void; ui: () => void } }) {
  const tabs: string[] = kind === 'forge' ? WEAPON_TYPES.map((w) => w.kind) : ARMOUR_SLOTS
  const [tab, setTab] = useState(tabs[0])
  const [sel, setSel] = useState<Item | null>(null)
  const g = save.g
  const list = ITEMS.filter((i) => (kind === 'forge' ? i.weapon === tab : i.slot === tab && !i.weapon))
  const tryOn: Partial<Record<Slot, string | Item | null>> = { ...g.gear }
  if (sel) {
    const preview = equip(g, sel)
    Object.assign(tryOn, Object.fromEntries(Object.entries(preview.gear)))
    for (const s of Object.keys(tryOn) as Slot[]) if (!(s in preview.gear)) tryOn[s] = null
  }
  const now = derive(g)
  const then = sel ? derive(equip(g, sel)) : null
  const tradeIn = (it: Item) => {
    const old = [item(g.gear[it.slot])]
    if (it.weapon && WEAPON_TYPES.find((w) => w.kind === it.weapon)!.twoHanded) old.push(item(g.gear.shield))
    return old.reduce((a, o) => a + (o ? Math.round(o.price * 0.4) : 0), 0)
  }
  const buy = (it: Item) => {
    const cost = it.price - tradeIn(it)
    if (save.gold < cost || canWear(g, it) || (it.slot === 'shield' && now.weapon.twoHanded && g.gear.weapon)) return
    sound.coins()
    update((s) => ({ ...s, gold: s.gold - cost, g: equip(s.g, it) }))
    setSel(null)
  }
  const diff = (a: number, b: number, unit = '') => {
    const d = Math.round((b - a) * 10) / 10
    return d === 0 ? null : <b className={d > 0 ? 'is-up' : 'is-down'}>{`${d > 0 ? '+' : ''}${d}${unit}`}</b>
  }

  return (
    <div className="gl-page gl-shop">
      <PageHead title={kind === 'forge' ? 'The Forge' : 'The Armoury'} onBack={onBack}>
        <Gold n={save.gold} />
      </PageHead>
      <div className="gl-shop-grid">
        <div className="gl-panel gl-tryon">
          <Portrait look={g.look} gear={tryOn} />
          <div className="gl-compare">
            <span>Armour {now.armour} {then && diff(now.armour, then.armour)}</span>
            <span>
              Damage {Math.round(now.dmg[0] + now.dmgBonus)}–{Math.round(now.dmg[1] + now.dmgBonus)} {then && diff((now.dmg[0] + now.dmg[1]) / 2 + now.dmgBonus, (then.dmg[0] + then.dmg[1]) / 2 + then.dmgBonus)}
            </span>
            <span>Block {Math.round(now.block * 100)}% {then && diff(now.block * 100, then.block * 100, '%')}</span>
            <span>Dodge {Math.round(now.eva)} {then && diff(now.eva, then.eva)}</span>
            <span>Reach {now.weapon.reach} {then && diff(now.weapon.reach, then.weapon.reach)}</span>
          </div>
        </div>
        <div className="gl-panel gl-wares">
          <div className="gl-tabs">
            {tabs.map((t) => (
              <button key={t} className={tab === t ? 'is-active' : ''} onClick={() => (setTab(t), setSel(null), sound.ui())}>
                {kind === 'forge' ? WEAPON_TYPES.find((w) => w.kind === t)!.name : SLOT_NAMES[t as Slot]}
              </button>
            ))}
          </div>
          <div className="gl-items">
            {list
              .filter((it) => it.level <= g.level + 6)
              .map((it) => {
                const owned = g.gear[it.slot] === it.id
                const twoHands = it.slot === 'shield' && !!now.weapon.twoHanded && !!g.gear.weapon
                const why = twoHands ? 'Your weapon needs both hands' : canWear(g, it)
                const cost = it.price - tradeIn(it)
                return (
                  <div key={it.id} className={`gl-item ${sel?.id === it.id ? 'is-sel' : ''} ${why ? 'is-locked' : ''}`} onClick={() => setSel(sel?.id === it.id ? null : it)}>
                    <i className="gl-tier" style={{ background: MATERIALS[it.tier].base, boxShadow: MATERIALS[it.tier].glow ? `0 0 8px ${MATERIALS[it.tier].glow}` : undefined }} />
                    <div className="gl-item-info">
                      <strong>{it.name}</strong>
                      <span>{itemStats(it)}</span>
                      {why && <span className="gl-req">{why}</span>}
                    </div>
                    <div className="gl-item-buy">
                      {owned ? (
                        <span className="gl-owned">Equipped</span>
                      ) : (
                        <>
                          <Gold n={Math.max(0, cost)} />
                          <button className="gl-btn is-small is-primary" disabled={!!why || save.gold < cost} onClick={(e) => (e.stopPropagation(), buy(it))}>
                            Buy
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                )
              })}
          </div>
          <p className="gl-muted gl-fine">Prices include trading in what you wear now. Click an item to try it on.</p>
        </div>
      </div>
    </div>
  )
}

export function MageShop({ save, update, onBack, sound }: { save: Save; update: Update; onBack: () => void; sound: { coins: () => void } }) {
  const g = save.g
  const mag = gearStats(g).mag
  return (
    <div className="gl-page gl-shop">
      <PageHead title="Mage Tower" onBack={onBack}>
        <Gold n={save.gold} />
      </PageHead>
      <p className="gl-blurb">Spells cost mana in the arena; Magic raises your mana and their power. Your Magic: {mag} ({derive(g).maxMana} mana).</p>
      <div className="gl-panel gl-items is-list">
        {SPELLS.map((sp) => {
          const owned = g.spells.includes(sp.id)
          const why = g.level < sp.level ? `Needs level ${sp.level}` : null
          return (
            <div key={sp.id} className={`gl-item ${why ? 'is-locked' : ''}`}>
              <i className="gl-tier" style={{ background: sp.colour, boxShadow: `0 0 10px ${sp.colour}` }} />
              <div className="gl-item-info">
                <strong>{sp.name}</strong>
                <span>
                  {sp.text} {sp.mana} mana.
                </span>
                {why && <span className="gl-req">{why}</span>}
              </div>
              <div className="gl-item-buy">
                {owned ? (
                  <span className="gl-owned">Learned</span>
                ) : (
                  <>
                    <Gold n={sp.price} />
                    <button className="gl-btn is-small is-primary" disabled={!!why || save.gold < sp.price} onClick={() => (sound.coins(), update((s) => ({ ...s, gold: s.gold - sp.price, g: { ...s.g, spells: [...s.g.spells, sp.id] } })))}>
                      Learn
                    </button>
                  </>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function Apothecary({ save, update, onBack, sound }: { save: Save; update: Update; onBack: () => void; sound: { coins: () => void } }) {
  const g = save.g
  const total = POTIONS.reduce((a, p) => a + g.potions[p.id], 0)
  const price = potionPrice(g.level)
  return (
    <div className="gl-page gl-shop">
      <PageHead title="Apothecary" onBack={onBack}>
        <Gold n={save.gold} />
      </PageHead>
      <p className="gl-blurb">
        Carry up to {MAX_POTIONS} potions into the arena. Drinking one takes your turn. You carry {total}.
      </p>
      <div className="gl-panel gl-items is-list">
        {POTIONS.map((p) => (
          <div key={p.id} className="gl-item">
            <i className="gl-tier is-potion" style={{ background: p.colour }} />
            <div className="gl-item-info">
              <strong>
                {p.name} <span className="gl-muted">× {g.potions[p.id]}</span>
              </strong>
              <span>{p.text}</span>
            </div>
            <div className="gl-item-buy">
              <Gold n={price} />
              <button className="gl-btn is-small is-primary" disabled={total >= MAX_POTIONS || save.gold < price} onClick={() => (sound.coins(), update((s) => ({ ...s, gold: s.gold - price, g: { ...s.g, potions: { ...s.g.potions, [p.id]: s.g.potions[p.id] + 1 } } })))}>
                Buy
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export function Training({ save, update, onBack, sound }: { save: Save; update: Update; onBack: () => void; sound: { coins: () => void } }) {
  const price = trainPrice(save)
  const respec = respecPrice(save)
  const spent = Object.values(save.g.stats).reduce((a, b) => a + b, 0) - STATS.length * BASE_STAT
  return (
    <div className="gl-page gl-shop">
      <PageHead title="Training Yard" onBack={onBack}>
        <Gold n={save.gold} />
      </PageHead>
      <div className="gl-panel gl-train">
        <h3>Extra drills</h3>
        <p>
          Doctore will drill you for a stat point. Each session costs more than the last. Sessions so far: {save.trained}.
        </p>
        <button className="gl-btn is-primary" disabled={save.gold < price} onClick={() => (sound.coins(), update((s) => ({ ...s, gold: s.gold - price, trained: s.trained + 1, g: { ...s.g, points: s.g.points + 1 } })))}>
          Train: +1 stat point for <Gold n={price} />
        </button>
        <h3>Start over</h3>
        <p>Forget your training and hand out all {spent} points again. Perks and spells stay.</p>
        <button
          className="gl-btn"
          disabled={save.gold < respec || spent === 0}
          onClick={() => (
            sound.coins(),
            update((s) => ({ ...s, gold: s.gold - respec, g: { ...s.g, stats: Object.fromEntries(STATS.map((x) => [x.key, BASE_STAT])) as Gladiator['stats'], points: s.g.points + spent } }))
          )}
        >
          Retrain for <Gold n={respec} />
        </button>
        <p className="gl-muted gl-fine">Spend points under Your Gladiator.</p>
      </div>
    </div>
  )
}

// --- Your gladiator ------------------------------------------------------------------------------

export function perkChoices(save: Save): PerkId[] {
  const r = rng(save.g.level * 131 + save.g.perks.length * 17 + save.created)
  return PERKS.filter((p) => !save.g.perks.includes(p.id))
    .map((p) => ({ p, k: r() }))
    .sort((a, b) => a.k - b.k)
    .slice(0, 3)
    .map((x) => x.p.id)
}

export function Sheet({ save, update, onBack, sound }: { save: Save; update: Update; onBack: () => void; sound: { ui: () => void; fanfare: () => void } }) {
  const g = save.g
  const d = derive(g)
  const gs = gearStats(g)
  const raise = (k: StatKey) => {
    if (g.points <= 0) return
    sound.ui()
    update((s) => ({ ...s, g: { ...s.g, points: s.g.points - 1, stats: { ...s.g.stats, [k]: s.g.stats[k] + 1 } } }))
  }
  const choices = save.pendingPerks > 0 ? perkChoices(save) : []
  return (
    <div className="gl-page">
      <PageHead title={g.name} onBack={onBack}>
        {g.points > 0 && <span className="gl-points is-left">{g.points} points to spend</span>}
      </PageHead>
      <div className="gl-sheet">
        <div className="gl-panel gl-sheet-stats">
          <h3>Stats</h3>
          {STATS.map((s) => (
            <div key={s.key} className="gl-stat">
              <div>
                <strong>{s.name}</strong>
                <span className="gl-muted">{s.text}</span>
              </div>
              <div className="gl-stepper">
                <b>
                  {gs[s.key]}
                  {gs[s.key] !== g.stats[s.key] && <small className="gl-muted"> ({g.stats[s.key]})</small>}
                </b>
                <button onClick={() => raise(s.key)} disabled={g.points <= 0} aria-label={`Raise ${s.name}`}>
                  +
                </button>
              </div>
            </div>
          ))}
        </div>
        <div className="gl-panel gl-sheet-derived">
          <h3>In the arena</h3>
          <dl>
            <dt>Health</dt>
            <dd>{d.maxHp}</dd>
            <dt>Stamina</dt>
            <dd>{d.maxSta}</dd>
            <dt>Mana</dt>
            <dd>{d.maxMana}</dd>
            <dt>Damage</dt>
            <dd>
              {Math.round(d.dmg[0] + d.dmgBonus)}–{Math.round(d.dmg[1] + d.dmgBonus)}
            </dd>
            <dt>Armour</dt>
            <dd>{d.armour}</dd>
            <dt>Block</dt>
            <dd>{Math.round(d.block * 100)}%</dd>
            <dt>Critical</dt>
            <dd>{Math.round(d.crit * 100)}%</dd>
            <dt>Step</dt>
            <dd>{Math.round(d.move)}</dd>
            {d.burden > 0 && (
              <>
                <dt>Overburdened</dt>
                <dd className="is-down">−{Math.round(d.burden * 10) / 10}</dd>
              </>
            )}
          </dl>
          <h3>Perks</h3>
          {g.perks.length ? (
            <ul className="gl-perks">
              {g.perks.map((id) => {
                const p = PERKS.find((x) => x.id === id)!
                return (
                  <li key={id}>
                    <strong>{p.name}</strong> <span className="gl-muted">{p.text}</span>
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className="gl-muted">A perk every five levels.</p>
          )}
          {g.spells.length > 0 && (
            <>
              <h3>Spells</h3>
              <p>{g.spells.map((s) => SPELLS.find((x) => x.id === s)!.name).join(', ')}</p>
            </>
          )}
        </div>
        <div className="gl-panel gl-sheet-rivals">
          <h3>Rivals</h3>
          {save.rivals.map((r) => (
            <div key={r.id} className="gl-rival">
              <Portrait look={r.look} gear={foeGladiator(save, { seed: r.seed, level: rivalLevel(save, r), archetype: r.archetype, rival: r.id }).gear} zoom={2.4} face={-1} still className="gl-rival-face" />
              <div>
                <strong>{r.name}</strong>
                <span className="gl-muted">
                  Lv {rivalLevel(save, r)} {ARCH_TEXT[r.archetype]} · record {r.losses}–{r.wins}
                </span>
              </div>
            </div>
          ))}
          <h3>Difficulty</h3>
          <DifficultyPicker value={save.difficulty ?? 'normal'} onPick={(difficulty) => (sound.ui(), update((s) => ({ ...s, difficulty })))} />
          <p className="gl-muted gl-fine">Changes apply from your next fight. Bouts already on offer keep their levels.</p>
          <h3>Record</h3>
          <p>
            {save.record.wins} wins, {save.record.losses} losses. Tournaments: {LEAGUES.map((l) => `${l.name} ${save.tourneyWins[l.id]}`).join(', ')}.
          </p>
          <h3>Gear</h3>
          <ul className="gl-gear">
            {(['weapon', ...ARMOUR_SLOTS] as Slot[]).map((s) => (
              <li key={s}>
                <span className="gl-muted">{SLOT_NAMES[s]}</span> {item(g.gear[s])?.name ?? '—'}
              </li>
            ))}
          </ul>
        </div>
      </div>
      {choices.length > 0 && (
        <Modal>
          <h2>Choose a perk</h2>
          <p className="gl-muted">Level {g.level}: the doctore teaches you a trick.</p>
          <div className="gl-perk-pick">
            {choices.map((id) => {
              const p = PERKS.find((x) => x.id === id)!
              return (
                <button
                  key={id}
                  className="gl-mode"
                  onClick={() => {
                    sound.fanfare()
                    update((s) => ({ ...s, pendingPerks: s.pendingPerks - 1, g: { ...s.g, perks: [...s.g.perks, id] } }))
                  }}
                >
                  <strong>{p.name}</strong>
                  <span>{p.text}</span>
                </button>
              )
            })}
          </div>
        </Modal>
      )}
    </div>
  )
}

// --- Tournament bracket --------------------------------------------------------------------------

export function Bracket({ save, onBack, onFight, onClaim }: { save: Save; onBack: () => void; onFight: () => void; onClaim: () => void }) {
  const t = save.tournament!
  const L = league(t.league)
  const next = tournamentFoe(t)
  const champion = t.rounds[t.rounds.length - 1].length === 1 ? t.rounds[t.rounds.length - 1][0] : null
  const names = ['Quarter-finals', 'Semi-finals', 'Final', 'Champion']
  return (
    <div className="gl-page">
      <PageHead title={`${L.name} Tournament`} onBack={onBack} />
      <div className="gl-bracket">
        {[0, 1, 2, 3].map((ri) => {
          const round = t.rounds[ri]
          return (
            <div key={ri} className="gl-round">
              <h4>{names[ri]}</h4>
              {round
                ? round.map((id, i) => (
                    <div key={id + i} className={`gl-entrant ${id === 'you' ? 'is-you' : ''} ${t.rounds[ri + 1] && !t.rounds[ri + 1].includes(id) ? 'is-out' : ''}`}>
                      {entrantName(save, t, id)}
                      {id !== 'you' && (t.entrants[id] as Foe).rival ? <small> rival</small> : null}
                    </div>
                  ))
                : Array.from({ length: [8, 4, 2, 1][ri] }, (_, i) => (
                    <div key={i} className="gl-entrant is-tbd">
                      ?
                    </div>
                  ))}
            </div>
          )
        })}
      </div>
      <div className="gl-bracket-foot">
        <span>Health carried into the next bout: {Math.round(t.hp * 100)}%</span>
        {next ? (
          <button className="gl-btn is-primary is-big" onClick={onFight}>
            Fight {entrantName(save, t, next.id)}
          </button>
        ) : champion === 'you' ? (
          <button className="gl-btn is-primary is-big" onClick={onClaim}>
            Claim the prize: <Gold n={L.prize} />
          </button>
        ) : (
          <button className="gl-btn is-big" onClick={onClaim}>
            {t.out ? 'Knocked out. Leave the tournament' : 'Leave'}
          </button>
        )}
      </div>
    </div>
  )
}

export { cap }
