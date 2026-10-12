// The format procedural ship and station models are written in. No DOM here: the headless model
// check (scripts/empires-models.ts) builds every model in Node, and only models/paint.ts and
// models/fx.ts touch a canvas.
//
// Model space: the origin is the middle of the unit's box (dims() in data.ts), x runs right and y
// runs down, so the nose of a ship points at negative y, the way the sprites face. Ships are
// drawn on a box whose long side is 100 units; a station uses the pixels of the frame its sprites
// were cut from, so its modules can be placed exactly where data.ts puts them.

export type Pt = [number, number]

/**
 * The colour roles a part can be painted in. Each faction's palette gives every role three cel
 * tones (lit, base and shadow), and which one a part gets depends on how its facet faces the
 * light, recomputed as the ship turns.
 */
export type Tone = 'hull' | 'hull2' | 'accent' | 'metal' | 'dark' | 'glass' | 'glow' | 'char' | 'ember' | 'aid' | 'trim'

/** Surface detail drawn on top of a part and clipped to it. */
export type Detail =
  /** A panel line: a thin darker stroke. */
  | { k: 'line'; pts: Pt[]; w?: number }
  /** An inlay or stripe in another tone, shaded with the part's facet (a red band on the shadow
   * side of the hull turns dark red with it). */
  | { k: 'shape'; pts: Pt[]; tone: Tone }
  /** Windows or running lights: small glowing squares that ignore the lighting. */
  | { k: 'lights'; pts: Pt[]; r: number; tone?: Tone }

/** Why a part can come off. `hp`: when that hardpoint is destroyed; `hull`: once the hull falls
 * below this share; `death`: only when the whole unit goes (fighter wings, for the fragments). */
export type Detach = { hp?: number; hull?: number; death?: boolean }

export type Part = {
  id: string
  /** The outline, as a closed polygon; empty for a part that is only details (glints, lights). */
  pts: Pt[]
  /** Holes cut out of it (a ring), filled even-odd. */
  holes?: Pt[][]
  tone: Tone
  /** Drawing order: higher sits on top. */
  z: number
  /**
   * The way a sloped facet faces, for the cel shading: the left half of a wedge hull faces left
   * ([-0.6, 0]). Lit when it faces the light, in shadow when it faces away, flat (base tone) when
   * it is missing or the light comes from the side.
   */
  slope?: Pt
  /** Facets inside the part, each shaded for the way it faces (a cylinder's two sides, a dome's
   * quarters), so one part can be round and still break off whole. */
  facets?: { pts: Pt[]; slope: Pt }[]
  /** How far it stands above what is under it, in model units: it throws a hard drop shadow away
   * from the light and gets a lit rim and a shadow rim. */
  lift?: number
  /** A round part shaded as a ball: a lit crescent towards the light, a shadow crescent away. */
  sphere?: boolean
  details?: Detail[]
  detach?: Detach
  /** The engine glow (index into the unit's `engines`) this part carries: it goes dark with it. */
  engine?: number
  /** Glows by itself: never shaded or scorched. */
  glow?: boolean
  /** Left out of the outline pass (thin trim, lights). */
  noOutline?: boolean
  /** Only on a station from this level up. */
  level?: number
}

/**
 * What sits on a hardpoint: a turret, shield generator, hangar or station module. Mounts are
 * painted on their own (turrets turn to aim), one per hardpoint, in the unit's hardpoint order.
 */
export type MountDesign = 'flak' | 'turbo' | 'ion' | 'shield' | 'hangar' | 'refinery' | 'dock' | 'sensor' | 'drill' | 'engine'
export type Mount = {
  /** The hardpoint's index in the unit's `hardpoints`. */
  hp: number
  x: number
  y: number
  /** Radius in model units. */
  r: number
  design: MountDesign
  /** Turns to aim (weapons); otherwise it keeps the hull's heading. */
  turns: boolean
  /** Blown off when destroyed (flies away as debris, leaving a burnt socket); otherwise it stays
   * on the hull, broken and burnt. */
  detach: boolean
}

/** How a hull comes apart: cut across in bands (long ships) or into wedges round the middle
 * (round stations). */
export type BreakStyle = 'bands' | 'pie'
export type BreakKind = 'intact' | 'half' | 'pieces'

/** A scorch mark's spot, and the hull damage level (1-3) from which it shows. */
export type Scorch = { x: number; y: number; r: number; level: number; seed: number }

/** A built model, ready to paint: mirrored parts expanded, sorted by z, mounts placed on the
 * unit's own hardpoints. */
export type Model = {
  /** The unit type it was built for (a station's level and modules make it a type of its own). */
  key: string
  /** Whose look it has: its palette and mount style. 'swarm' is the concept kit (swarm.ts), shown
   * only in the Codex. */
  faction: 'republic' | 'droid' | 'swarm'
  /** The box in model units (the unit's dims, scaled). */
  w: number
  h: number
  /** Model units per world unit's worth of the unit's size: size / max(w, h) world units each. */
  long: number
  parts: Part[]
  mounts: Mount[]
  /** Engine glow spots, in model units, in the order of the unit's `engines`. */
  engines: Pt[]
  /** Indices into `parts` of everything that can come off, in a fixed order (bit i of a state's
   * `detached` mask is the i-th of these). */
  detachable: number[]
  breakStyle: BreakStyle
  scorch: Scorch[]
  /** A number unique to the design, seeding its scorch marks and break lines. */
  seed: number
}

/** What a hull looks like right now, everything the cached bitmaps depend on. */
export type HullState = {
  /** Bit i set: `model.detachable[i]` is gone. */
  detached: number
  /** 0 clean, 3 badly burnt (hull under a quarter). */
  scorch: number
  /** Which of four scorch layouts, so a fleet doesn't share one set of burns. */
  variant: number
}
