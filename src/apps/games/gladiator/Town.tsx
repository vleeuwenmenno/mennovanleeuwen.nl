import { useMemo, useState } from 'react'
import { buyMissing, collectCraft, entrantName, foeGladiator, price, purseFor, shortfall, respecPrice, rivalLevel, rules, trainPrice, tournamentFoe, unlocked, type Foe, type Save } from './career'
import { simulate } from './combat'
import { DifficultyPicker } from './Menus'
import { canWear, derive, equip, gearStats, has, rng, xpFor, type Gladiator } from './character'
import {
  tierStyle, ARMOUR_SLOTS, BASE_STAT, ITEMS, item, league, LEAGUES, MATERIALS, MAX_POTIONS, PERK_LEVELS, PERKS, potionPrice, POTIONS, SLOT_NAMES, SPELLS, STATS, WEAPON_MATERIALS, WEAPON_TYPES,
  type Item, type LeagueId, type PerkId, type PotionId, type Slot, type StatKey,
} from './data'
import { blueprintPrice, craftFee, craftTime, have, knowsBlueprint, prettyHours, recipe, slotsAt, startCraft } from './estate'
import type { ClipName } from './rig'
import { BagView, Bar, CardIcon, Gold, ItemArt, Modal, PageHead, PlaceIcon, Portrait, useNow } from './ui'

// The town between fights: the hub, the arena's notice board, the shops, the trainer, your
// gladiator's sheet and the tournament bracket.

type Update = (fn: (s: Save) => Save) => void
export type Place = 'hub' | 'arena' | 'forge' | 'armoury' | 'mage' | 'apothecary' | 'training' | 'gladiator' | 'tournament' | 'estate' | 'market'

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
  estate: 'estate',
  market: 'market',
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
  { id: 'estate', name: 'Estate', text: 'Mines, woods and pastures that work while you rest', glyph: '🏡' },
  { id: 'market', name: 'Market', text: 'Materials for gold, prices change daily', glyph: '⚖️' },
  { id: 'forge', name: 'Forge', text: 'Blueprints and forging of weapons', glyph: '🔨' },
  { id: 'armoury', name: 'Armoury', text: 'Blueprints and forging of armour', glyph: '🛡️' },
  { id: 'mage', name: 'Mage Tower', text: 'Spells for coin', glyph: '✨' },
  { id: 'apothecary', name: 'Apothecary', text: 'Potions for the fight', glyph: '⚗️' },
  { id: 'training', name: 'Training Yard', text: 'Buy extra training', glyph: '🎯' },
  { id: 'gladiator', name: 'Your Gladiator', text: 'Stats, perks, rivals', glyph: '🏛️' },
]

export function Hub({ save, go }: { save: Save; go: (p: Place) => void }) {
  const now = useNow(15000)
  const badge = save.g.points + save.pendingPerks
  // Finished jobs and forgings waiting to be picked up.
  const ready: Partial<Record<Place, number>> = {
    gladiator: badge,
    estate: save.estate.jobs.filter((j) => j.end <= now).length,
    forge: save.estate.crafting.filter((c) => c.end <= now && item(c.item)?.slot === 'weapon').length,
    armoury: save.estate.crafting.filter((c) => c.end <= now && item(c.item)?.slot !== 'weapon').length,
  }
  return (
    <div className="gl-hub">
      <div className="gl-hub-hero">
        <Portrait look={save.g.look} gear={save.g.gear} clip={save.record.wins ? 'victory' : 'guard'} zoom={0.8} />
      </div>
      <div className="gl-hub-places">
        {save.tournament && !save.tournament.out && tournamentFoe(save.tournament) && (
          <button className="gl-place is-hot" onClick={() => go('tournament')}>
            <PlaceIcon id="tournament" glyph="🏆" />
            <strong>Tournament in progress</strong>
            <span>{league(save.tournament.league).name}: your next bout awaits</span>
          </button>
        )}
        {PLACES.map((p) => (
          <button key={p.id} className="gl-place" onClick={() => go(p.id)}>
            <PlaceIcon id={p.id} glyph={p.glyph} />
            <strong>{p.name}</strong>
            <span>{p.text}</span>
            {!!ready[p.id] && <b className="gl-badge">{ready[p.id]}</b>}
          </button>
        ))}
      </div>
    </div>
  )
}

// --- Arena ---------------------------------------------------------------------------------------

const ARCH_TEXT: Record<string, string> = { brute: 'Brute', duelist: 'Duelist', tank: 'Shieldwall', showman: 'Showman', mage: 'Battlemage', spearman: 'Spearman' }

/**
 * The bookmakers' odds of you beating `foe`: a couple of dozen quick simulated bouts, seeded so
 * the number doesn't jump around between renders.
 */
function odds(you: Gladiator, foe: Gladiator, seed: number) {
  let wins = 0
  const n = 24
  for (let i = 0; i < n; i++) if (simulate(you, foe, rng(seed + i * 7919)) === 0) wins++
  return wins / n
}

function Danger({ p }: { p: number }) {
  const skulls = p >= 0.7 ? 1 : p >= 0.42 ? 2 : 3
  return (
    <span className={`gl-danger is-${skulls}`} title={`The bookmakers give you ${Math.round(p * 100)}%`}>
      <span className="gl-skulls">{'💀'.repeat(skulls)}</span>
      <span>{skulls === 1 ? 'Easy money' : skulls === 2 ? 'Fair fight' : 'Dangerous'}</span>
      <b>{Math.round(p * 100)}%</b>
    </span>
  )
}

/** Their number next to yours, with an arrow when theirs is clearly better or worse. */
function Versus({ label, them, you }: { label: string; them: number; you: number }) {
  const d = them - you
  const big = Math.abs(d) > Math.max(2, you * 0.12)
  return (
    <div className="gl-vs">
      <span>{label}</span>
      <b className={big ? (d > 0 ? 'is-worse' : 'is-better') : ''}>
        {Math.round(them)}
        {big ? (d > 0 ? ' ▲' : ' ▼') : ''}
      </b>
      <i>you {Math.round(you)}</i>
    </div>
  )
}

function FighterCard({ save, foe, label, purse, onFight, kind }: { save: Save; foe: Foe; label: string; purse: number; kind: 'exhibition' | 'rival'; onFight: () => void }) {
  const g = foeGladiator(save, foe)
  const d = derive(g)
  const me = derive(save.g)
  const avg = (x: ReturnType<typeof derive>) => (x.dmg[0] + x.dmg[1]) / 2 + x.dmgBonus
  const p = useMemo(() => odds(save.g, g, foe.seed + foe.level * 31), [save.g, g.id, foe.seed, foe.level, save.difficulty])
  return (
    <div className={`gl-card ${kind === 'rival' ? 'is-rival' : ''}`}>
      <span className="gl-card-ribbon">{label}</span>
      <div className="gl-card-art">
        <Portrait look={g.look} gear={g.gear} face={-1} />
      </div>
      <div className="gl-card-body">
        <strong>{g.name}</strong>
        <span className="gl-muted">
          Lv {g.level} {ARCH_TEXT[g.archetype ?? 'duelist']} · {d.weaponItem?.name ?? 'Fists'}
        </span>
        <Danger p={p} />
        <div className="gl-vs-grid">
          <Versus label="Health" them={d.maxHp} you={me.maxHp} />
          <Versus label="Damage" them={avg(d)} you={avg(me)} />
          <Versus label="Armour" them={d.armour} you={me.armour} />
        </div>
      </div>
      <div className="gl-card-foot">
        <span className="gl-coin-badge">
          <Gold n={purse} />
        </span>
        <button className="gl-btn is-primary" onClick={onFight}>
          Fight
        </button>
      </div>
    </div>
  )
}

const UNLOCK_TEXT: Record<LeagueId, string> = { pits: '', city: 'Beat the Village Pits champion', colosseum: 'Beat the City Arena champion' }

export function ArenaBoard({ save, onBack, onFight, onTournament, onLeague, onReroll }: { save: Save; onReroll: () => void; onBack: () => void; onFight: (foe: Foe, kind: 'exhibition' | 'rival' | 'champion') => void; onTournament: (l: LeagueId) => void; onLeague: (l: LeagueId) => void }) {
  const L = league(save.league)
  const champ = L.champion
  const champBeaten = save.beaten.includes(L.id)
  const canChamp = save.tourneyWins[L.id] > 0
  const champFoe: Foe = { seed: champ.seed, level: champ.level, archetype: champ.archetype, champion: L.id }
  const champG = foeGladiator(save, champFoe)
  const champOdds = useMemo(() => odds(save.g, champG, champ.seed), [save.g, champG.id, champ.seed, save.difficulty])
  const inTourney = save.tournament && !save.tournament.out && tournamentFoe(save.tournament)
  return (
    <div className="gl-page gl-arena">
      <PageHead title="The Arena" onBack={onBack} />
      <div className="gl-leagues" role="radiogroup" aria-label="League">
        {LEAGUES.map((l) => {
          const open = unlocked(save, l.id)
          const beaten = save.beaten.includes(l.id)
          return (
            <button
              key={l.id}
              role="radio"
              aria-checked={save.league === l.id}
              className={`gl-league ${save.league === l.id ? 'is-active' : ''} ${open ? '' : 'is-locked'}`}
              style={{ backgroundImage: `url(/games/gladiator/${l.arena}.webp)` }}
              disabled={!open}
              onClick={() => onLeague(l.id)}
            >
              <span className="gl-league-shade" />
              <strong>{l.name}</strong>
              <span>{open ? `Opponents level ${l.levels[0]}–${l.levels[1]}` : `🔒 ${UNLOCK_TEXT[l.id]}`}</span>
              {open && <em>{beaten ? `★ Champion beaten` : save.tourneyWins[l.id] ? `🏆 ${save.tourneyWins[l.id]} tournament${save.tourneyWins[l.id] > 1 ? 's' : ''} won` : l.blurb}</em>}
            </button>
          )
        })}
      </div>

      <div className="gl-arena-grid">
        <section>
          <h3 className="gl-section">Bouts on offer</h3>
          <div className="gl-cards">
            {save.offers.map((o) => (
              <FighterCard key={`${o.seed}-${o.level}`} save={save} foe={o} label={o.label} purse={o.purse} kind={o.rival ? 'rival' : 'exhibition'} onFight={() => onFight(o, o.rival ? 'rival' : 'exhibition')} />
            ))}
          </div>
          <button className="gl-btn is-quiet gl-reroll" disabled={save.gold < 5} onClick={onReroll} title="Bribe the lanista for different opponents">
            New opponents (<Gold n={5} />)
          </button>
        </section>

        <aside className="gl-arena-side">
          <h3 className="gl-section">Champion</h3>
          <div className={`gl-poster ${champBeaten ? 'is-beaten' : ''}`}>
            <span className="gl-poster-head">{champBeaten ? 'Defeated' : `Champion of the ${L.name}`}</span>
            <div className="gl-poster-art">
              <Portrait look={champG.look} gear={champG.gear} face={-1} />
            </div>
            <strong>{champ.name}</strong>
            <span className="gl-poster-title">{champ.title}</span>
            <span className="gl-muted">
              Lv {champG.level} {ARCH_TEXT[champ.archetype]}
            </span>
            <Danger p={champOdds} />
            <div className="gl-poster-foot">
              <span className="gl-coin-badge">
                <Gold n={champBeaten ? purseFor(champG.level, 'champion') : L.prize} />
              </span>
              <button className="gl-btn is-primary" disabled={!canChamp} onClick={() => onFight(champFoe, 'champion')}>
                {champBeaten ? 'Rematch' : 'Challenge'}
              </button>
            </div>
            {!canChamp && <span className="gl-muted gl-fine">Win a tournament here to earn a challenge.</span>}
          </div>

          <h3 className="gl-section">Tournament</h3>
          <div className="gl-plaque">
            <PlaceIcon id="tournament" glyph="🏆" />
            <div>
              <p>Eight gladiators, three rounds, no rest. The surgeon patches up {Math.round(rules(save).surgeon * 100)}% of your wounds between bouts.</p>
              <p>
                Entry <Gold n={L.entry} /> · Prize <Gold n={L.prize} /> · Won {save.tourneyWins[L.id]}
              </p>
              {inTourney ? (
                <button className="gl-btn is-primary" onClick={() => onTournament(save.tournament!.league)}>
                  Back to your bracket
                </button>
              ) : (
                <button className="gl-btn is-primary" disabled={save.gold < L.entry || save.g.level < L.levels[0]} onClick={() => onTournament(L.id)}>
                  {save.g.level < L.levels[0] ? `Needs level ${L.levels[0]}` : save.gold < L.entry ? 'Not enough gold' : 'Enter'}
                </button>
              )}
            </div>
          </div>
        </aside>
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

/** A number now and what it would become, green or red when it changes. */
function Delta({ label, now, then, unit = '' }: { label: string; now: number; then: number | null; unit?: string }) {
  const d = then === null ? 0 : Math.round((then - now) * 10) / 10
  return (
    <div className="gl-vs">
      <span>{label}</span>
      <b>
        {Math.round(now * 10) / 10}
        {unit}
      </b>
      <i className={d > 0 ? 'is-up' : d < 0 ? 'is-down' : ''}>{d ? `${d > 0 ? '+' : ''}${d}${unit}` : ''}</i>
    </div>
  )
}

const avgDamage = (d: ReturnType<typeof derive>) => (d.dmg[0] + d.dmg[1]) / 2 + d.dmgBonus

export function GearShop({ save, update, kind, onBack, sound }: { save: Save; update: Update; kind: 'forge' | 'armoury'; onBack: () => void; sound: { coins: () => void; ui: () => void; fanfare: () => void } }) {
  const clock = useNow(1000)
  const e = save.estate
  const benches = slotsAt(e.levels.workshop)
  const tabs: string[] = kind === 'forge' ? WEAPON_TYPES.map((w) => w.kind) : ARMOUR_SLOTS
  const g = save.g
  const equippedTab = kind === 'forge' ? item(g.gear.weapon)?.weapon ?? tabs[0] : tabs[0]
  const [tab, setTab] = useState<string>(equippedTab)
  const [sel, setSel] = useState<Item | null>(null)
  const inTab = (t: string) => ITEMS.filter((i) => (kind === 'forge' ? i.weapon === t : i.slot === t && !i.weapon))
  const list = inTab(tab).filter((it) => it.level <= g.level + 6)
  const tryOn: Partial<Record<Slot, string | Item | null>> = { ...g.gear }
  if (sel) {
    const preview = equip(g, sel)
    Object.assign(tryOn, preview.gear)
    for (const s of Object.keys(tryOn) as Slot[]) if (!(s in preview.gear)) tryOn[s] = null
  }
  const now = derive(g)
  const then = sel ? derive(equip(g, sel)) : null
  const blocker = (it: Item) => (it.slot === 'shield' && now.weapon.twoHanded && g.gear.weapon ? 'Your weapon needs both hands' : canWear(g, it))
  const buyBlueprint = (it: Item) => {
    const cost = price(save, blueprintPrice(it))
    if (save.gold < cost) return
    sound.coins()
    update((s) => ({ ...s, gold: s.gold - cost, estate: { ...s.estate, blueprints: [...s.estate.blueprints, it.id] } }))
  }
  const forge = (it: Item) => {
    const fee = price(save, craftFee(it))
    if (save.gold < fee || blocker(it)) return
    const next = startCraft(save.estate, it, Date.now())
    if (!next) return
    sound.coins()
    update((s) => ({ ...s, gold: s.gold - fee, estate: next }))
  }
  const collect = (id: string) => {
    sound.fanfare()
    update((s) => collectCraft(s, id, Date.now()))
    setSel(null)
  }
  /** The headline gain of an item over what's worn now. */
  const gain = (it: Item) => {
    const after = derive(equip(g, it))
    if (it.weapon) return { n: avgDamage(after) - avgDamage(now), what: 'damage' }
    if (it.slot === 'shield') return { n: (after.block - now.block) * 100, what: '% block' }
    if (it.slot === 'cape') return { n: after.stats.cha - now.stats.cha, what: 'charisma' }
    return { n: after.armour - now.armour, what: 'armour' }
  }
  // Each tab is shown by the piece you wear there, or the cheapest one in it.
  const tabArt = (t: string) => {
    const worn = kind === 'forge' ? (item(g.gear.weapon)?.weapon === t ? item(g.gear.weapon) : null) : item(g.gear[t as Slot])
    return worn ?? inTab(t)[0]
  }
  const tabText = (t: string) => {
    if (kind === 'forge') {
      const w = WEAPON_TYPES.find((x) => x.kind === t)!
      return `reach ${w.reach} · ${w.twoHanded ? 'two hands' : 'one hand'}`
    }
    return item(g.gear[t as Slot])?.name ?? 'nothing worn'
  }

  return (
    <div className="gl-page gl-shop">
      <PageHead title={kind === 'forge' ? 'The Forge' : 'The Armoury'} onBack={onBack}>
        <span className="gl-coin-badge">
          <Gold n={save.gold} />
        </span>
      </PageHead>
      <div className="gl-cats" role="tablist">
        {tabs.map((t) => {
          const worn = kind === 'forge' ? item(g.gear.weapon)?.weapon === t : !!g.gear[t as Slot]
          return (
            <button key={t} role="tab" aria-selected={tab === t} className={`gl-cat ${tab === t ? 'is-active' : ''}`} onClick={() => (setTab(t), setSel(null), sound.ui())}>
              <ItemArt it={tabArt(t)} look={g.look} className="gl-cat-art" />
              <strong>{kind === 'forge' ? WEAPON_TYPES.find((w) => w.kind === t)!.name : SLOT_NAMES[t as Slot]}</strong>
              <span>{tabText(t)}</span>
              {worn && kind === 'forge' && <em>wielded</em>}
            </button>
          )
        })}
      </div>
      <div className="gl-benches">
        <span>
          🔨 Workshop benches: {e.crafting.length}/{benches} in use
        </span>
        {e.crafting.map((c) => {
          const it = item(c.item)!
          const done = c.end <= clock
          return (
            <span key={c.id} className={`gl-bench ${done ? 'is-done' : ''}`}>
              {it.name}: {done ? 'ready' : prettyHours(c.end - clock)}
              {done && (
                <button className="gl-btn is-small is-primary" onClick={() => collect(c.id)}>
                  Collect
                </button>
              )}
            </span>
          )
        })}
      </div>
      <div className="gl-shop-grid">
        <aside className="gl-poster gl-mirror">
          <span className="gl-poster-head">{sel ? 'Trying on' : 'The mirror'}</span>
          <div className="gl-poster-art">
            <Portrait look={g.look} gear={tryOn} />
          </div>
          <strong>{sel ? sel.name : g.name}</strong>
          <div className="gl-vs-grid gl-mirror-stats">
            <Delta label="Armour" now={now.armour} then={then?.armour ?? null} />
            <Delta label="Damage" now={avgDamage(now)} then={then ? avgDamage(then) : null} />
            <Delta label="Block" now={Math.round(now.block * 100)} then={then ? Math.round(then.block * 100) : null} unit="%" />
            <Delta label="Dodge" now={now.eva} then={then?.eva ?? null} />
            <Delta label="Reach" now={now.weapon.reach} then={then?.weapon.reach ?? null} />
            <Delta label="Step" now={now.move} then={then?.move ?? null} />
          </div>
          <span className="gl-muted gl-fine">{sel ? 'Tap the card again to take it off.' : 'Tap an item to try it on.'}</span>
        </aside>
        <section className="gl-cards gl-wares">
          {list.map((it) => {
            const owned = g.gear[it.slot] === it.id
            const why = blocker(it)
            const m = MATERIALS[it.tier]
            const up = owned ? null : gain(it)
            const known = knowsBlueprint(e, it)
            const need = recipe(it)
            const enough = have(e, need)
            const fee = price(save, craftFee(it))
            const bp = price(save, blueprintPrice(it))
            const busy = e.crafting.find((c) => c.item === it.id)
            const short = known && !enough ? shortfall(save, need) : null
            const time = craftTime(e, it)
            return (
              <div key={it.id} className={`gl-card gl-ware ${sel?.id === it.id ? 'is-sel' : ''} ${why ? 'is-locked' : ''} ${owned ? 'is-owned' : ''}`} onClick={() => setSel(sel?.id === it.id ? null : it)}>
                <span className="gl-card-ribbon" style={{ background: `linear-gradient(180deg, ${m.light}, ${m.base} 45%, ${m.dark})`, color: tierStyle(it.tier) === 3 || tierStyle(it.tier) === 4 ? '#2a1a0e' : '#fff4dc' }}>
                  {kind === 'forge' ? WEAPON_MATERIALS[it.tier] : m.name}
                </span>
                <div className="gl-card-art gl-ware-art">
                  <ItemArt it={it} look={g.look} />
                </div>
                <div className="gl-card-body">
                  <strong>{it.name}</strong>
                  <span className="gl-muted">{itemStats(it)}</span>
                  {up && Math.abs(up.n) >= 0.5 && (
                    <span className={`gl-gain ${up.n > 0 ? 'is-up' : 'is-down'}`}>
                      {up.n > 0 ? '+' : ''}
                      {Math.round(up.n)} {up.what}
                    </span>
                  )}
                  {!owned && !busy && (
                    <div className="gl-recipe">
                      <BagView bag={need} have={known ? e.res : undefined} />
                      <span className="gl-chip">⏱ {time ? prettyHours(time) : 'instant'}</span>
                    </div>
                  )}
                  {busy && (
                    <div className={`gl-job is-running ${busy.end <= clock ? 'is-done' : ''}`}>
                      <div className="gl-job-head">
                        <strong>On the anvil</strong>
                        <span>{busy.end <= clock ? 'Ready!' : prettyHours(busy.end - clock)}</span>
                      </div>
                      <div className="gl-statbar">
                        <span style={{ width: `${Math.min(100, ((clock - busy.start) / Math.max(1, busy.end - busy.start)) * 100)}%` }} />
                      </div>
                    </div>
                  )}
                  {why && <span className="gl-req">{why}</span>}
                </div>
                <div className="gl-card-foot" onClick={(ev) => ev.stopPropagation()}>
                  {owned ? (
                    <span className="gl-owned">Equipped</span>
                  ) : busy ? (
                    busy.end <= clock ? (
                      <button className="gl-btn is-primary" onClick={() => collect(busy.id)}>
                        Collect &amp; equip
                      </button>
                    ) : (
                      <span className="gl-owned">Forging…</span>
                    )
                  ) : !known ? (
                    <>
                      <span className="gl-coin-badge">
                        <Gold n={bp} />
                      </span>
                      <button className="gl-btn is-primary" disabled={save.gold < bp} onClick={() => buyBlueprint(it)} title="Buy the blueprint once, then forge from materials">
                        <span className="gl-res">
                          <PlaceIcon id="blueprint" glyph="📜" />
                        </span>
                        Blueprint
                      </button>
                    </>
                  ) : short ? (
                    <>
                      <span className="gl-coin-badge" title="Buy what's missing at today's market prices">
                        <Gold n={short.cost} />
                      </span>
                      <button className="gl-btn" disabled={!short.possible || save.gold < short.cost} title={short.possible ? 'Buy the missing materials at the market' : 'The market is out of something you need today'} onClick={() => (sound.coins(), update((s) => buyMissing(s, need, Date.now())))}>
                        Buy missing
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="gl-coin-badge" title="The smith's fee">
                        <Gold n={fee} />
                      </span>
                      <button className="gl-btn is-primary" disabled={!!why || save.gold < fee || e.crafting.length >= benches} title={e.crafting.length >= benches ? 'Every bench is busy' : undefined} onClick={() => forge(it)}>
                        Forge
                      </button>
                    </>
                  )}
                </div>
              </div>
            )
          })}
        </section>
      </div>
      <p className="gl-muted gl-fine gl-shop-note">
        Buy a blueprint once, then forge from materials (from your estate or the market) for the smith's fee. What you replace is broken down for about a third of its materials.
        {rules(save).prices !== 1 ? ` ${rules(save).name} prices (×${rules(save).prices}).` : ''}
      </p>
    </div>
  )
}

const SPELL_GLYPH: Record<string, string> = { fireball: '🔥', heal: '💚', frost: '❄️', weaken: '🌀', blind: '✨', thunder: '⚡' }

export function MageShop({ save, update, onBack, sound }: { save: Save; update: Update; onBack: () => void; sound: { coins: () => void } }) {
  const g = save.g
  const d = derive(g)
  const mag = gearStats(g).mag
  const arcane = has(g, 'arcane')
  const known = g.spells.length
  return (
    <div className="gl-page gl-shop">
      <PageHead title="Mage Tower" onBack={onBack}>
        <span className="gl-coin-badge">
          <Gold n={save.gold} />
        </span>
      </PageHead>
      <div className="gl-shop-grid">
        <aside className="gl-poster gl-mirror">
          <span className="gl-poster-head">Your magic</span>
          <div className="gl-poster-art">
            <Portrait look={g.look} gear={g.gear} clip="cast" />
          </div>
          <strong>{g.name}</strong>
          <div className="gl-vs-grid gl-mirror-stats">
            <div className="gl-vs">
              <span>Magic</span>
              <b>{mag}</b>
              <i />
            </div>
            <div className="gl-vs">
              <span>Mana</span>
              <b>{d.maxMana}</b>
              <i />
            </div>
            <div className="gl-vs">
              <span>Spells</span>
              <b>
                {known} / {SPELLS.length}
              </b>
              <i />
            </div>
          </div>
          <Bar kind="mana" value={d.maxMana} max={Math.max(d.maxMana, 120)} label={`${d.maxMana} mana`} />
          <span className="gl-muted gl-fine">Each point of Magic adds 2.5 mana and makes every spell hit harder. Raise it under Your Gladiator.</span>
        </aside>
        <section className="gl-cards gl-wares">
          {SPELLS.map((sp) => {
            const owned = g.spells.includes(sp.id)
            const why = g.level < sp.level ? `Needs level ${sp.level}` : null
            const cost = price(save, sp.price)
            const power = Math.round((sp.power + mag * sp.perMag) * (arcane ? 1.15 : 1) * (d.weapon.spell ?? 1))
            const mana = Math.round(sp.mana * (arcane ? 0.8 : 1) * (d.weapon.mana ?? 1))
            const effect = sp.id === 'heal' ? `heals about ${power}` : sp.power ? `about ${power} damage` : sp.id === 'weaken' ? 'three turns' : 'two turns'
            return (
              <div key={sp.id} className={`gl-card gl-ware ${why ? 'is-locked' : ''} ${owned ? 'is-owned' : ''}`}>
                <span className="gl-card-ribbon" style={{ background: `linear-gradient(180deg, ${sp.colour}, color-mix(in srgb, ${sp.colour} 45%, #1a0d06))` }}>
                  {owned ? 'Learned' : `Level ${sp.level}`}
                </span>
                <CardIcon id={`spell-${sp.id}`} glyph={SPELL_GLYPH[sp.id]} colour={sp.colour} />
                <div className="gl-card-body">
                  <strong>{sp.name}</strong>
                  <span className="gl-muted">{sp.text}</span>
                  <div className="gl-chips">
                    <span className="gl-chip is-mana">{mana} mana</span>
                    <span className="gl-chip">{effect}</span>
                  </div>
                  {why && <span className="gl-req">{why}</span>}
                </div>
                <div className="gl-card-foot">
                  {owned ? (
                    <span className="gl-owned">In your spellbook</span>
                  ) : (
                    <>
                      <span className="gl-coin-badge">
                        <Gold n={cost} />
                      </span>
                      <button className="gl-btn is-primary" disabled={!!why || save.gold < cost} onClick={() => (sound.coins(), update((s) => ({ ...s, gold: s.gold - price(s, sp.price), g: { ...s.g, spells: [...s.g.spells, sp.id] } })))}>
                        Learn
                      </button>
                    </>
                  )}
                </div>
              </div>
            )
          })}
        </section>
      </div>
    </div>
  )
}

const POTION_GLYPH: Record<string, string> = { health: '❤️', stamina: '💪', mana: '🔮' }

export function Apothecary({ save, update, onBack, sound }: { save: Save; update: Update; onBack: () => void; sound: { coins: () => void } }) {
  const g = save.g
  const d = derive(g)
  const total = POTIONS.reduce((a, p) => a + g.potions[p.id], 0)
  const cost = price(save, potionPrice(g.level))
  const full = total >= MAX_POTIONS
  // The belt, slot by slot: what you carry, then empty loops.
  const belt = POTIONS.flatMap((p) => Array.from({ length: g.potions[p.id] }, () => p))
  const gain = (id: PotionId, amount: number) => Math.round((id === 'health' ? d.maxHp : id === 'stamina' ? d.maxSta : d.maxMana) * amount)
  return (
    <div className="gl-page gl-shop">
      <PageHead title="Apothecary" onBack={onBack}>
        <span className="gl-coin-badge">
          <Gold n={save.gold} />
        </span>
      </PageHead>
      <div className="gl-shop-grid">
        <aside className="gl-poster gl-mirror">
          <span className="gl-poster-head">Your belt</span>
          <div className="gl-belt">
            {Array.from({ length: MAX_POTIONS }, (_, i) => {
              const p = belt[i]
              return (
                <div key={i} className={`gl-belt-slot ${p ? 'is-full' : ''}`} style={p ? { ['--glow' as string]: p.colour } : undefined} title={p ? p.name : 'Empty'}>
                  {p ? <PlaceIcon id={`potion-${p.id}`} glyph={POTION_GLYPH[p.id]} /> : <span>empty</span>}
                </div>
              )
            })}
          </div>
          <strong>
            {total} of {MAX_POTIONS} carried
          </strong>
          <span className="gl-muted gl-fine">Potions come with you into every fight until you drink them. Drinking one takes your turn.</span>
        </aside>
        <section className="gl-cards gl-wares">
          {POTIONS.map((p) => {
            const n = g.potions[p.id]
            return (
              <div key={p.id} className="gl-card gl-ware">
                <span className="gl-card-ribbon" style={{ background: `linear-gradient(180deg, ${p.colour}, color-mix(in srgb, ${p.colour} 45%, #1a0d06))` }}>
                  {n ? `${n} on your belt` : 'On the shelf'}
                </span>
                <CardIcon id={`potion-${p.id}`} glyph={POTION_GLYPH[p.id]} colour={p.colour} />
                <div className="gl-card-body">
                  <strong>{p.name}</strong>
                  <span className="gl-muted">{p.text}</span>
                  <div className="gl-chips">
                    <span className="gl-chip is-up">
                      +{gain(p.id, p.amount)} {p.id === 'health' ? 'health' : p.id}
                    </span>
                  </div>
                </div>
                <div className="gl-card-foot">
                  <span className="gl-coin-badge">
                    <Gold n={cost} />
                  </span>
                  <button className="gl-btn is-primary" disabled={full || save.gold < cost} title={full ? 'Your belt is full' : undefined} onClick={() => (sound.coins(), update((s) => ({ ...s, gold: s.gold - cost, g: { ...s.g, potions: { ...s.g.potions, [p.id]: s.g.potions[p.id] + 1 } } })))}>
                    {full ? 'Full' : 'Buy'}
                  </button>
                </div>
              </div>
            )
          })}
        </section>
      </div>
    </div>
  )
}

const DRILL: ClipName[] = ['quick', 'normal', 'block', 'power', 'dodge', 'taunt']

/** A stat with a bar, scaled against what a well-trained gladiator of this level might have. */
function StatRow({ name, text, value, base, cap, onRaise, ready }: { name: string; text: string; value: number; base?: number; cap: number; onRaise?: () => void; ready?: boolean }) {
  return (
    <div className="gl-statrow">
      <div className="gl-statrow-head">
        <strong>{name}</strong>
        <b>
          {value}
          {base !== undefined && base !== value && <small> ({base} + {value - base} gear)</small>}
        </b>
        {onRaise && (
          <button className={ready ? 'is-ready' : ''} onClick={onRaise} disabled={!ready} aria-label={`Raise ${name}`}>
            +
          </button>
        )}
      </div>
      <div className="gl-statbar">
        <span style={{ width: `${Math.min(100, (value / cap) * 100)}%` }} />
      </div>
      <span className="gl-muted">{text}</span>
    </div>
  )
}

export function Training({ save, update, onBack, onSheet, sound }: { save: Save; update: Update; onBack: () => void; onSheet: () => void; sound: { coins: () => void } }) {
  const g = save.g
  const cost = trainPrice(save)
  const respec = respecPrice(save)
  const spent = Object.values(g.stats).reduce((a, b) => a + b, 0) - STATS.length * BASE_STAT
  const [sure, setSure] = useState(false)
  const gs = gearStats(g)
  const cap = Math.max(12, ...STATS.map((x) => gs[x.key]))
  return (
    <div className="gl-page gl-shop">
      <PageHead title="Training Yard" onBack={onBack}>
        <span className="gl-coin-badge">
          <Gold n={save.gold} />
        </span>
      </PageHead>
      <div className="gl-shop-grid">
        <aside className="gl-poster gl-mirror">
          <span className="gl-poster-head">At the drills</span>
          <div className="gl-poster-art">
            <Portrait look={g.look} gear={g.gear} cycle={DRILL} />
          </div>
          <strong>{g.name}</strong>
          <div className="gl-mini-stats">
            {STATS.map((x) => (
              <div key={x.key}>
                <span>{x.name}</span>
                <div className="gl-statbar">
                  <span style={{ width: `${(gs[x.key] / cap) * 100}%` }} />
                </div>
                <b>{gs[x.key]}</b>
              </div>
            ))}
          </div>
        </aside>
        <section className="gl-cards gl-wares">
          <div className="gl-card gl-ware">
            <span className="gl-card-ribbon">Session {save.trained + 1}</span>
            <CardIcon id="training" glyph="🎯" colour="#e8b35a" />
            <div className="gl-card-body">
              <strong>Extra drills</strong>
              <span className="gl-muted">Doctore drills you until you earn a stat point. Each session costs more than the last.</span>
              <div className="gl-chips">
                <span className="gl-chip is-up">+1 stat point</span>
                <span className="gl-chip">{save.trained} done</span>
              </div>
            </div>
            <div className="gl-card-foot">
              <span className="gl-coin-badge">
                <Gold n={cost} />
              </span>
              <button className="gl-btn is-primary" disabled={save.gold < cost} onClick={() => (sound.coins(), update((s) => ({ ...s, gold: s.gold - cost, trained: s.trained + 1, g: { ...s.g, points: s.g.points + 1 } })))}>
                Train
              </button>
            </div>
          </div>
          <div className="gl-card gl-ware">
            <span className="gl-card-ribbon">Start over</span>
            <CardIcon id="gladiator" glyph="🏛️" colour="#d8b04a" />
            <div className="gl-card-body">
              <strong>Retrain</strong>
              <span className="gl-muted">Forget your training and hand out all {spent} points again. Perks and spells stay.</span>
              <div className="gl-chips">
                <span className="gl-chip">{spent} points back</span>
              </div>
            </div>
            <div className="gl-card-foot">
              <span className="gl-coin-badge">
                <Gold n={respec} />
              </span>
              {sure ? (
                <button
                  className="gl-btn is-danger"
                  onClick={() => {
                    setSure(false)
                    sound.coins()
                    update((s) => ({ ...s, gold: s.gold - respec, g: { ...s.g, stats: Object.fromEntries(STATS.map((x) => [x.key, BASE_STAT])) as Gladiator['stats'], points: s.g.points + spent } }))
                  }}
                >
                  Yes, retrain
                </button>
              ) : (
                <button className="gl-btn" disabled={save.gold < respec || spent === 0} onClick={() => setSure(true)}>
                  Retrain
                </button>
              )}
            </div>
          </div>
          <div className={`gl-card gl-ware ${g.points ? 'is-hot' : ''}`}>
            <span className="gl-card-ribbon">{g.points ? 'Ready' : 'All spent'}</span>
            <div className="gl-card-art gl-icon-art gl-points-art" style={{ ['--glow' as string]: '#f2c14a' }}>
              <span>{g.points}</span>
            </div>
            <div className="gl-card-body">
              <strong>{g.points === 1 ? 'Point' : 'Points'} to spend</strong>
              <span className="gl-muted">{g.points ? 'Put them into your stats under Your Gladiator.' : 'Win fights to level up, or train here for more.'}</span>
            </div>
            <div className="gl-card-foot">
              <button className="gl-btn is-primary" onClick={onSheet}>
                Your Gladiator →
              </button>
            </div>
          </div>
        </section>
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

const PERK_GLYPH: Record<PerkId, string> = {
  riposte: '↩️',
  cleave: '🪓',
  showman: '🎭',
  secondWind: '💨',
  ironSkin: '🛡️',
  fleetFoot: '👟',
  bloodlust: '🩸',
  arcane: '🔮',
  thickSkull: '🪖',
  executioner: '💀',
  goldTongue: '🪙',
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
  const cap = Math.max(12, ...STATS.map((x) => gs[x.key]))
  const nextPerk = PERK_LEVELS.find((l) => l > g.level)
  const tiles: [string, string][] = [
    ['Health', String(d.maxHp)],
    ['Stamina', String(d.maxSta)],
    ['Mana', String(d.maxMana)],
    ['Damage', `${Math.round(d.dmg[0] + d.dmgBonus)}–${Math.round(d.dmg[1] + d.dmgBonus)}`],
    ['Armour', String(d.armour)],
    ['Block', `${Math.round(d.block * 100)}%`],
    ['Critical', `${Math.round(d.crit * 100)}%`],
    ['Step', String(Math.round(d.move))],
  ]
  return (
    <div className="gl-page">
      <PageHead title="Your Gladiator" onBack={onBack} />
      <div className="gl-me">
        <aside className="gl-poster gl-me-poster">
          <span className="gl-poster-head">{g.title ?? 'Gladiator'}</span>
          <div className="gl-poster-art">
            <Portrait look={g.look} gear={g.gear} clip={save.record.wins ? 'victory' : 'guard'} />
          </div>
          <strong>{g.name}</strong>
          <div className="gl-me-level">
            <span className="gl-level-badge">Lv {g.level}</span>
            <Bar kind="xp" value={g.xp} max={xpFor(g.level)} label={`${g.xp} / ${xpFor(g.level)} XP`} />
          </div>
          <div className="gl-chips gl-me-chips">
            <span className="gl-chip">
              {save.record.wins}–{save.record.losses}
            </span>
            <span className="gl-chip">★ {save.fame} fame</span>
            <span className="gl-chip">{rules(save).name}</span>
            {save.mode === 'hardcore' && <span className="gl-chip is-hard">Hardcore</span>}
            {LEAGUES.filter((l) => save.tourneyWins[l.id]).map((l) => (
              <span key={l.id} className="gl-chip">
                🏆 {l.name} ×{save.tourneyWins[l.id]}
              </span>
            ))}
          </div>
        </aside>

        <section className="gl-panel gl-me-stats">
          <h3>
            Stats
            <span className={`gl-points ${g.points > 0 ? 'is-left' : ''}`}>{g.points > 0 ? `${g.points} ${g.points === 1 ? 'point' : 'points'} to spend` : 'no points to spend'}</span>
          </h3>
          {STATS.map((s) => (
            <StatRow key={s.key} name={s.name} text={s.text} value={gs[s.key]} base={g.stats[s.key]} cap={cap} onRaise={() => raise(s.key)} ready={g.points > 0} />
          ))}
          <h3>In the arena</h3>
          <div className="gl-tiles">
            {tiles.map(([k, v]) => (
              <div key={k} className="gl-tile">
                <b>{v}</b>
                <span>{k}</span>
              </div>
            ))}
          </div>
          {d.burden > 0 && <p className="gl-req">Overburdened by {Math.round(d.burden * 10) / 10}: heavy gear slows you down and makes you easier to hit. More Strength helps.</p>}
        </section>

        <section className="gl-me-side">
          <div className="gl-panel">
            <h3>Gear</h3>
            <div className="gl-gear-grid">
              {(['weapon', ...ARMOUR_SLOTS] as Slot[]).map((slot) => {
                const it = item(g.gear[slot])
                return (
                  <div key={slot} className={`gl-gear-tile ${it ? '' : 'is-empty'}`} title={it ? `${it.name}: ${itemStats(it)}` : `No ${SLOT_NAMES[slot].toLowerCase()}`}>
                    {it ? <ItemArt it={it} look={g.look} className="gl-gear-art" /> : <span className="gl-gear-none">—</span>}
                    <span>{it?.name ?? SLOT_NAMES[slot]}</span>
                  </div>
                )
              })}
            </div>
          </div>
          <div className="gl-panel">
            <h3>
              Perks <span className="gl-points">{nextPerk ? `next at level ${nextPerk}` : 'all earned'}</span>
            </h3>
            {g.perks.length ? (
              <div className="gl-perk-list">
                {g.perks.map((id) => {
                  const p = PERKS.find((x) => x.id === id)!
                  return (
                    <div key={id} className="gl-perk">
                      <i>{PERK_GLYPH[id]}</i>
                      <div>
                        <strong>{p.name}</strong>
                        <span className="gl-muted">{p.text}</span>
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : (
              <p className="gl-muted">A perk every five levels: pick one of three tricks from the doctore.</p>
            )}
            {g.spells.length > 0 && (
              <>
                <h3>Spellbook</h3>
                <div className="gl-spellbook">
                  {g.spells.map((id) => (
                    <span key={id} className="gl-spell-chip" title={SPELLS.find((x) => x.id === id)!.text}>
                      <PlaceIcon id={`spell-${id}`} glyph="✨" />
                      {SPELLS.find((x) => x.id === id)!.name}
                    </span>
                  ))}
                </div>
              </>
            )}
          </div>
          <div className="gl-panel">
            <h3>Rivals</h3>
            <div className="gl-rival-list">
              {save.rivals.map((r) => {
                const lead = r.losses - r.wins
                return (
                  <div key={r.id} className="gl-rival">
                    <div className="gl-plate-face">
                      <Portrait look={r.look} gear={foeGladiator(save, { seed: r.seed, level: rivalLevel(save, r), archetype: r.archetype, rival: r.id }).gear} focus={232} zoom={3.2} face={-1} still />
                    </div>
                    <div>
                      <strong>{r.name}</strong>
                      <span className="gl-muted">
                        Lv {rivalLevel(save, r)} {ARCH_TEXT[r.archetype]}
                      </span>
                    </div>
                    <span className={`gl-chip ${lead > 0 ? 'is-up' : lead < 0 ? 'is-hard' : ''}`}>
                      {r.losses}–{r.wins}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
          <div className="gl-panel">
            <h3>Difficulty</h3>
            <DifficultyPicker value={save.difficulty ?? 'normal'} onPick={(difficulty) => (sound.ui(), update((s) => ({ ...s, difficulty })))} />
            <p className="gl-muted gl-fine">Changes apply from your next fight. Bouts already on offer keep their levels.</p>
          </div>
        </section>
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
                  className="gl-mode gl-perk"
                  onClick={() => {
                    sound.fanfare()
                    update((s) => ({ ...s, pendingPerks: s.pendingPerks - 1, g: { ...s.g, perks: [...s.g.perks, id] } }))
                  }}
                >
                  <i>{PERK_GLYPH[id]}</i>
                  <div>
                    <strong>{p.name}</strong>
                    <span>{p.text}</span>
                  </div>
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
