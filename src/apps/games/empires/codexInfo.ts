import { STATIONS, TECH, accuracy, effect, type Tier, type UnitType, type Weapon, type WeaponKind } from './data'
import { hpName } from './icons'
import type { Model } from './models/index.ts'

// What the Codex says about one module or part of a unit: its name, what it does, its numbers, and
// what losing it costs. Kept apart from the Codex's drawing so the words are easy to find.

/** A module (by hardpoint index) or a part of the model (by index into model.parts). */
export type Sel = { hp: number } | { part: number }
export const sameSel = (a: Sel | null, b: Sel | null) => !!a && !!b && ('hp' in a ? 'hp' in b && a.hp === b.hp : 'part' in b && a.part === b.part)

export const WEAPON_NAME: Record<WeaponKind, string> = { laser: 'Lasers', flak: 'Flak', turbo: 'Turbolaser', missile: 'Torpedoes', ion: 'Ion cannon' }
const TIER_NAME: Record<Tier, string> = { fighter: 'fighters', gunship: 'gunships', frigate: 'frigates', cruiser: 'cruisers', capital: 'flagships', station: 'stations', mine: 'mining platforms', defense: 'defense platforms' }
const TIERS = Object.keys(TIER_NAME) as Tier[]

/** What a gun is good and poor against: its damage against each class times how often it hits. */
export function targets(kind: WeaponKind) {
  const score = (t: Tier) => effect(kind, t) * accuracy(kind, t)
  return { good: TIERS.filter((t) => score(t) >= 0.85).map((t) => TIER_NAME[t]), poor: TIERS.filter((t) => score(t) <= 0.3).map((t) => TIER_NAME[t]) }
}

export const weaponLine = (w: Weapon) => `${w.damage}${(w.burst ?? 1) > 1 ? `×${w.burst}` : ''} dmg every ${w.cooldown} s · range ${w.range} · ${((w.damage * (w.burst ?? 1)) / w.cooldown).toFixed(1)} dps`

/** Friendly names for parts, by the start of their id. */
const PART_NAMES: [string, string][] = [
  ['socket', 'Socket'], ['hull', 'Hull plating'], ['tip', 'Wing tip'], ['wing', 'Wing'], ['gun', 'Cannon'], ['strake', 'Canard'], ['fuse', 'Fuselage'],
  ['spine', 'Spine'], ['droid', 'Astromech socket'], ['cockpit', 'Cockpit'], ['engine', 'Engine'], ['deck', 'Deck'], ['rail', 'Deck rail'],
  ['block', 'Block'], ['bridge', 'Bridge'], ['tower', 'Bridge tower'], ['mast', 'Antenna mast'], ['dish', 'Sensor dish'], ['claw', 'Claw wing'],
  ['hook', 'Lower claw'], ['shoulder', 'Shoulder'], ['tail', 'Tail'], ['head', 'Head'], ['eye', 'Sensor eye'], ['skirt', 'Hull skirt'],
  ['spire', 'Command spire'], ['fin', 'Spire fin'], ['crown', 'Spire crown'], ['beacon', 'Spire beacon'], ['strut', 'Strut'], ['bar', 'Outer frame'],
  ['bastion', 'Corner bastion'], ['girder', 'Girder'], ['brace', 'Brace'], ['arm', 'Arm'], ['far', 'Far pod'], ['dock', 'Dry dock'],
]
export function partName(m: Model, i: number, t: UnitType) {
  const id = m.parts[i].id
  if (id.startsWith('pod')) return t.tier === 'station' ? 'Docking pod' : 'Engine pod'
  if (id.startsWith('block') && t.tier === 'station') return id === 'block' ? 'Command block' : 'Frame block'
  if (id.startsWith('deck') && t.tier === 'station') return 'Deck plate'
  return PART_NAMES.find(([p]) => id.startsWith(p))?.[1] ?? id
}

export function selName(t: UnitType, m: Model | null, s: Sel) {
  if ('hp' in s) return `${hpName(t.hardpoints[s.hp])} #${s.hp + 1}`
  return m ? partName(m, s.part, t) : ''
}

export type Info = { title: string; kind: string; hp?: number; weapon?: Weapon; does: string; lost: string; off: string }

/** Everything the Codex says about a module or part. */
export function info(t: UnitType, m: Model | null, s: Sel): Info {
  if ('part' in s) {
    const p = m!.parts[s.part]
    const d = p.detach
    const name = partName(m!, s.part, t)
    return {
      title: name,
      kind: 'Hull part',
      does: p.engine !== undefined ? `Carries engine glow ${p.engine + 1}.` : 'Part of the hull.',
      lost: d ? (p.engine !== undefined ? 'Its engine light goes out with it.' : 'Nothing in the battle: hull parts are for show; the hull points are what count.') : '',
      off: !d ? 'Stays on: it only goes when the hull breaks up.' : d.hp !== undefined ? `Comes off with ${hpName(t.hardpoints[d.hp])} #${d.hp + 1}.` : d.hull !== undefined ? `Breaks off below ${Math.round(d.hull * 100)}% hull.` : 'Breaks off only when the unit is destroyed.',
    }
  }
  const h = t.hardpoints[s.hp]
  const mt = m?.mounts[s.hp]
  const same = t.hardpoints.filter((x) => x.kind === h.kind).length
  const station = t.tier === 'station'
  const tech = station && h.key ? STATIONS[t.faction].modules.find((x) => x.key === h.key)?.tech : undefined
  let does = ''
  let lost = ''
  switch (h.kind) {
    case 'turret': {
      does = `${h.art === 'flak' ? 'Point defence: fast flak against small craft.' : h.art === 'ion' ? 'An ion cannon: tears down shields, barely scratches a hull.' : 'A heavy gun for warships and structures.'} Turns and fires on its own.`
      lost = 'Its guns fall silent.'
      break
    }
    case 'shield':
      does = same > 1 ? `Powers the shields: each of the ${same} generators carries an equal share.` : 'Powers the shields.'
      lost = same > 1 ? `Shield capacity drops by a ${same === 2 ? 'half' : `${same}th`}; with all of them gone the shields are down.` : 'The shields are down for good (until repaired).'
      break
    case 'engine':
      does = 'Drives the ship.'
      lost = `Speed falls: the ship keeps a quarter of its speed with every engine gone${same > 1 ? `, and each of the ${same} carries an equal share of the rest` : ''}.`
      break
    case 'hangar':
      does = station ? 'Launches the strike craft built at the station and rebuilds its defense wing.' : t.carrier ? 'Launches the carrier\'s squadrons.' : 'A hangar bay.'
      lost = station ? 'With no hangar standing, no fighters launch and the defense wing isn\'t rebuilt.' : 'With every hangar gone, no more squadrons launch.'
      break
    case 'refinery':
      does = station ? (tech ? TECH[tech].blurb : 'Refines ore.') : 'The ore silo: earns a fifth of the platform\'s income.'
      lost = station ? 'The income bonus stops until it\'s rebuilt.' : 'That fifth of the income stops until repaired.'
      break
    case 'drill':
      does = 'A drill rig: earns 40% of the platform\'s income.'
      lost = 'Its share of the income stops until repaired.'
      break
    case 'sensor':
    case 'dock':
      does = tech ? TECH[tech].blurb : h.kind === 'dock' ? 'A repair dock.' : 'A targeting array.'
      lost = 'Its bonus stops until it\'s rebuilt.'
      break
  }
  if (station) lost += ' Field repair crews can rebuild it.'
  return {
    title: `${hpName(h)} #${s.hp + 1}`,
    kind: h.kind === 'turret' ? `${WEAPON_NAME[h.weapon!.kind]} turret` : hpName(h),
    hp: h.hp,
    weapon: h.weapon,
    does,
    lost,
    off: mt ? (mt.detach ? 'Blown clean off when destroyed: a burnt socket stays.' : 'Stays on the hull when destroyed, wrecked.') : '',
  }
}
