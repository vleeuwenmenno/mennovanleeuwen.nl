// The site's Vite dev server, for the perf check: development mode (the scenes reach into the game
// through its modules and the dev-only window.__ew), localhost only, and none of the live API or
// background services that vite.config.ts starts: /api answers 404, so a run never depends on the
// network or on what's in .env.
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { createServer, type Plugin, type ViteDevServer } from 'vite'
import react from '@vitejs/plugin-react'

const noApi = (): Plugin => ({
  name: 'perf-no-api',
  configureServer: (server) => {
    server.middlewares.use((req, res, next) => {
      if (!req.url?.startsWith('/api/') && req.url !== '/api') return next()
      res.statusCode = 404
      res.setHeader('content-type', 'application/json')
      res.end('{"error":"not in the perf check"}')
    })
  },
})

export async function startServer(root: string): Promise<{ url: string; server: ViteDevServer }> {
  const server = await createServer({
    configFile: false,
    root,
    // Its own dependency cache, apart from `pnpm dev`'s.
    cacheDir: join(tmpdir(), `mvlos-perf-vite-${createHash('sha1').update(root).digest('hex').slice(0, 8)}`),
    plugins: [react(), noApi()],
    define: { __APP_VERSION__: '"perf"', __APP_COMMIT__: '"perf"', __BUILD_TIME__: '"2026-01-01T00:00:00Z"' },
    server: { host: '127.0.0.1', port: Number(process.env.PERF_PORT ?? 0), strictPort: true, hmr: false, watch: null },
    logLevel: 'error',
    clearScreen: false,
  })
  await server.listen()
  const { port } = server.httpServer!.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}`, server }
}
