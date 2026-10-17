// Loads ground battles: the sim's part (world.ts fills sim.ts's GroundHooks when imported), the
// ground units' models (models/ground.ts, into the model lookup) and the screen's (groundKit.ts).
// Only the dev lobby's Ground switch, a ground battle being resumed in a dev build, and the perf
// scene import it, each through a dynamic import behind import.meta.env.DEV, so a production build
// carries none of it.

import './world.ts'
import '../models/ground.ts'
import { setGroundKit } from '../groundKit.ts'
import { createGroundLayer2d } from './layer2d.ts'
import { screenKit } from './screen.ts'
import type { GroundLayer } from './types.ts'

// The WebGL2 layer (gl.ts, createGroundLayer) once it is in; until then the 2D chunk renderer.
const gl = import.meta.glob<{ createGroundLayer: () => GroundLayer }>('./gl.ts')
let make: () => GroundLayer = createGroundLayer2d

/** Ground battles, ready to play: resolves once every part is loaded. */
export async function loadGround() {
  const mod = gl['./gl.ts']
  if (mod) {
    const { createGroundLayer } = await mod()
    if (createGroundLayer) make = createGroundLayer
  }
  setGroundKit(screenKit(() => make()))
}
