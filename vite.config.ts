import { createHash } from 'node:crypto'
import { execSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import zlib, { brotliCompress, gzip } from 'node:zlib'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { handleApi } from './server/api.ts'
import { empiresUpgrade, startEmpires } from './server/empires.ts'
import { startAgents } from './server/agents.ts'
import { startMinecraftWatch } from './server/minecraft.ts'
import { startNotifications } from './server/watchers.ts'

/** The /api routes during `pnpm dev` and `pnpm preview`, like server/index.ts in production. */
const liveApi = (): Plugin => {
  const handler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, next: () => void) => {
    handleApi(req, res).then((handled) => handled || next(), next)
  }
  // The Empires At War multiplayer socket; other upgrades (Vite's hot reload) are left alone.
  const upgrade = (req: import('node:http').IncomingMessage, socket: import('node:stream').Duplex, head: Buffer) => {
    empiresUpgrade(req, socket, head)
  }
  return {
    name: 'live-api',
    configureServer: (server) => {
      server.middlewares.use(handler)
      server.httpServer?.on('upgrade', upgrade)
      startEmpires()
      startAgents()
      startMinecraftWatch()
      startNotifications()
    },
    configurePreviewServer: (server) => {
      server.middlewares.use(handler)
      server.httpServer.on('upgrade', upgrade)
      startEmpires()
      startAgents()
      startMinecraftWatch()
      startNotifications()
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
    // pdf.js (1.7 MB) only loads when the owner opens a PDF: not something every visitor should download.
    const built = Object.keys(bundle)
      .filter((f) => !f.endsWith('.map') && f !== 'index.html' && !/(^|\/)pdf(\.worker\.min)?[-.]/.test(f))
      .map((f) => `/${f}`)
    const statics = ['/', '/favicon.svg', '/manifest.webmanifest', '/icons/app.svg', '/icons/app-192.png', '/icons/boltwarden.svg', '/recents.json', '/contributions.json']
    const precache = [...statics, ...built]
    const template = readFileSync(new URL('./pwa/sw.js', import.meta.url), 'utf8')
    // The worker's own code counts too, so a change to it alone still gets a fresh shell cache.
    const version = createHash('sha256').update(`${template}\n${precache.join('\n')}`).digest('hex').slice(0, 12)
    const source = template.replace('__VERSION__', version).replace('__PRECACHE__', JSON.stringify(precache))
    this.emitFile({ type: 'asset', fileName: 'sw.js', source })
  },
})

/**
 * Brotli (quality 11) and gzip (level 9) copies next to each text file of the build, for
 * server/index.ts to send to browsers that accept them. Only kept when smaller than the file.
 */
const precompress = (): Plugin => {
  let outDir = 'dist'
  return {
    name: 'mvlos-precompress',
    apply: 'build',
    configResolved: (c) => void (outDir = resolve(c.root, c.build.outDir)),
    async closeBundle() {
      const TEXT = /\.(js|mjs|css|html|svg|json|webmanifest|txt)$/
      const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : TEXT.test(e.name) ? [join(dir, e.name)] : []))
      const br = promisify(brotliCompress)
      const gz = promisify(gzip)
      await Promise.all(
        walk(outDir).map(async (path) => {
          const raw = await readFile(path)
          if (raw.length < 256) return
          const [b, g] = await Promise.all([
            br(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length, [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT } }),
            gz(raw, { level: 9 }),
          ])
          if (b.length < raw.length) await writeFile(`${path}.br`, b)
          if (g.length < raw.length) await writeFile(`${path}.gz`, g)
        }),
      )
    },
  }
}

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
  plugins: [react(), liveApi(), serviceWorker(), precompress()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
    __APP_COMMIT__: JSON.stringify(appCommit),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  // Listen on all interfaces so the dev site can be opened from a phone over Tailscale or LAN.
  server: { host: '0.0.0.0', allowedHosts: ['.ts.net'] },
  preview: { host: '0.0.0.0', allowedHosts: ['.ts.net'] },
})
