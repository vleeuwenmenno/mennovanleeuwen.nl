import { LEVEL_UP, SITE_UPGRADES, TECH, UNIT, type SiteUpgradeId } from './data.ts'
import type { Pt } from './maps.ts'
import {
  STANCES, cmdAbility, cmdArea, cmdAttack, cmdBuild, cmdCancel, cmdCancelResearch, cmdDeploy, cmdFace, cmdFocus, cmdGuard, cmdLine, cmdMove, cmdPatrol, cmdRally, cmdRepair, cmdResearch,
  cmdRetreat, cmdSite, cmdStance, cmdStop, cmdUpgradeSite, cmdPlace, cmdConstruct, cmdCancelSite, type Owner, type Stance, type World,
} from './sim.ts'

// Every order a player can give, as data: a name and its arguments. In multiplayer an order goes to
// the server, which cleans it (right types, sane sizes, inside the map) and sends it to everyone
// to run at the same tick; a malformed order from a tampered client never reaches anyone. The
// owner is never part of an order: the server fills in the sender's own seat.

type Arg = 'ids' | 'id' | 'int' | 'x' | 'y' | 'num' | 'bool' | 'unit' | 'tech' | 'upgrade' | 'stance' | 'path'

/** The functions, by order name, with what each argument must be. */
const TABLE = {
  move: { run: cmdMove, args: ['ids', 'x', 'y', 'bool', 'bool'] },
  line: { run: cmdLine, args: ['ids', 'path', 'bool', 'bool'] },
  face: { run: cmdFace, args: ['ids', 'x', 'y', 'num', 'bool', 'bool'] },
  patrol: { run: cmdPatrol, args: ['ids', 'x', 'y', 'bool'] },
  area: { run: cmdArea, args: ['ids', 'x', 'y', 'num', 'bool'] },
  focus: { run: cmdFocus, args: ['ids', 'id', 'int', 'bool'] },
  guard: { run: cmdGuard, args: ['ids', 'id'] },
  stance: { run: cmdStance, args: ['ids', 'stance'] },
  attack: { run: cmdAttack, args: ['ids', 'id', 'int', 'bool', 'bool'] },
  stop: { run: cmdStop, args: ['ids'] },
  ability: { run: cmdAbility, args: ['ids', 'id'] },
  rally: { run: cmdRally, args: ['x', 'y', 'id'] },
  upgradeSite: { run: cmdUpgradeSite, args: ['id', 'upgrade'] },
  repair: { run: cmdRepair, args: ['id'] },
  retreat: { run: cmdRetreat, args: ['ids'] },
  build: { run: cmdBuild, args: ['unit', 'bool', 'id'] },
  deploy: { run: cmdDeploy, args: ['unit', 'x', 'y', 'num'] },
  cancel: { run: cmdCancel, args: ['int', 'id'] },
  research: { run: cmdResearch, args: ['tech'] },
  cancelResearch: { run: cmdCancelResearch, args: ['int'] },
  site: { run: cmdSite, args: ['int', 'unit'] },
  // Hybrid bases: engineers place a yard, build or repair a structure; a site can be called off.
  place: { run: cmdPlace, args: ['ids', 'unit', 'x', 'y', 'bool'] },
  construct: { run: cmdConstruct, args: ['ids', 'id', 'bool'] },
  cancelSite: { run: cmdCancelSite, args: ['id'] },
} as const satisfies Record<string, { run: (w: World, owner: Owner, ...a: never[]) => unknown; args: readonly Arg[] }>

export type CmdName = keyof typeof TABLE
/** The arguments of an order, after the world and owner. */
export type CmdArgs<K extends CmdName> = (typeof TABLE)[K]['run'] extends (w: World, owner: Owner, ...a: infer A) => unknown ? A : never
/** What running an order answers. */
export type CmdResult<K extends CmdName> = ReturnType<(typeof TABLE)[K]['run']>
/** An order on the wire: its name and arguments. */
export type Cmd = { f: CmdName; a: unknown[] }

const MAX_IDS = 400
const MAX_PATH = 256
const MAX_ID = 1e9

const int = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : null)
const num = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null)

function cleanArg(kind: Arg, v: unknown, w: World): unknown {
  switch (kind) {
    case 'ids': {
      if (!Array.isArray(v) || v.length > MAX_IDS) return null
      const out = v.map((x) => int(x, 1, MAX_ID))
      return out.every((x) => x !== null) ? out : null
    }
    case 'id':
      // Left out, it's 0: no unit (an ability fired without a target).
      return v === undefined ? 0 : int(v, 0, MAX_ID)
    case 'int':
      // Left out, it's the -1 the sim's own defaults use (no hardpoint, no index).
      return v === undefined ? -1 : int(v, -1, 1000)
    case 'x':
      return num(v, 0, w.w)
    case 'y':
      return num(v, 0, w.h)
    case 'num':
      return num(v, -1e4, 1e4)
    case 'bool':
      return v === undefined ? false : typeof v === 'boolean' ? v : null
    case 'unit':
      return typeof v === 'string' && Object.hasOwn(UNIT, v) ? v : null
    case 'tech':
      return typeof v === 'string' && (v === LEVEL_UP || Object.hasOwn(TECH, v)) ? v : null
    case 'upgrade':
      return typeof v === 'string' && SITE_UPGRADES.some((u) => u.id === v) ? (v as SiteUpgradeId) : null
    case 'stance':
      return typeof v === 'string' && STANCES.includes(v as Stance) ? v : null
    case 'path': {
      if (!Array.isArray(v) || v.length < 2 || v.length > MAX_PATH) return null
      const out: Pt[] = []
      for (const p of v) {
        const x = num((p as Pt)?.x, 0, w.w)
        const y = num((p as Pt)?.y, 0, w.h)
        if (x === null || y === null) return null
        out.push({ x, y })
      }
      return out
    }
  }
}

/** An order as received, made safe to run, or null when it isn't one. */
export function cleanCmd(raw: unknown, w: World): Cmd | null {
  if (!raw || typeof raw !== 'object') return null
  const { f, a } = raw as { f?: unknown; a?: unknown }
  if (typeof f !== 'string' || !Object.hasOwn(TABLE, f) || !Array.isArray(a)) return null
  const spec = TABLE[f as CmdName].args
  if (a.length > spec.length) return null
  const out: unknown[] = []
  for (let i = 0; i < spec.length; i++) {
    const v = cleanArg(spec[i], a[i], w)
    if (v === null) return null
    out.push(v)
  }
  return { f: f as CmdName, a: out }
}

/** Runs an order for `owner`. What comes back is the function's own answer: a reason it couldn't
 * be done (a string), a count (abilities used), or nothing. */
export function runCmd(w: World, owner: Owner, c: Cmd): unknown {
  const run = TABLE[c.f].run as (w: World, owner: Owner, ...a: unknown[]) => unknown
  return run(w, owner, ...c.a)
}

/** A drawn line with at most `max` points, evenly picked, keeping both ends: a long drag has
 * more points than an order may carry. */
export function thinPath(path: Pt[], max = MAX_PATH): Pt[] {
  if (path.length <= max) return path
  return Array.from({ length: max }, (_, i) => path[Math.round((i * (path.length - 1)) / (max - 1))])
}

/** An order to send, built with the same arguments the sim function takes. */
export const cmd = <K extends CmdName>(f: K, ...a: CmdArgs<K>): Cmd => ({ f, a })
