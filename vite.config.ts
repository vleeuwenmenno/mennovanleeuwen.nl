import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { minecraftStatus } from './server/minecraft.ts'

/** /api/minecraft during `pnpm dev` and `pnpm preview`, like server/index.ts in production. */
const minecraftApi = (): Plugin => {
  const handler = (req: { url?: string }, res: import('node:http').ServerResponse, next: () => void) => {
    if (req.url?.split('?')[0] !== '/api/minecraft') return next()
    minecraftStatus().then((s) => {
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('Cache-Control', 'no-store')
      res.end(JSON.stringify(s))
    })
  }
  return {
    name: 'minecraft-api',
    configureServer: (server) => void server.middlewares.use(handler),
    configurePreviewServer: (server) => void server.middlewares.use(handler),
  }
}

export default defineConfig({
  plugins: [react(), minecraftApi()],
  // Listen on all interfaces so the dev site can be opened from a phone over Tailscale or LAN.
  server: { host: '0.0.0.0', allowedHosts: ['.ts.net'] },
  preview: { host: '0.0.0.0', allowedHosts: ['.ts.net'] },
})
