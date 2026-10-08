import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { forgejoActivity } from './server/activity.ts'
import { githubCommits } from './server/github.ts'
import { minecraftStatus } from './server/minecraft.ts'

/** /api/minecraft and /api/activity during `pnpm dev` and `pnpm preview`, like server/index.ts in production. */
const liveApi = (): Plugin => {
  const handler = (req: { url?: string }, res: import('node:http').ServerResponse, next: () => void) => {
    const path = req.url?.split('?')[0]
    if (path?.startsWith('/api/git/')) {
      githubCommits(req.url!.slice('/api/git/'.length)).then((r) => {
        res.statusCode = r.status
        res.setHeader('Content-Type', 'application/json')
        res.end(r.body)
      })
      return
    }
    if (path !== '/api/minecraft' && path !== '/api/activity') return next()
    ;(path === '/api/minecraft' ? minecraftStatus() : forgejoActivity().then((items) => ({ items }))).then((s) => {
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('Cache-Control', 'no-store')
      res.end(JSON.stringify(s))
    })
  }
  return {
    name: 'live-api',
    configureServer: (server) => void server.middlewares.use(handler),
    configurePreviewServer: (server) => void server.middlewares.use(handler),
  }
}

/**
 * Builds dist/sw.js from pwa/sw.js with this build's files to precache and a version derived from
 * them, so each release ships a new worker and installed copies are offered the update.
 */
const serviceWorker = (): Plugin => ({
  name: 'mvlos-sw',
  apply: 'build',
  generateBundle(_, bundle) {
    const built = Object.keys(bundle).filter((f) => !f.endsWith('.map') && f !== 'index.html').map((f) => `/${f}`)
    const statics = ['/', '/favicon.svg', '/manifest.webmanifest', '/icons/app.svg', '/icons/app-192.png', '/icons/boltwarden.svg', '/recents.json', '/contributions.json']
    const precache = [...statics, ...built]
    const version = createHash('sha256').update(precache.join('\n')).digest('hex').slice(0, 12)
    const source = readFileSync(new URL('./pwa/sw.js', import.meta.url), 'utf8').replace('__VERSION__', version).replace('__PRECACHE__', JSON.stringify(precache))
    this.emitFile({ type: 'asset', fileName: 'sw.js', source })
  },
})

export default defineConfig({
  plugins: [react(), liveApi(), serviceWorker()],
  // Listen on all interfaces so the dev site can be opened from a phone over Tailscale or LAN.
  server: { host: '0.0.0.0', allowedHosts: ['.ts.net'] },
  preview: { host: '0.0.0.0', allowedHosts: ['.ts.net'] },
})
