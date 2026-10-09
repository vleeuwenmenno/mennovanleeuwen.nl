import { createHash } from 'node:crypto'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { handleApi } from './server/api.ts'
import { startMinecraftWatch } from './server/minecraft.ts'

/** The /api routes during `pnpm dev` and `pnpm preview`, like server/index.ts in production. */
const liveApi = (): Plugin => {
  const handler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, next: () => void) => {
    handleApi(req, res).then((handled) => handled || next(), next)
  }
  return {
    name: 'live-api',
    configureServer: (server) => {
      server.middlewares.use(handler)
      startMinecraftWatch()
    },
    configurePreviewServer: (server) => {
      server.middlewares.use(handler)
      startMinecraftWatch()
    },
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

/** Release builds get APP_VERSION/APP_COMMIT from the workflow; local ones ask git. */
const git = (cmd: string) => {
  try {
    return execSync(`git ${cmd}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    return ''
  }
}
const pkgVersion = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version as string
const appVersion = process.env.APP_VERSION?.replace(/^v/, '') || git('describe --tags --always --dirty').replace(/^v/, '') || `${pkgVersion}-dev`
const appCommit = process.env.APP_COMMIT || git('rev-parse HEAD')

// .env (GITHUB_TOKEN, GITHUB_CLIENT_ID, ...) for the /api routes in dev, as compose passes it in production.
Object.assign(process.env, { ...loadEnv('development', process.cwd(), ''), ...process.env })

export default defineConfig({
  plugins: [react(), liveApi(), serviceWorker()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
    __APP_COMMIT__: JSON.stringify(appCommit),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  // Listen on all interfaces so the dev site can be opened from a phone over Tailscale or LAN.
  server: { host: '0.0.0.0', allowedHosts: ['.ts.net'] },
  preview: { host: '0.0.0.0', allowedHosts: ['.ts.net'] },
})
