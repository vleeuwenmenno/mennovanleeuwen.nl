import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { forgejoActivity } from './server/activity.ts'
import { minecraftStatus } from './server/minecraft.ts'

/** /api/minecraft and /api/activity during `pnpm dev` and `pnpm preview`, like server/index.ts in production. */
const liveApi = (): Plugin => {
  const handler = (req: { url?: string }, res: import('node:http').ServerResponse, next: () => void) => {
    const path = req.url?.split('?')[0]
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

export default defineConfig({
  plugins: [react(), liveApi()],
  // Listen on all interfaces so the dev site can be opened from a phone over Tailscale or LAN.
  server: { host: '0.0.0.0', allowedHosts: ['.ts.net'] },
  preview: { host: '0.0.0.0', allowedHosts: ['.ts.net'] },
})
