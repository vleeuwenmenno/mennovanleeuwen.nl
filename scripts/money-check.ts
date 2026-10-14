// Checks the amounts of money found in Agents replies (src/data/money.ts) and the shared exchange
// rates behind them and Spotlight (server/fx.ts, GET /api/fx):
//
//   - a table of texts and the amounts that must (or must not) be found in them: signs before and
//     after, ISO codes, both separator styles, ranges, magnitudes, negatives, yen without
//     decimals, nothing in code or links, and things that only look like money;
//   - the rates against stand-ins for both sources: the ECB wins where both have a rate, many
//     requests within six hours make one fetch (with a clock the check moves), concurrent
//     requests share one fetch, the last rates are served when the sources fail, and a restart
//     reads them back from DATA_DIR instead of fetching;
//   - /api/fx through the real server (server/index.ts on a free port, a scratch DATA_DIR and
//     FX_URL_ECB / FX_URL_WIDE pointing at the stand-ins): one fetch for many requests, a
//     cacheable answer, 503 when there are no rates at all.
//
//   node scripts/money-check.ts
//
// No network. Exits 1 on any failure.

import { createServer, type Server as HttpServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findMoney, moneyInMarkdown, readNumber } from '../src/data/money.ts'
import { createFx, FX_RETRY, FX_TTL } from '../server/fx.ts'
import { Server, check, finish, sleep } from './empires-harness.ts'

// --- Detection ------------------------------------------------------------------------------------

const show = (hits: { text: string; value: number; currency: string }[]) => hits.map((h) => `${h.text}=${Number(h.value.toPrecision(12))} ${h.currency}`).join(' | ')

/** [what, Markdown, the amounts as "text=value CODE" joined by " | ", or "" for none] */
const CASES: [string, string, string][] = [
  // Signs before the number.
  ['euro sign', 'It costs €180.', '€180=180 EUR'],
  ['yen with thousands', 'About ¥60,000 a night', '¥60,000=60000 JPY'],
  ['dollar', 'Budget $300 for it', '$300=300 USD'],
  ['pound with decimals', 'Lunch was £12.50', '£12.50=12.5 GBP'],
  ['sign with a space', 'only € 5 more', '€ 5=5 EUR'],
  ['rupee and won', '₹500 or ₩10,000', '₹500=500 INR | ₩10,000=10000 KRW'],
  ['US$', 'US$300 total', 'US$300=300 USD'],
  ['A$, C$, NZ$, HK$, S$', 'A$50, C$20, NZ$10, HK$100, S$15', 'A$50=50 AUD | C$20=20 CAD | NZ$10=10 NZD | HK$100=100 HKD | S$15=15 SGD'],
  ['CA$ and R$', 'CA$12 and R$40', 'CA$12=12 CAD | R$40=40 BRL'],
  ['CN¥ and RMB', 'CN¥30 or RMB 200', 'CN¥30=30 CNY | RMB 200=200 CNY'],
  // Codes.
  ['code after', 'Pay 180 EUR now', '180 EUR=180 EUR'],
  ['code before', 'USD 12.50 each', 'USD 12.50=12.5 USD'],
  ['code glued', 'EUR180 or 25GBP', 'EUR180=180 EUR | 25GBP=25 GBP'],
  ['a code the ECB lacks', 'VND 250,000 for pho', 'VND 250,000=250000 VND'],
  ['Swiss apostrophes', "CHF 1'234.50", "CHF 1'234.50=1234.5 CHF"],
  ['kr with a code', 'SEK 100 and 50 NOK', 'SEK 100=100 SEK | 50 NOK=50 NOK'],
  // Signs after the number.
  ['European format, sign after', 'Preis: 1.234,56 €', '1.234,56 €=1234.56 EUR'],
  ['European decimals, sign before', '€1.234,56', '€1.234,56=1234.56 EUR'],
  ['yen as 円', '60,000円です', '60,000円=60000 JPY'],
  ['万円', '6万円くらい', '6万円=60000 JPY'],
  ['元', '100元', '100元=100 CNY'],
  ['złoty and koruna', '100 zł, 250 Kč', '100 zł=100 PLN | 250 Kč=250 CZK'],
  ['non-breaking space thousands', '1 234,56 €', '1 234,56 €=1234.56 EUR'],
  // Separators.
  ['thousands with commas', '$1,234,567.89', '$1,234,567.89=1234567.89 USD'],
  ['one dot and three digits groups thousands', '¥1.500', '¥1.500=1500 JPY'],
  ['comma decimal', '€1,5 per kilo', '€1,5=1.5 EUR'],
  ['zero point three digits stays a fraction', '€0.945/kWh', '€0.945=0.945 EUR'],
  ['yen thousands with dots', '¥1.234.567', '¥1.234.567=1234567 JPY'],
  // A lone dot before three digits: a decimal point in dot-decimal currencies, thousands elsewhere.
  ['dollars per gallon, three decimals', 'Gas is $3.459/gal', '$3.459=3.459 USD'],
  ['US$ with three decimals', 'US$3.459', 'US$3.459=3.459 USD'],
  ['A$, C$, HK$ with three decimals', 'A$1.299, C$2.005, HK$9.999', 'A$1.299=1.299 AUD | C$2.005=2.005 CAD | HK$9.999=9.999 HKD'],
  ['pound with three decimals', '£1.250 a litre', '£1.250=1.25 GBP'],
  ['dot-decimal codes', '3.459 USD, CNY 1.234, 1.500 INR', '3.459 USD=3.459 USD | CNY 1.234=1.234 CNY | 1.500 INR=1.5 INR'],
  ['dollar range with three decimals', '$3.459–3.499', '$3.459=3.459 USD | 3.499=3.499 USD'],
  ['backward range in a dot-decimal code', '3.459-3.499 USD', '3.459=3.459 USD | 3.499 USD=3.499 USD'],
  ['euro dot still thousands', '€1.234 and 1.500 EUR', '€1.234=1234 EUR | 1.500 EUR=1500 EUR'],
  ['krone and złoty dot thousands', 'DKK 1.234 and 2.500 zł', 'DKK 1.234=1234 DKK | 2.500 zł=2500 PLN'],
  ['yen, won and dong dot thousands', '¥1.234, ₩5.000, VND 250.000', '¥1.234=1234 JPY | ₩5.000=5000 KRW | VND 250.000=250000 VND'],
  ['unambiguous forms in dollars unchanged', '$1,234 / $1,234.56 / $1.234.567 / $1.234,56', '$1,234=1234 USD | $1,234.56=1234.56 USD | $1.234.567=1234567 USD | $1.234,56=1234.56 USD'],
  // Years next to a code.
  ['a year after in', 'Prices in 2026 USD terms', ''],
  ['a year after since and from', 'since 1999 EUR, from 2010 GBP', ''],
  ['a year after until and by', 'until 2030 USD; by 2035 EUR', ''],
  ['a year after of', 'the budget of 2027 EUR', ''],
  ['a year after a month', 'October 2026 USD and Sept 2025 EUR', ''],
  ['a year after a month and day', 'March 14, 2026 USD', ''],
  ['a year after a Dutch date', '14 oktober 2026 EUR, mrt 2025 EUR', ''],
  ['a year after Dutch words', 'tot 2030 EUR, sinds 2020 EUR, vanaf 2027 EUR', ''],
  ['a year after a numeric date', '14/10/2026 USD and 14-10-2026 EUR', ''],
  ['a year amount alone', '2000 USD', '2000 USD=2000 USD'],
  ['a year amount after costs', 'It costs 2026 USD', '2026 USD=2026 USD'],
  ['a year-like amount with a sign', 'in $2026 and since €1999', '$2026=2026 USD | €1999=1999 EUR'],
  ['not a year: decimals or thousands', 'in 2026.50 USD and in 2,026 USD', '2026.50 USD=2026.5 USD | 2,026 USD=2026 USD'],
  ['not a year: out of range', 'in 2100 USD and in 1899 EUR', '2100 USD=2100 USD | 1899 EUR=1899 EUR'],
  // Magnitudes.
  ['k and M', '¥60k, $1.2M', '¥60k=60000 JPY | $1.2M=1200000 USD'],
  ['bn and million', '$3bn or €2 million', '$3bn=3000000000 USD | €2 million=2000000 EUR'],
  // Negatives.
  ['negative', 'Change: -€5, −$300 and -5 EUR', '-€5=-5 EUR | −$300=-300 USD | -5 EUR=-5 EUR'],
  // Ranges.
  ['yen range per litre', '~¥167–170/L', '¥167=167 JPY | 170=170 JPY'],
  ['euro range with decimals', '(~€0.94–0.96)', '€0.94=0.94 EUR | 0.96=0.96 EUR'],
  ['range with the sign after', '1,000–2,000円', '1,000=1000 JPY | 2,000円=2000 JPY'],
  ['range with a hyphen and a code', '5-10 EUR', '5=5 EUR | 10 EUR=10 EUR'],
  ['range with both signs', '$5 - $10', '$5=5 USD | $10=10 USD'],
  ['Japanese wave dash range', '¥3,000〜5,000', '¥3,000=3000 JPY | 5,000=5000 JPY'],
  // Markdown around it.
  ['in bold', 'Total **€42**', '€42=42 EUR'],
  ['in a table', '| Fuel | Price |\n|---|---|\n| Regular | ~¥167–170/L (~€0.94–0.96) |', '¥167=167 JPY | 170=170 JPY | €0.94=0.94 EUR | 0.96=0.96 EUR'],
  ['in a list', '- Ticket: €1\n- Dinner: $300', '€1=1 EUR | $300=300 USD'],
  ['not in a code span', 'Run `echo €5` for $3', '$3=3 USD'],
  ['not in a code block', '```\nprice = €5\n```\nand €6', '€6=6 EUR'],
  ['not in a link address', 'See https://shop.example/€5/item and [€7](https://x.example/$9)', ''],
  ['not in link text', '[pay $10 here](https://pay.example)', ''],
  // Must not match.
  ['shell variables', 'echo $PATH and ${var} and $HOME', ''],
  ['dollar after the number', 'it was 5$ cheaper', ''],
  ['version numbers', 'v1.2.3 and 2.0.1 and node 24.1', ''],
  ['kr without a code', 'It costs 100 kr', ''],
  ['bare R', 'R 100 or 100 R', ''],
  ['times', 'At 12:30 or 9:05', ''],
  ['phone numbers', 'Call +31 6 1234 5678 or 555-0199', ''],
  ['currency pair', 'EUR/USD 1.08', ''],
  ['glued to a word', 'abc$5 and x86 and EUROS 5', ''],
  ['sign glued to letters after', '$5Mbps and €5x', ''],
  ['a time after a sign', '€12:30', ''],
  ['PHP the language', 'PHP 8.3 is out', ''],
  ['plain numbers', '42 apples and 3.14', ''],
  ['a sign alone', 'the € and the $ sign', ''],
]

let failures = 0
for (const [what, md, want] of CASES) {
  const got = show(moneyInMarkdown(md))
  check(`detect: ${what}`, got === want)
  if (got !== want) {
    failures++
    console.error(`   text: ${JSON.stringify(md)}\n   want: ${want || '(none)'}\n   got:  ${got || '(none)'}`)
  }
}
check(`detection table has at least 40 cases (${CASES.length})`, CASES.length >= 40)
check('readNumber: 1,234.56 / 1.234,56 / 1,5 / 1.2.3', readNumber('1,234.56') === 1234.56 && readNumber('1.234,56') === 1234.56 && readNumber('1,5') === 1.5 && readNumber('1.2.3') === null)
check('readNumber: a lone dot before three digits follows the currency', readNumber('3.459', 'USD') === 3.459 && readNumber('3.459', 'GBP') === 3.459 && readNumber('1.234', 'EUR') === 1234 && readNumber('1.234', 'JPY') === 1234 && readNumber('1.234') === 1234 && readNumber('1,234', 'USD') === 1234 && readNumber('0.945', 'EUR') === 0.945)
check('findMoney gives positions', JSON.stringify(findMoney('a €5 b').map((h) => [h.start, h.end])) === '[[2,4]]')

// --- The rate sources' stand-ins ------------------------------------------------------------------

type Mock = { server: HttpServer; url: string; ecb: number; wide: number; fail: boolean; delay: number }

async function startMock(): Promise<Mock> {
  const mock: Mock = { server: null as unknown as HttpServer, url: '', ecb: 0, wide: 0, fail: false, delay: 0 }
  mock.server = createServer(async (req, res) => {
    const ecb = req.url!.startsWith('/ecb')
    if (ecb) mock.ecb++
    else mock.wide++
    if (mock.delay) await sleep(mock.delay)
    if (mock.fail) return res.writeHead(502).end('down')
    // The wider source has its own (different) JPY and USD, and currencies the ECB lacks.
    const body = ecb ? { amount: 1, base: 'EUR', date: '2026-10-13', rates: { USD: 1.08, JPY: 170.5, GBP: 0.85 } } : { result: 'success', base_code: 'EUR', rates: { EUR: 1, USD: 1.1, JPY: 175, GBP: 0.86, VND: 27000, AED: 3.97 } }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
  })
  await new Promise<void>((r) => mock.server.listen(0, '127.0.0.1', r))
  mock.url = `http://127.0.0.1:${(mock.server.address() as { port: number }).port}`
  return mock
}

const mock = await startMock()
const scratch = mkdtempSync(join(tmpdir(), 'money-check-'))
const reset = () => {
  mock.ecb = mock.wide = 0
  mock.fail = false
  mock.delay = 0
}

// --- server/fx.ts directly, with a clock ------------------------------------------------------------

{
  reset()
  let clock = 1_000_000
  const file = join(scratch, 'fx-a.json')
  const fx = createFx({ ecbUrl: `${mock.url}/ecb`, wideUrl: `${mock.url}/wide`, file, now: () => clock })
  const first = await fx.get()
  check('fx: rates come back', !!first && first.rates.base === 'EUR' && first.rates.rates.EUR === 1)
  check('fx: the ECB wins where both have a rate', first?.rates.rates.USD === 1.08 && first?.rates.rates.JPY === 170.5 && first?.rates.rates.GBP === 0.85)
  check('fx: the wider source tops up the rest', first?.rates.rates.VND === 27000 && first?.rates.rates.AED === 3.97)
  check('fx: date and source are the ECB\'s', first?.rates.date === '2026-10-13' && first?.rates.source === 'European Central Bank')
  check('fx: the wider-only codes are listed', JSON.stringify(first?.rates.wide.sort()) === '["AED","VND"]')
  for (let i = 0; i < 25; i++) {
    clock += 10 * 60_000 // 25 × 10 min: past 4 h, inside 6 h
    if (i < 20) await fx.get()
  }
  clock = 1_000_000 + FX_TTL - 1
  await fx.get()
  check('fx: many requests within six hours make one fetch', fx.fetches() === 1 && mock.ecb === 1 && mock.wide === 1)
  clock = 1_000_000 + FX_TTL + 1
  await fx.get()
  check('fx: after six hours it fetches again', fx.fetches() === 2 && mock.ecb === 2)

  // The sources fail: the last rates are served, marked stale, and left alone for a while.
  mock.fail = true
  clock += FX_TTL + 1
  const stale = await fx.get()
  check('fx: stale rates are served when the sources fail', !!stale && stale.stale && stale.rates.rates.USD === 1.08)
  check('fx: a stale answer is cacheable only briefly', stale?.maxAge === 300)
  const callsAfterFailure = mock.ecb
  clock += 60_000
  await fx.get()
  await fx.get()
  check('fx: the sources are not asked again right after a failure', mock.ecb === callsAfterFailure)
  mock.fail = false
  clock += FX_RETRY
  const back = await fx.get()
  check('fx: once they are back, fresh rates replace the stale ones', !!back && !back.stale && mock.ecb === callsAfterFailure + 1)

  // A restart: a new instance reads the rates from the file and doesn't fetch while they're fresh.
  const before = mock.ecb
  const restarted = createFx({ ecbUrl: `${mock.url}/ecb`, wideUrl: `${mock.url}/wide`, file, now: () => clock + 60_000 })
  const kept = await restarted.get()
  check('fx: after a restart the kept rates are used without a fetch', !!kept && kept.rates.rates.USD === 1.08 && restarted.fetches() === 0 && mock.ecb === before)
}

{
  // One fetch at a time: many requests while the sources are slow share it.
  reset()
  mock.delay = 300
  const fx = createFx({ ecbUrl: `${mock.url}/ecb`, wideUrl: `${mock.url}/wide`, file: null })
  const all = await Promise.all(Array.from({ length: 20 }, () => fx.get()))
  check('fx: 20 concurrent requests share one fetch', fx.fetches() === 1 && mock.ecb === 1 && mock.wide === 1 && all.every((r) => r?.rates.rates.USD === 1.08))
}

{
  // Only the wider source answers: its rates, today's date, its name.
  reset()
  const fx = createFx({ ecbUrl: `${mock.url}/ecb-missing-404`, wideUrl: `${mock.url}/wide`, file: null })
  mock.server.removeAllListeners('request')
  mock.server.on('request', (req, res) => {
    if (req.url!.startsWith('/ecb')) return res.writeHead(404).end()
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ rates: { EUR: 1, USD: 1.1, JPY: 175 } }))
  })
  const r = await fx.get()
  check('fx: without the ECB, the wider source alone', r?.rates.source === 'exchangerate-api.com' && r.rates.rates.USD === 1.1 && r.rates.wide.length === 0)
  // Neither: nothing to serve.
  mock.server.removeAllListeners('request')
  mock.server.on('request', (_req, res) => res.writeHead(500).end())
  const none = await createFx({ ecbUrl: `${mock.url}/ecb`, wideUrl: `${mock.url}/wide`, file: null }).get()
  check('fx: no rates at all when both sources fail and nothing is kept', none === null)
}
mock.server.close()

// --- /api/fx through the real server ---------------------------------------------------------------

{
  const live = await startMock()
  const server = new Server({ FX_URL_ECB: `${live.url}/ecb`, FX_URL_WIDE: `${live.url}/wide` })
  await server.start()
  const base = server.origin
  try {
    const responses = await Promise.all(Array.from({ length: 10 }, () => fetch(`${base}/api/fx`)))
    const bodies = await Promise.all(responses.map((r) => r.json()))
    for (let i = 0; i < 5; i++) await (await fetch(`${base}/api/fx`)).json()
    check('/api/fx: answers 200 with the merged rates', responses.every((r) => r.status === 200) && bodies.every((b) => b.rates.USD === 1.08 && b.rates.VND === 27000 && b.source === 'European Central Bank'))
    check('/api/fx: 15 requests, one fetch from each source', live.ecb === 1 && live.wide === 1)
    const cc = responses[0].headers.get('cache-control') ?? ''
    check(`/api/fx: cacheable (${cc})`, /^public, max-age=\d+$/.test(cc) && Number(cc.split('=')[1]) > 0)
    check('/api/fx: guests may read it (no cookie needed)', responses[0].status === 200)

    // A restart with the same DATA_DIR: the kept rates, no fetch.
    await server.stop()
    live.ecb = live.wide = 0
    await server.start()
    const r = await fetch(`${server.origin}/api/fx`)
    check('/api/fx: after a restart, the kept rates without a fetch', r.status === 200 && (await r.json()).rates.USD === 1.08 && live.ecb === 0 && live.wide === 0)
  } finally {
    await server.dispose()
    live.server.close()
  }

  // No rates and no sources: 503.
  const down = new Server({ FX_URL_ECB: 'http://127.0.0.1:9/ecb', FX_URL_WIDE: 'http://127.0.0.1:9/wide' })
  await down.start()
  try {
    const r = await fetch(`${down.origin}/api/fx`)
    check('/api/fx: 503 when there are no rates at all', r.status === 503 && /unavailable/i.test((await r.json()).error))
  } finally {
    await down.dispose()
  }
}

rmSync(scratch, { recursive: true, force: true })
if (failures) console.error(`${failures} detection case(s) failed`)
finish()
