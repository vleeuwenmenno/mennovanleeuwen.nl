// Loads ground battles: the sim's part (world.ts fills sim.ts's GroundHooks when imported), the
// ground units' models (models/ground.ts, into the model lookup) and the screen's (groundKit.ts).
// Only the dev lobby's Ground switch, a ground battle being resumed in a dev build, and the perf
// scene import it, each through a dynamic import behind import.meta.env.DEV, so a production build
// carries none of it.

import './world.ts'
import '../models/ground.ts'
import { setGroundKit } from '../groundKit.ts'
import { createGroundLayer } from './gl.ts'
import { screenKit } from './screen.ts'

/** Ground battles, ready to play: resolves once every part is loaded. The ground is drawn by the
 * WebGL2 layer (gl.ts), which falls back to a flat 2D picture where WebGL2 is missing. */
export async function loadGround() {
  setGroundKit(screenKit(() => createGroundLayer()))
}
