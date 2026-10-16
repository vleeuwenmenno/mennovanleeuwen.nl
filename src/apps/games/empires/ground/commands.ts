import { cmdCancel, cmdConstruct, cmdPlace, cmdRally, cmdTrain } from './build.ts'
import { GROUND_UNIT, cmdMove, cmdStop, type GroundWorld, type Owner } from './sim.ts'

// Every order a player can give in a ground battle, as data: a name and its arguments, in the same
// pattern as the space game's ../commands.ts. In multiplayer an order goes to the server, which
// cleans it (right types, sane sizes, inside the map) and sends it to everyone to run at the same
// tick. The owner is never part of an order: the server fills in the sender's own seat.

type Arg = 'ids' | 'id' | 'int' | 'x' | 'y' | 'bool' | 'type'

/** The functions, by order name, with what each argument must be. */
const TABLE = {
  // Move: units, where to, and whether it goes after their orders (shift).
  move: { run: cmdMove, args: ['ids', 'x', 'y', 'bool'] },
  stop: { run: cmdStop, args: ['ids'] },
  // Building and training (build.ts): engineers place a building or build one of ours, a
  // structure trains units (count: 1, or 5 with shift), a queue item or a site is called off, and
  // a structure's rally point.
  place: { run: cmdPlace, args: ['ids', 'type', 'x', 'y', 'bool'] },
  construct: { run: cmdConstruct, args: ['ids', 'id', 'bool'] },
  train: { run: cmdTrain, args: ['id', 'type', 'int'] },
  cancel: { run: cmdCancel, args: ['id', 'int'] },
  rally: { run: cmdRally, args: ['id', 'x', 'y'] },
} as const satisfies Record<string, { run: (w: GroundWorld, owner: Owner, ...a: never[]) => unknown; args: readonly Arg[] }>

export type GroundCmdName = keyof typeof TABLE
/** The arguments of an order, after the world and owner. */
export type GroundCmdArgs<K extends GroundCmdName> = (typeof TABLE)[K]['run'] extends (w: GroundWorld, owner: Owner, ...a: infer A) => unknown ? A : never
/** An order on the wire: its name and arguments. */
export type GroundCmd = { f: GroundCmdName; a: unknown[] }

const MAX_IDS = 400
const MAX_ID = 1e9

const int = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : null)
const num = (v: unknown, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null)

function cleanArg(kind: Arg, v: unknown, w: GroundWorld): unknown {
  switch (kind) {
    case 'ids': {
      if (!Array.isArray(v) || v.length > MAX_IDS) return null
      const out = v.map((x) => int(x, 1, MAX_ID))
      return out.every((x) => x !== null) ? out : null
    }
    case 'id':
      return int(v, 1, MAX_ID)
    case 'int':
      return int(v, -1, 1000)
    case 'type':
      return typeof v === 'string' && Object.hasOwn(GROUND_UNIT, v) ? v : null
    case 'x':
      return num(v, 0, w.w)
    case 'y':
      return num(v, 0, w.h)
    case 'bool':
      return v === undefined ? false : typeof v === 'boolean' ? v : null
  }
}

/** An order as received, made safe to run, or null when it isn't one. */
export function cleanGroundCmd(raw: unknown, w: GroundWorld): GroundCmd | null {
  if (!raw || typeof raw !== 'object') return null
  const { f, a } = raw as { f?: unknown; a?: unknown }
  if (typeof f !== 'string' || !Object.hasOwn(TABLE, f) || !Array.isArray(a)) return null
  const spec = TABLE[f as GroundCmdName].args
  if (a.length > spec.length) return null
  const out: unknown[] = []
  for (let i = 0; i < spec.length; i++) {
    const v = cleanArg(spec[i], a[i], w)
    if (v === null) return null
    out.push(v)
  }
  return { f: f as GroundCmdName, a: out }
}

/** Runs an order for `owner`. What comes back is the function's own answer. */
export function runGroundCmd(w: GroundWorld, owner: Owner, c: GroundCmd): unknown {
  const run = TABLE[c.f].run as (w: GroundWorld, owner: Owner, ...a: unknown[]) => unknown
  return run(w, owner, ...c.a)
}

/** An order to send, built with the same arguments the sim function takes. */
export const groundCmd = <K extends GroundCmdName>(f: K, ...a: GroundCmdArgs<K>): GroundCmd => ({ f, a })
