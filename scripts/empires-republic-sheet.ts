// A contact sheet of a faction's procedural models, for looking at a redesign without clicking
// through the Codex: every ship, the platforms, the yards and the Command Station at each level,
// painted by the game's own painter in headless Chromium against a running dev server, and saved
// as one PNG.
//
//   node scripts/empires-republic-sheet.ts <dev server url> <out.png> [faction] [px] [ids]
//
//   dev server url  a running `vite` dev server of this checkout (e.g. http://127.0.0.1:5241)
//   out.png         where to write the sheet
//   faction         whose units (default republic)
//   px              each unit's long side in pixels (default 260)
//   ids             only these unit ids, comma separated ("station" for every station level)

import { writeFileSync } from 'node:fs'
import { launch, newPage } from './perf/cdp.ts'

const [url, out, faction = 'republic', pxArg = '260', only] = process.argv.slice(2)
if (!url || !out) {
  console.log('usage: node scripts/empires-republic-sheet.ts <dev server url> <out.png> [faction] [px] [ids]')
  process.exit(1)
}
const px = Number(pxArg)

const b = await launch(1600, 1000)
try {
  const page = await newPage(b, 1600, 1000, '')
  await page.send('Page.navigate', { url: `${url}/play/empires` })
  await page.waitFor('document.readyState === "complete"')
  const png = await page.eval<string>(`(async () => {
    const root = '/src/apps/games/empires/'
    const data = await import(root + 'data.ts')
    const models = await import(root + 'models/index.ts')
    const paint = await import(root + 'models/paint.ts')
    const faction = ${JSON.stringify(faction)}
    const only = ${JSON.stringify(only ? only.split(',') : null)}
    const px = ${px}
    const looks = []
    for (const t of data.UNITS) {
      if (t.faction !== faction || t.tier === 'station') continue
      if (only && !only.includes(t.id)) continue
      looks.push({ label: t.name, m: models.modelFor(t) })
    }
    if (!only || only.includes('station')) {
      const techs = data.TECHS.filter((x) => x.faction === faction).map((x) => x.id)
      for (let lv = 1; lv <= data.STATIONS[faction].stages.length; lv++) {
        looks.push({ label: 'Station ' + lv, m: models.modelFor(data.stationType(faction, lv, [])) })
        looks.push({ label: 'Station ' + lv + ' + research', m: models.modelFor(data.stationType(faction, lv, techs)) })
      }
    }
    const cols = Math.min(6, looks.length)
    const cell = px + 24
    const c = document.createElement('canvas')
    c.width = cols * cell
    c.height = Math.ceil(looks.length / cols) * (cell + 18)
    const g = c.getContext('2d')
    g.fillStyle = '#0b0f1c'
    g.fillRect(0, 0, c.width, c.height)
    g.font = '13px sans-serif'
    for (let i = 0; i < looks.length; i++) {
      const { label, m } = looks[i]
      const { url } = paint.thumbnail(m, px)
      const img = new Image()
      img.src = url
      await img.decode()
      const x = (i % cols) * cell + 12
      const y = Math.floor(i / cols) * (cell + 18) + 12
      const k = Math.min(px / img.width, px / img.height)
      g.drawImage(img, x + (px - img.width * k) / 2, y + (px - img.height * k) / 2, img.width * k, img.height * k)
      g.fillStyle = '#c8d0e0'
      g.fillText(label, x, y + px + 14)
    }
    return c.toDataURL('image/png')
  })()`)
  writeFileSync(out, Buffer.from(png.split(',')[1], 'base64'))
  if (page.errors.length) console.log(page.errors.join('\n'))
  console.log(`wrote ${out}`)
} finally {
  await b.close()
}
