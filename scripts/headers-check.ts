// Checks the baseline response headers: HSTS and the general CSP on the app document and API
// answers, and that the stricter policies of untrusted bytes and share pages replace it.
//
//   pnpm build && node scripts/headers-check.ts
//
// Boots server/index.ts on a scratch port and DATA_DIR. Exits 1 on any failure.

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SECURITY, UNTRUSTED } from '../server/http.ts'

let failed = false
const check = (what: string, test: boolean, detail?: unknown) => {
  if (test) console.log('PASS', what)
  else {
    failed = true
    console.log('FAIL', what, detail ?? '')
  }
}

const GENERAL = "script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'"
check('SECURITY carries HSTS without includeSubDomains or preload', SECURITY['Strict-Transport-Security'] === 'max-age=31536000')
check('SECURITY carries the general CSP', SECURITY['Content-Security-Policy'] === GENERAL)
// The merge order every untrusted-bytes route uses: SECURITY first, UNTRUSTED after.
check('UNTRUSTED replaces the general CSP when spread after SECURITY', ({ ...SECURITY, ...UNTRUSTED })['Content-Security-Policy'] === "default-src 'none'; sandbox")

const port = 5290 + (process.pid % 9)
const dir = mkdtempSync(join(tmpdir(), 'headers-check-'))
const child = spawn('node', ['server/index.ts'], { env: { ...process.env, PORT: String(port), DATA_DIR: dir }, stdio: 'ignore' })
try {
  const base = `http://127.0.0.1:${port}`
  for (let i = 0; i < 100; i++) {
    if (await fetch(base + '/api/me').then(() => true, () => false)) break
    await new Promise((r) => setTimeout(r, 100))
  }
  const get = (path: string) => fetch(base + path).then((r) => r.headers)
  for (const path of ['/', '/api/me']) {
    const h = await get(path)
    check(`${path}: HSTS`, h.get('strict-transport-security') === 'max-age=31536000', h.get('strict-transport-security'))
    check(`${path}: general CSP`, h.get('content-security-policy') === GENERAL, h.get('content-security-policy'))
    check(`${path}: nosniff and frame options kept`, h.get('x-content-type-options') === 'nosniff' && h.get('x-frame-options') === 'SAMEORIGIN')
  }
  // A share page (here the 404 every unknown token gets) keeps its own, tighter policy.
  const share = await get('/s/' + 'x'.repeat(24))
  const csp = share.get('content-security-policy') ?? ''
  check('share page: own CSP, not the general one', /^default-src 'none'; style-src 'nonce-/.test(csp) && csp.includes("frame-ancestors 'none'"), csp)
  check('share page: HSTS', share.get('strict-transport-security') === 'max-age=31536000')
} finally {
  child.kill()
  rmSync(dir, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
