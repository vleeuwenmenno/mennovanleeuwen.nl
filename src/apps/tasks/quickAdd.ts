// Quick add in the Tasks app: a date, a time and a priority typed at the end of a new task's title
// ("Call mum tomorrow 9am", "Report fri !!", "Plan next week", "Pay rent on 31 oct"). Only the end
// of the line is read, phrase by phrase from the back, so words in the title itself stay ("Read
// Friday Night Lights" has no date). Dates are the browser's local days; a time alone is today, or
// tomorrow once it has passed. Pure, so `pnpm check:tasks` runs it in Node too.

export type Quick = { title: string; due?: string; allDay?: boolean; priority: number }

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
const pad = (n: number) => String(n).padStart(2, '0')
const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)

/** A weekday or month name, written out or cut short to at least three letters ("thu", "thurs", "sept"). */
const named = (word: string, names: string[]) => (word.length >= 3 ? names.findIndex((n) => n.startsWith(word)) : -1)

/** A day of the month and a month: this year, or next once it has passed. */
function dayOfMonth(day: number, month: number, today: Date, year?: number): Date | null {
  if (month < 0 || month > 11 || day < 1 || day > 31) return null
  let d = new Date(year ?? today.getFullYear(), month, day)
  if (d.getMonth() !== month) return null
  if (year === undefined && d < today) d = new Date(today.getFullYear() + 1, month, day)
  return d
}

type Found = { date?: Date; minutes?: number }

/** The date or time the last words are, and how many words that took (0: none). */
function tail(words: string[], today: Date): { found: Found; used: number } | null {
  const w = words.map((x) => x.toLowerCase().replace(/[.,]$/, ''))
  const n = w.length
  const last = w[n - 1]
  const prev = w[n - 2]
  const prev2 = w[n - 3]
  // Times: 9am, 9:30, 21:00, 9.30pm, "at 9", "at 9pm", noon.
  const time = /^(\d{1,2})(?:[:.](\d{2}))?(am|pm)?$/.exec(last)
  if (time && (time[2] || time[3] || prev === 'at')) {
    let h = Number(time[1])
    const m = Number(time[2] ?? 0)
    if (time[3] === 'pm' && h < 12) h += 12
    if (time[3] === 'am' && h === 12) h = 0
    if (h > 23 || m > 59) return null
    return { found: { minutes: h * 60 + m }, used: prev === 'at' ? 2 : 1 }
  }
  if (last === 'noon') return { found: { minutes: 720 }, used: prev === 'at' ? 2 : 1 }
  if (last === 'tonight') return { found: { date: today, minutes: 20 * 60 }, used: 1 }
  if (last === 'today') return { found: { date: today }, used: 1 }
  if (last === 'tomorrow' || last === 'tmr' || last === 'tmrw') return { found: { date: addDays(today, 1) }, used: 1 }
  // "next week" (its Monday), "next month" (its first day), "next friday".
  if (prev === 'next' && last === 'week') return { found: { date: addDays(today, 7 - ((today.getDay() + 6) % 7)) }, used: 2 }
  if (prev === 'next' && last === 'month') return { found: { date: new Date(today.getFullYear(), today.getMonth() + 1, 1) }, used: 2 }
  const weekday = named(last, WEEKDAYS)
  if (weekday >= 0) {
    // The coming one (today, if it is that day); "next friday" is the one after.
    let ahead = (weekday - today.getDay() + 7) % 7
    if (prev === 'next') ahead += ahead === 0 ? 7 : 0
    return { found: { date: addDays(today, ahead) }, used: prev === 'next' || prev === 'on' ? 2 : 1 }
  }
  // "in 3 days", "in 2 weeks".
  if (prev2 === 'in' && /^\d{1,3}$/.test(prev) && /^(days?|weeks?)$/.test(last)) return { found: { date: addDays(today, Number(prev) * (last.startsWith('week') ? 7 : 1)) }, used: 3 }
  // "24 dec", "dec 24", "24/12", "2026-12-24", with an optional "on" in front.
  let date: Date | null = null
  let used = 0
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(last)
  const slash = /^(\d{1,2})[/-](\d{1,2})$/.exec(last)
  if (iso) ((date = dayOfMonth(Number(iso[3]), Number(iso[2]) - 1, today, Number(iso[1]))), (used = 1))
  else if (slash) ((date = dayOfMonth(Number(slash[1]), Number(slash[2]) - 1, today)), (used = 1))
  else if (prev && /^\d{1,2}$/.test(prev) && named(last, MONTHS) >= 0) ((date = dayOfMonth(Number(prev), named(last, MONTHS), today)), (used = 2))
  else if (prev && /^\d{1,2}$/.test(last) && named(prev, MONTHS) >= 0) ((date = dayOfMonth(Number(last), named(prev, MONTHS), today)), (used = 2))
  if (!date) return null
  if (w[n - used - 1] === 'on') used++
  return { found: { date }, used }
}

export function parseQuick(input: string, now = new Date()): Quick {
  let words = input.trim().split(/\s+/).filter(Boolean)
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  let priority = 0
  // "!", "!!" or "!!!" at the end: low, medium, high (as Apple writes them: 9, 5, 1).
  const bang = /^!{1,3}$/.exec(words[words.length - 1] ?? '')
  if (bang && words.length > 1) {
    priority = [9, 5, 1][bang[0].length - 1]
    words = words.slice(0, -1)
  }
  let date: Date | undefined
  let minutes: number | undefined
  // A date and a time, either way round; never the whole line.
  for (let i = 0; i < 2 && words.length > 1; i++) {
    const t = tail(words, today)
    if (!t || t.used >= words.length) break
    if (t.found.date && date) break
    if (t.found.minutes !== undefined && minutes !== undefined) break
    date = t.found.date ?? date
    minutes = t.found.minutes ?? minutes
    words = words.slice(0, -t.used)
  }
  const title = words.join(' ')
  if (!date && minutes === undefined) return { title: input.trim().replace(/\s+!{1,3}$/, ''), priority }
  if (minutes === undefined) return { title, due: dayKey(date!), allDay: true, priority }
  let day = date ?? today
  // A time alone that has passed today is tomorrow's.
  if (!date && new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, minutes) <= now) day = addDays(day, 1)
  return { title, due: new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, minutes).toISOString(), allDay: false, priority }
}
