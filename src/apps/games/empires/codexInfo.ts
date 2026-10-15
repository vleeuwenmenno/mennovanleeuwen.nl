import { MODULE, REBUILD_MODULE, STATIONS, TECH, UNIT, WORKS_NAME, accuracy, effect, type Tier, type UnitType, type Weapon, type WeaponKind } from './data'
import { hpName } from './icons'
import { factionModels, type Model } from './models/index.ts'

// What the Codex says about one module or part of a unit: its name, what it does, its numbers, and
// what losing it costs. Kept apart from the Codex's drawing so the words are easy to find.

/** A module (by hardpoint index) or a part of the model (by index into model.parts). */
export type Sel = { hp: number } | { part: number }
export const sameSel = (a: Sel | null, b: Sel | null) => !!a && !!b && ('hp' in a ? 'hp' in b && a.hp === b.hp : 'part' in b && a.part === b.part)

export const WEAPON_NAME: Record<WeaponKind, string> = { laser: 'Lasers', flak: 'Flak', turbo: 'Turbolaser', missile: 'Torpedoes', ion: 'Ion cannon' }
const TIER_NAME: Record<Tier, string> = { fighter: 'fighters', gunship: 'gunships', frigate: 'frigates', cruiser: 'cruisers', capital: 'flagships', station: 'stations', mine: 'mining platforms', defense: 'defense platforms', yard: 'yards' }
const TIERS = Object.keys(TIER_NAME) as Tier[]

/** What a gun is good and poor against: its damage against each class times how often it hits. */
export function targets(kind: WeaponKind) {
  const score = (t: Tier) => effect(kind, t) * accuracy(kind, t)
  return { good: TIERS.filter((t) => score(t) >= 0.85).map((t) => TIER_NAME[t]), poor: TIERS.filter((t) => score(t) <= 0.3).map((t) => TIER_NAME[t]) }
}

export const weaponLine = (w: Weapon) => `${w.damage}${(w.burst ?? 1) > 1 ? `×${w.burst}` : ''} dmg every ${w.cooldown} s · range ${w.range} · ${((w.damage * (w.burst ?? 1)) / w.cooldown).toFixed(1)} dps`

/** Friendly names for parts, by the start of their id (the more specific first). */
const PART_NAMES: [string, string][] = [
  // The warships (proto.ts).
  ['armour', 'Armour plate'], ['cup', 'Gun socket'], ['launch', 'Hangar pad'], ['gallery', 'Hangar gallery'], ['barbette', 'Turret barbette'], ['seat', 'Turret pad'], ['command', 'Command tower'],
  ['tier', 'Superstructure tier'], ['superBase', 'Superstructure'], ['aux', 'Auxiliary engine'], ['array', 'Antenna array'],
  ['socket', 'Socket'], ['hull', 'Hull plating'], ['tip', 'Wing tip'], ['wing', 'Wing'], ['gunF', 'Blaster barrels'], ['podGun', 'Gun pod barrels'], ['gun', 'Cannon'],
  ['strake', 'Canard'], ['fuse', 'Fuselage'], ['droid', 'Astromech socket'], ['cockpit', 'Cockpit'], ['engine', 'Engine'], ['deck', 'Deck'],
  ['rail', 'Deck rail'], ['block', 'Block'], ['bridge', 'Bridge'], ['tower', 'Bridge tower'], ['mast', 'Antenna mast'], ['dish', 'Sensor dish'],
  ['hookC', 'Crane hook'], ['shoulder', 'Shoulder'], ['tail', 'Tail'], ['head', 'Head'], ['eye', 'Sensor eye'], ['skirt', 'Hull skirt'],
  ['spire', 'Command spire'], ['fin', 'Fin'], ['beacon', 'Spire beacon'], ['strut', 'Strut'], ['bar', 'Outer frame'], ['bastion', 'Corner bastion'],
  ['girder', 'Girder'], ['brace', 'Brace'], ['far', 'Far pod'], ['dock', 'Dry dock'], ['rack', 'Torpedo rack'], ['bay', 'Bomb bay'],
  ['fore', 'Forearm'], ['crane', 'Crane boom'], ['ball', 'Ball turret'], ['flak', 'Flak turret'], ['sponson', 'Shield sponson'], ['trench', 'Flight deck'],
  ['antenna', 'Antenna'], ['foot', 'Anchor foot'], ['pad', 'Landing pad'], ['neck', 'Neck'], ['base', 'Turret base'], ['belt', 'Ore conveyor'],
  ['frame', 'Deck frame'], ['spoke', 'Spoke'], ['outrigger', 'Outrigger'], ['hopper', 'Ammunition hopper'], ['cap', 'Capacitor bank'],
  ['body', 'Body'], ['abdomen', 'Abdomen'], ['thorax', 'Thorax'], ['cord', 'Spinal cord'], ['prong', 'Ion prong'], ['focus', 'Ion focus'],
  ['seg', 'Vertebra'], ['shell', 'Shell case'], ['seam', 'Shell seam'], ['rib', 'Rib'], ['trail', 'Trailing edge'], ['spar', 'Wing spar'],
  ['tractor', 'Tractor projector'], ['stalk', 'Stalk'], ['link', 'Link'], ['bulb', 'Gun bulb'], ['dome', 'Dome'], ['rim', 'Carapace rim'],
  ['node', 'Side node'], ['cradle', 'Gun cradle'], ['spike', 'Capacitor spine'], ['knuckle', 'Knuckle pod'], ['joint', 'Joint'], ['iris', 'Iris'],
  ['thread', 'Silk thread'], ['strut', 'Strut'], ['legF', 'Front leg'], ['legM', 'Middle leg'], ['legB', 'Hind leg'], ['web', 'Web strand'],
]
/** The droid navy's own parts (droid.ts), where its ids mean something else than the Swarm's or
 * the Republic's. */
const DROID_NAMES: [string, string][] = [
  ['visor', 'Sensor visor'], ['blade', 'Blade'], ['vane', 'Vane'], ['sail', 'Sail fin'], ['tipFin', 'Gallery fin'], ['gallery', 'Gun gallery'],
  ['jaw', 'Docking jaw'], ['hangar', 'Hangar segment'], ['clamp', 'Docking clamp'], ['sphere', 'Core sphere'], ['core', 'Core sphere'],
  ['housing', 'Drill housing'], ['side', 'Side pod'], ['crate', 'Ammunition crate'], ['bulb', 'Forward bulb'], ['spike', 'Ion spike'],
  ['plate', 'Armour plate'], ['ring', 'Ring hull'], ['tower', 'Gun tower'], ['spire', 'Antenna spire'], ['frame', 'Outer frame'],
  ['collar', 'Collar'], ['gunbox', 'Gun box'], ['claw', 'Claw'],
]

/** A part's name from its faction's own table (FactionModels partName and partNames), if it has one. */
function ownName(m: Model, id: string, t: UnitType) {
  const own = factionModels(m.faction)
  const byFn = own.partName?.(id, t)
  if (byFn) return byFn
  let best: [string, string] | undefined
  for (const pair of own.partNames ?? []) if (id.startsWith(pair[0]) && (!best || pair[0].length > best[0].length)) best = pair
  return best?.[1]
}

/** What the Codex calls part `i` of a model: its faction's own name for it (models/<faction>/
 * index.ts `partNames`), else the shared names below, else its id. */
export function partName(m: Model, i: number, t: UnitType) {
  const id = m.parts[i].id
  const own = ownName(m, id, t)
  if (own) return own
  const station = t.tier === 'station'
  const structure = t.tier === 'mine' || t.tier === 'defense' || t.tier === 'yard'
  // Some parts are named by the unit they are on: the Confederacy's, and the Swarm's in the same
  // slot (its concept designs were first drawn on the Confederacy's units).
  const like = (slot: string) => t.faction !== 'republic' && t.id.slice(t.id.indexOf('-') + 1) === slot
  if (m.faction === 'droid') {
    if (id.startsWith('pod') && !id.startsWith('podGun')) return station ? 'Gun pod' : like('repair') ? 'Tool pod' : like('gunship') ? 'Cannon pod' : 'Engine block'
    if (/Strut$/.test(id)) return 'Strut'
    if (id.startsWith('arm')) return station ? 'Docking arm' : like('gunship') ? 'Gun arm' : 'Manipulator arm'
    if (id.startsWith('frame') && !station) return 'Bay frame'
    if (id.startsWith('claw')) return structure ? 'Anchor claw' : 'Manipulator claw'
    if (id.startsWith('block') || id.startsWith('engine')) return 'Engine block'
    if (/^(wing|leg)[LR].*Knee$/.test(id)) return 'Knee joint'
    if (/^(wing|leg)[LR].*Gun$/.test(id)) return 'Blaster'
    if (/^wing[LR]/.test(id)) return 'Wing-leg'
    if (/^leg[LR]/.test(id)) return 'Rear wing-leg'
    const hit = DROID_NAMES.find(([p]) => id.startsWith(p))
    if (hit) return hit[1]
  }
  if (id.startsWith('podGun')) return 'Gun pod barrels'
  if (id.startsWith('pod')) return station ? 'Docking pod' : like('bomber') ? 'Bomb pod' : like('gunship') ? 'Gun pod' : 'Engine pod'
  if (id.startsWith('block') && station) return id === 'block' ? 'Command block' : 'Frame block'
  if (id.startsWith('deck') && station) return 'Deck plate'
  if (id.startsWith('well')) return t.tier === 'mine' ? 'Drill well' : 'Repair bay'
  if (id.startsWith('ring')) return like('picket') ? 'Guard ring' : 'Repair ring'
  if (id.startsWith('hub')) return structure ? 'Hub' : 'Repair hub'
  if (id.startsWith('claw')) return structure ? 'Anchor claw' : like('fighter') ? 'Claw wing' : like('capital') ? 'Arm claw' : 'Manipulator claw'
  if (id.startsWith('hook') && !id.startsWith('hookC')) return like('cruiser') ? 'Wing hook' : 'Lower claw'
  if (id.startsWith('arm')) return station ? (t.faction !== 'republic' ? 'Arm segment' : 'Arm') : t.id === 'r-repair' ? 'Manipulator arm' : like('gunship') ? 'Gun arm' : like('capital') ? 'Hangar arm' : 'Girder arm'
  if (id.startsWith('leg') && !/^leg[FMB]/.test(id)) return structure ? 'Anchor leg' : 'Leg'
  if (id.startsWith('plate')) return station ? 'Shell plate' : 'Leg plate'
  if (id.startsWith('core')) return 'Hive core'
  if (id.startsWith('collar')) return station ? 'Hive collar' : 'Gun collar'
  if (id.startsWith('crown')) return station ? 'Spire crown' : 'Bridge crown'
  if (id.startsWith('fin') && station) return 'Spire fin'
  if (id.startsWith('horn')) return station ? 'Arm bud' : 'Horn'
  if (id.startsWith('spine')) return /^spine\d/.test(id) ? 'Side spine' : 'Spine'
  if (id.startsWith('sac')) return structure ? 'Ammunition sac' : 'Hive sac'
  if (id.startsWith('web')) return like('cruiser') ? 'Wing membrane' : 'Web strand'
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
  // An expansion module (hybrid bases): what it does, and what losing it costs.
  if (h.exp) {
    const x = MODULE[h.exp]
    return {
      title: `${x.name} #${s.hp + 1}`,
      kind: `Expansion of the ${WORKS_NAME[x.on]}`,
      hp: h.hp,
      does: x.blurb,
      lost: `${x.lost} Engineers weld it back for ${Math.round(REBUILD_MODULE * 100)}% of its price (${Math.round(x.cost * REBUILD_MODULE)} credits).`,
      off: 'Comes off with its girder when destroyed: a burnt socket stays.',
    }
  }
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

/** One of a unit's faction mechanics (sim.ts; see "Faction mechanics" in README.md), as the Codex,
 * the unit cards and their tips show it: a short name, a value, and the whole story for the tip. */
export type Trait = { name: string; value: string; tip: string }
const pc = (v: number) => `${Math.round(v * 100)}%`

/** What sets a unit apart beyond its numbers: living hull, drain, fire control, a spinal gun, a
 * brood or carrier, no shields. Empty for most units. */
export function traits(t: UnitType): Trait[] {
  const out: Trait[] = []
  if (t.regrow) out.push({ name: 'Living hull', value: `+${pc(t.regrow.rate)}/s`, tip: `Living hull: out of the fight for ${t.regrow.delay} s (no enemy has hit it), its hull grows back by ${pc(t.regrow.rate)} of its full hull a second. Shot-off modules don't grow back.` })
  if (t.drain) out.push({ name: 'Drain', value: `${Math.round(t.drain.dps)}/s`, tip: `Drain: every enemy it sees within ${Math.round(t.drain.radius)} loses ${Math.round(t.drain.dps)} hull a second, straight past its shields; ${pc(t.drain.heal)} of what it drains mends our damaged ships in reach, shared out.` })
  if (t.fireControl) out.push({ name: 'Fire control', value: `+${pc(t.fireControl.bonus)}`, tip: `Fire control: our ships within ${Math.round(t.fireControl.radius)}, itself included, hit ${pc(t.fireControl.bonus)} harder. Auras don't stack: the best one counts.` })
  const spine = [...t.weapons, ...t.hardpoints.flatMap((h) => (h.weapon ? [h.weapon] : []))].find((x) => x.spinal)
  if (spine) {
    const deg = Math.round(((spine.arc ?? 0) * 180) / Math.PI)
    out.push({ name: 'Spinal gun', value: `±${deg}°`, tip: `Spinal ${WEAPON_NAME[spine.kind].toLowerCase()}: built along the keel, it only fires within ${deg}° either side of the nose, so the whole ship turns to aim it. It can't answer what is behind it.` })
  }
  if (t.tier === 'station' && t.carrier) out.push({ name: 'Brood', value: `every ${t.carrier.every} s`, tip: `Brood spawning: the station grows a squadron of ${UNIT[t.carrier.unit]?.name ?? 'strike craft'} every ${t.carrier.every} s while fewer than ${t.carrier.max} of them are out, beside its defense wing.` })
  else if (t.carrier) out.push({ name: 'Carrier', value: `every ${t.carrier.every} s`, tip: `Carrier: launches a squadron every ${t.carrier.every} s from its hangars while fewer than ${t.carrier.max} are out; with every hangar shot off it launches no more.` })
  if (!t.shield && !t.hardpoints.some((h) => h.kind === 'shield') && t.tier !== 'fighter' && t.tier !== 'mine') out.push({ name: 'No shields', value: 'armour only', tip: 'No shields: every hit goes straight to its hull and modules. Ion weapons barely scratch it, and shield research does nothing for it.' })
  return out
}
