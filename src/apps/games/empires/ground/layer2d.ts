import { GroundRenderer } from './render.ts'
import type { GroundLayer, GroundMap } from './types.ts'

// A stand-in GroundLayer until the WebGL2 one (gl.ts) is in: the 2D chunk renderer (render.ts)
// drawing into a canvas of its own, under the battle canvas. Past the map's edge it is left dark.
// Trees, which render.ts draws over units, are under them here (the battle canvas is on top).

/** What the perf scene reads besides the layer: when its pictures are in, and its chunk cache's size. */
export type GroundLayer2d = GroundLayer & { readonly ready: Promise<void>; readonly cacheBytes: number }

export function createGroundLayer2d(): GroundLayer2d {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')!
  let r: GroundRenderer | null = null
  return {
    canvas,
    gl: false,
    get ready() {
      return r?.ready ?? Promise.resolve()
    },
    get cacheBytes() {
      return r?.cacheBytes ?? 0
    },
    setMap(map: GroundMap) {
      r = new GroundRenderer(map, matchMedia('(pointer: coarse)').matches ? { budget: 24 << 20 } : {})
    },
    draw(cam, w, h, dpr) {
      const pw = Math.max(1, Math.round(w * dpr))
      const ph = Math.max(1, Math.round(h * dpr))
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw
        canvas.height = ph
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.fillStyle = '#0b0d0c'
      ctx.fillRect(0, 0, pw, ph)
      r?.draw(ctx, { x: cam.x, y: cam.y, zoom: cam.zoom, w, h, dpr })
    },
    dispose() {
      r = null
    },
  }
}
