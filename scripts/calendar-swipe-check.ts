// Checks swiping the Calendar between pages. Always: the decisions behind it (src/apps/calendar/swipe.ts).
// With a scratch Vite server's address: the real gesture in headless Chromium with touch, on the Calendar
// alone (scripts/calendar-swipe-fixture.html, all API calls faked): the pages follow the finger with
// the neighbouring days beside them, turn or snap back, up and down still scrolls, an event under a
// swipe is not opened (and one tapped is), arrows keep the hours' scroll, a second finger or the
// page changing under a swipe drops it, and reduced motion turns at once.
//   DATA_DIR=<scratch> ./node_modules/.bin/vite --port 5290 --strictPort
//   node scripts/calendar-swipe-check.ts [http://127.0.0.1:5290]
// Exits 1 on any failure.

import { launch, newPage, sleep } from './perf/cdp.ts'
import { lockAxis, settleDir, velocityOf } from '../src/apps/calendar/swipe.ts'

let failed = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` ${detail}`}`)
}

// A finger is nothing, a swipe or a scroll.
check('small move: no lock yet', lockAxis(5, 3) === null)
check('sideways: x', lockAxis(-20, 4) === 'x')
check('down: y', lockAxis(3, 30) === 'y')
check('diagonal leans to scrolling', lockAxis(12, 12) === 'y')

// Released: turn the page past a share of its width, or on a flick; otherwise back.
check('left far: next', settleDir(-200, 600, 0) === 1)
check('right far: previous', settleDir(200, 600, 0) === -1)
check('short and slow: stay', settleDir(-60, 600, -0.1) === 0)
check('short flick left: next', settleDir(-40, 600, -0.8) === 1)
check('flick back the other way: stay', settleDir(-40, 600, 0.8) === 0)
check('tiny flick: stay', settleDir(-10, 600, -2) === 0)
check('no width: stay', settleDir(-300, 0, -1) === 0)

check('velocity over the last 100 ms', Math.abs(velocityOf([{ t: 0, x: 0 }, { t: 400, x: 100 }, { t: 450, x: 120 }, { t: 500, x: 150 }]) - 0.5) < 1e-9)
check('velocity of one sample', velocityOf([{ t: 0, x: 0 }]) === 0)


  // A fake signed-in account with a calendar, and one event at ten o'clock on every day.
const inject = `
document.cookie='mvlos_uid=1; path=/';document.cookie='mvlos_login=fixture; path=/';
{
 const d=Object.getOwnPropertyDescriptor(Document.prototype,'cookie');
 Object.defineProperty(document,'cookie',{configurable:true,get(){const c=d.get.call(document);return /mvlos_uid=/.test(c)?c:(c?c+'; ':'')+'mvlos_uid=1'},set(v){if(!/^mvlos_uid=/.test(v))d.set.call(document,v)}});
}
const rawFetch=window.fetch.bind(window);
const pad=(n)=>String(n).padStart(2,'0');
window.fetch=async(input,init)=>{
 const u=new URL(typeof input==='string'?input:input.url,location.href);
 if(!u.pathname.startsWith('/api/'))return rawFetch(input,init);
 const json=(v)=>new Response(JSON.stringify(v),{status:200,headers:{'Content-Type':'application/json'}});
 if(u.pathname==='/api/me')return json({authEnabled:true,user:{id:1,login:'fixture',admin:false,githubScopes:[]},forges:[],google:{email:'f@example.test',canWrite:true},integrations:{}});
 if(u.pathname==='/api/calendar/calendars')return json({calendars:[{id:'c1',name:'Test',color:'#4aa3ff',primary:true,selected:true,writable:true,source:'Google'}],errors:[]});
 if(u.pathname==='/api/calendar/events'){
  const from=new Date(u.searchParams.get('from')),to=new Date(u.searchParams.get('to'));
  window.__fetched=(window.__fetched||0)+1;
  const events=[];
  for(let d=new Date(from.getFullYear(),from.getMonth(),from.getDate());d<to;d=new Date(d.getFullYear(),d.getMonth(),d.getDate()+1)){
   const k=d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());
   events.push({id:'e'+k,calendarId:'c1',calendar:'Test',color:'#4aa3ff',title:'E'+k,start:new Date(d.getFullYear(),d.getMonth(),d.getDate(),10).toISOString(),end:new Date(d.getFullYear(),d.getMonth(),d.getDate(),11).toISOString(),allDay:false,editable:false});
  }
  return json({events,errors:[]});
 }
 if(u.pathname==='/api/tasks')return json({lists:[{id:'l1',name:'Chores',color:'#ffaa00',source:'On this site',writable:true,local:true}],tasks:[{id:'l1|t1',list:'l1',uid:'t1',ref:'t1',title:'A chore',due:'2026-10-14',allDay:true,priority:0,completed:false}],errors:[]});
 if(u.pathname==='/api/contacts')return json({books:[],contacts:[],groups:[],errors:[]});
 return json([]);
};
`

async function browserChecks(fixture: string) {
  const browser = await launch(390, 800)
  try {
    const page = await newPage(browser, 390, 800, inject)
    // A phone: touch is the pointer.
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 800, deviceScaleFactor: 1, mobile: true })
    await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    await page.send('Page.navigate', { url: fixture })
    await page.waitFor(`document.querySelectorAll('.ca-page[data-offset="0"] .ca-dayhead').length === 3`, 20_000).catch(async (e) => {
      throw new Error(`${e.message}\n${page.errors.join('\n')}\n${await page.eval<string>(`document.body.innerText.slice(0, 300)`)}`)
    })
    await page.waitFor(`!!document.querySelector('.ca-ev')`)
    check('touch is the pointer', await page.eval<boolean>(`matchMedia('(any-pointer: coarse)').matches`))

    const heads = (offset: number) => page.eval<string[]>(`[...document.querySelectorAll('.ca-page[data-offset="${offset}"] .ca-dayhead strong')].map((e) => e.textContent)`)
    const titles = (offset: number) => page.eval<string[]>(`[...document.querySelectorAll('.ca-page[data-offset="${offset}"] .ca-ev-title')].map((e) => e.textContent.trim())`)
    const pages = () => page.eval<number>(`document.querySelectorAll('.ca-page').length`)
    const shiftNow = () => page.eval<number>(`new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.ca-pager-track')).transform).m41`)
    const inlineTransform = () => page.eval<string>(`document.querySelector('.ca-pager-track').style.transform`)
    const opened = () => page.eval<boolean>(`!!document.querySelector('.ca-pv-back, .ca-pop')`)
    const touch = (type: string, ...pts: [number, number][]) => page.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) })
    const drag = async (from: [number, number], dx: number, dy = 0, steps = 8) => {
      await touch('touchStart', from)
      for (let i = 1; i <= steps; i++) await touch('touchMove', [from[0] + (dx * i) / steps, from[1] + (dy * i) / steps])
    }
    const settled = (expect: string[]) => page.waitFor(`document.querySelectorAll('.ca-page').length === 1 && JSON.stringify([...document.querySelectorAll('.ca-page .ca-dayhead strong')].map((e) => e.textContent)) === ${JSON.stringify(JSON.stringify(expect))}`, 4000)
    const cleanTrack = async () => check('track at rest has no inline transform', (await inlineTransform()) === '' && (await pages()) === 1)

    check('starts on 14–16', JSON.stringify(await heads(0)) === '["14","15","16"]' && (await pages()) === 1)

    // 1. Live: the finger moves the page; the real neighbours are there.
    await drag([300, 400], -120)
    check('a swipe puts the neighbours in', (await pages()) === 3)
    check('next page is 17–19', JSON.stringify(await heads(1)) === '["17","18","19"]', JSON.stringify(await heads(1)))
    check('previous page is 11–13', JSON.stringify(await heads(-1)) === '["11","12","13"]', JSON.stringify(await heads(-1)))
    check('neighbours have their events, not blanks', (await titles(1)).join() === 'E2026-10-17,E2026-10-18,E2026-10-19' && (await titles(-1)).join() === 'E2026-10-11,E2026-10-12,E2026-10-13', `${await titles(1)} / ${await titles(-1)}`)
    const live = await shiftNow()
    check('the track follows the finger', live < -390 - 90 && live > -390 - 125, String(live))
    check('neighbours cannot be reached by the keyboard', await page.eval<boolean>(`[...document.querySelectorAll('.ca-page:not([data-offset="0"])')].every((e) => e.inert && e.getAttribute('aria-hidden') === 'true')`))
    await touch('touchMove', [300 - 200, 400])
    await sleep(100)
    check('and keeps following', Math.abs((await shiftNow()) - (-390 - 192)) < 6, String(await shiftNow()))
    await touch('touchEnd')
    await settled(['17', '18', '19'])
    check('left swipe turns to the next 3 days', true)
    await cleanTrack()
    check('the new page has its events at once', (await titles(0)).join() === 'E2026-10-17,E2026-10-18,E2026-10-19')

    // 2. Right: back.
    await drag([100, 400], 220)
    await touch('touchEnd')
    await settled(['14', '15', '16'])
    check('right swipe turns back', true)

    // 3. Short and slow: snaps back.
    await drag([300, 400], -50, 0, 12)
    check('short drag follows', (await pages()) === 3 && Math.abs((await shiftNow()) - (-390 - 42)) < 6, String(await shiftNow()))
    await sleep(300)
    await touch('touchEnd')
    await settled(['14', '15', '16'])
    await cleanTrack()
    check('short slow drag snaps back', true)

    // 4. Up and down is the hours'.
    const top0 = await page.eval<number>(`document.querySelector('.ca-tg-scroll').scrollTop`)
    await drag([200, 600], 4, -200, 10)
    await touch('touchEnd')
    await sleep(300)
    check('vertical drag leaves the page', JSON.stringify(await heads(0)) === '["14","15","16"]' && (await pages()) === 1)
    const top1 = await page.eval<number>(`document.querySelector('.ca-tg-scroll').scrollTop`)
    check('vertical drag scrolls the hours', top1 > top0 + 50, `${top0} → ${top1}`)

    // 5. A swipe that starts on an event doesn't open it; a tap does.
    const ev = await page.eval<[number, number]>(`(() => { const e = document.querySelector('.ca-page[data-offset="0"] .ca-ev'); e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2] })()`)
    await drag(ev, -150, 0, 8)
    await touch('touchEnd')
    await settled(['17', '18', '19'])
    await sleep(500)
    check('no event opened by a swipe', !(await opened()))
    const ev2 = await page.eval<[number, number]>(`(() => { const e = document.querySelector('.ca-page[data-offset="0"] .ca-ev'); e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2] })()`)
    await touch('touchStart', ev2)
    await touch('touchEnd')
    await page.waitFor(`!!document.querySelector('.ca-pv-back, .ca-pop')`, 3000).catch(() => {})
    check('a tap on an event still opens it', await opened())
    // Escape closes the card.
    for (const type of ['rawKeyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await page.waitFor(`!document.querySelector('.ca-pv-back, .ca-pop')`, 3000)

    check('before the arrows: 17–19', JSON.stringify(await heads(0)) === '["17","18","19"]', JSON.stringify(await heads(0)))
    // 6. The arrows keep where the hours are scrolled to.
    await page.eval(`document.querySelector('.ca-tg-scroll').scrollTop = 321`)
    await sleep(100)
    await page.eval(`[...document.querySelectorAll('.ca-icon')].find((b) => b.getAttribute('aria-label') === 'Next').click()`)
    await settled(['20', '21', '22']).catch(async (e) => {
      throw new Error(`${e.message}\n${await page.eval(`JSON.stringify([document.querySelectorAll('.ca-page').length, [...document.querySelectorAll('.ca-dayhead strong')].map((e) => e.textContent), document.querySelector('.ca-heading')?.textContent])`)}`)
    })
    check('arrows keep the hours scrolled', (await page.eval<number>(`document.querySelector('.ca-tg-scroll').scrollTop`)) === 321, String(await page.eval(`document.querySelector('.ca-tg-scroll').scrollTop`)))

    // 8. The page changes under a swipe (Today): the swipe is off and nothing turns afterwards.
    await drag([300, 400], -100)
    check('swiping again', (await pages()) === 3)
    await page.eval(`[...document.querySelectorAll('.ca-toolbar .btn')].find((b) => b.textContent.trim() === 'Today').click()`)
    await page.waitFor(`document.querySelectorAll('.ca-page').length === 1`, 3000)
    const todayHeads = await heads(0)
    await touch('touchEnd')
    await sleep(500)
    check('page changed mid-swipe: no stale turn', JSON.stringify(await heads(0)) === JSON.stringify(todayHeads) && (await pages()) === 1, `${todayHeads} → ${await heads(0)}`)
    await cleanTrack()

    // 9. Reduced motion: no slide, the turn is at once; a second finger still doesn't crash.
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }, { name: 'prefers-reduced-motion', value: 'reduce' }] })
    const before = await heads(0)
    await drag([300, 400], -200)
    await touch('touchEnd')
    await page.waitFor(`document.querySelectorAll('.ca-page').length === 1`, 600)
    check('reduced motion turns at once', JSON.stringify(await heads(0)) !== JSON.stringify(before))
    // 7. A second finger drops the swipe (last: it leaves Chromium's touch state odd).
    const still = await heads(0)
    await drag([300, 400], -100)
    check('swiping', (await pages()) === 3)
    await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 200, y: 400, id: 0 }, { x: 100, y: 300, id: 1 }] })
    await page.waitFor(`document.querySelectorAll('.ca-page').length === 1`, 4000)
    check('and the page is where it was', JSON.stringify(await heads(0)) === JSON.stringify(still))
    await touch('touchEnd')
    check('a second finger snaps back', true)

    await drag([300, 400], -100)
    await page.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 200, y: 400, id: 0 }, { x: 100, y: 300, id: 1 }] })
    await touch('touchEnd')
    await sleep(200)
    check('reduced motion, second finger: no crash, no drag left', (await pages()) === 1)
    check('no page errors', page.errors.length === 0, page.errors.join(' | '))
    await extraChecks(browser, fixture)
  } finally {
    await browser.close()
  }
}

/** A phone-sized page of the fixture, with the same fake API. */
async function phone(browser: Awaited<ReturnType<typeof launch>>, fixture: string, query: string, extra = '', width = 390, height = 800, scale = 1) {
  const page = await newPage(browser, width * scale, height * scale, inject + extra)
  await page.send('Emulation.setDeviceMetricsOverride', { width: width * scale, height: height * scale, deviceScaleFactor: 1, mobile: true })
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  await page.send('Page.navigate', { url: `${fixture}?${query}` })
  const touch = (type: string, ...pts: [number, number][]) => page.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id })) })
  const drag = async (from: [number, number], dx: number, steps = 8) => {
    await touch('touchStart', from)
    for (let i = 1; i <= steps; i++) await touch('touchMove', [from[0] + (dx * i) / steps, from[1]])
  }
  const shift = () => page.eval<number>(`new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.ca-pager-track')).transform).m41`)
  return { page, touch, drag, shift }
}

async function extraChecks(browser: Awaited<ReturnType<typeof launch>>, fixture: string) {
  // A swipe may start on a task's ring (a button that keeps its own pointer events).
  {
    const { page, touch, drag } = await phone(browser, fixture, 'view=3day&date=2026-10-14')
    await page.waitFor(`!!document.querySelector('.ca-task-check')`, 20_000)
    const ring = await page.eval<[number, number]>(`(() => { const r = document.querySelector('.ca-task-check').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2] })()`)
    await drag(ring, -170)
    await touch('touchEnd')
    await page.waitFor(`document.querySelectorAll('.ca-page').length === 1 && document.querySelector('.ca-dayhead strong').textContent === '17'`, 4000).catch(() => {})
    check('a swipe can start on a task ring', (await page.eval<string>(`document.querySelector('.ca-dayhead strong').textContent`)) === '17')
    await page.close()
  }
  // The page drawn bigger (UI scale 150%): fingers move in screen pixels, the page in its own.
  {
    const { page, touch, drag, shift } = await phone(browser, fixture, 'view=3day&date=2026-10-14', `localStorage.setItem('mvlos.ui.scale','1.5')`, 390, 800, 1.5)
    await page.waitFor(`!!document.querySelector('.ca-ev')`, 20_000)
    check('scaled page: zoom is on', (await page.eval<string>(`document.documentElement.style.zoom`)) === '1.5')
    await drag([450, 600], -180)
    await new Promise((r) => setTimeout(r, 100))
    const live = await shift()
    // 180 screen px = 120 page px, less the 8 that decided it.
    check('scaled page: the track follows the finger 1:1', Math.abs(live - (-390 - 112)) < 6, String(live))
    await touch('touchEnd')
    await page.waitFor(`document.querySelectorAll('.ca-page').length === 1 && document.querySelector('.ca-dayhead strong').textContent === '17'`, 4000).catch(() => {})
    check('scaled page: turns on a third of the width', (await page.eval<string>(`document.querySelector('.ca-dayhead strong').textContent`)) === '17')
    await page.close()
  }
  // A quick flick that is held still before the finger lifts is not a flick.
  {
    const { page, touch, drag } = await phone(browser, fixture, 'view=3day&date=2026-10-14')
    await page.waitFor(`!!document.querySelector('.ca-ev')`, 20_000)
    await drag([300, 400], -50, 3)
    await new Promise((r) => setTimeout(r, 1000))
    await touch('touchEnd')
    await page.waitFor(`document.querySelectorAll('.ca-page').length === 1`, 4000)
    check('flick, hold, lift: stays', (await page.eval<string>(`document.querySelector('.ca-dayhead strong').textContent`)) === '14')
    await drag([300, 400], -50, 3)
    await touch('touchEnd')
    await page.waitFor(`document.querySelectorAll('.ca-page').length === 1`, 4000)
    check('flick and lift: turns', (await page.eval<string>(`document.querySelector('.ca-dayhead strong').textContent`)) === '17')
    await page.close()
  }
  // The year keeps where it is scrolled to through a swipe and the arrows.
  {
    const { page, touch, drag } = await phone(browser, fixture, 'view=year&date=2026-10-14')
    await page.waitFor(`!!document.querySelector('.ca-year')`, 20_000)
    await page.eval(`document.querySelector('.ca-year').scrollTop = 600`)
    const top = () => page.eval<number>(`document.querySelector('.ca-page[data-offset="0"] .ca-year').scrollTop`)
    await new Promise((r) => setTimeout(r, 150))
    await drag([300, 400], -160)
    check('year: the neighbour is scrolled alike', (await page.eval<number>(`document.querySelector('.ca-page[data-offset="1"] .ca-year').scrollTop`)) === 600)
    await touch('touchEnd')
    await page.waitFor(`document.querySelectorAll('.ca-page').length === 1 && document.querySelector('.ca-heading').textContent === '2027'`, 4000)
    check('year: swiped to 2027 at the same scroll', Math.abs((await top()) - 600) < 2, String(await top()))
    await page.eval(`[...document.querySelectorAll('.ca-icon')].find((b) => b.getAttribute('aria-label') === 'Next').click()`)
    await page.waitFor(`document.querySelector('.ca-heading').textContent === '2028'`, 4000)
    check('year: arrow keeps the scroll', Math.abs((await top()) - 600) < 2, String(await top()))
    await page.close()
  }
}

const base = process.argv[2]
if (base) {
  const url = new URL(base)
  if (url.hostname !== '127.0.0.1' || Number(url.port) < 5170 || Number(url.port) > 5299) throw new Error('Use a scratch Vite server on 127.0.0.1:5170–5299')
  await browserChecks(`${url.origin}/scripts/calendar-swipe-fixture.html`)
} else console.log('(no server given: browser checks skipped)')

if (failed) {
  console.log(`\n${failed} failed`)
  process.exit(1)
}
console.log('\nall ok')
