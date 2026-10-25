// Checks the emoji shortcodes (src/data/emoji): `node scripts/emoji-check.ts`. Lookup, replacement
// (code, URLs, times and unknown names left alone), the typing rules behind the composer's and the
// Notebook's autocomplete, and the ranking of search.

import { emojiTyping, loadEmoji, lookup, replaceShortcodes, search, hasShortcode, emojiReady } from '../src/data/emoji/index.ts'

let failed = 0
function eq(name: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g === w) return
  failed++
  console.log(`FAIL ${name}\n  got:  ${g}\n  want: ${w}`)
}

// Before the names load, nothing is found and nothing changes.
eq('not ready', [emojiReady(), lookup('joy'), replaceShortcodes('a :joy: b'), search('jo'), emojiTyping('a :joy: ', 8)], [false, undefined, 'a :joy: b', [], null])

await loadEmoji()
eq('ready', emojiReady(), true)

// lookup: Discord, Slack and GitHub names, aliases, colons, case.
eq('rofl', lookup('rofl'), '🤣')
eq('joy', lookup(':joy:'), '😂')
eq('thumbsup', lookup('thumbsup'), '👍')
eq('+1', lookup('+1'), '👍')
eq('-1', lookup('-1'), '👎')
eq('fire', lookup('FIRE'), '🔥')
eq('heart', lookup('heart'), '❤️')
eq('flag_jp', lookup('flag_jp'), '🇯🇵')
eq('flag-jp', lookup('flag-jp'), '🇯🇵')
eq('100', lookup('100'), '💯')
eq('unknown', lookup('definitely_not_an_emoji'), undefined)

// replaceShortcodes
eq('basic', replaceShortcodes('so :rofl: funny'), 'so 🤣 funny')
eq('several', replaceShortcodes(':fire::fire: :tada:'), '🔥🔥 🎉')
eq('start and end', replaceShortcodes(':+1:'), '👍')
eq('unknown kept', replaceShortcodes('a :nope_nope: b'), 'a :nope_nope: b')
eq('known and unknown', replaceShortcodes(':joy: :nope_nope:'), '😂 :nope_nope:')
eq('time kept', replaceShortcodes('at 12:30:45 sharp'), 'at 12:30:45 sharp')
eq('url kept', replaceShortcodes('see http://x:80:fire:'), 'see http://x:80:fire:')
eq('ratio kept', replaceShortcodes('a:b:c'), 'a:b:c')
eq('single colon', replaceShortcodes('note: this'), 'note: this')
eq('empty', replaceShortcodes('::'), '::')
eq('hasShortcode', [hasShortcode('a :joy: b'), hasShortcode('12:30'), hasShortcode('x')], [true, false, false])

// search ranking: exact, then prefix (shorter first), then contains; one entry per emoji.
const s = search('joy')
eq('search exact first', s[0], { name: 'joy', emoji: '😂' })
const smi = search('smi', 20)
eq('search prefixes before contains', smi.findIndex((h) => !h.name.startsWith('smi')) === -1 || smi.slice(0, smi.findIndex((h) => !h.name.startsWith('smi'))).every((h) => h.name.startsWith('smi')), true)
eq('search limit', search('a', 5).length, 5)
eq('search unique glyphs', new Set(search('thumbs', 20).map((h) => h.emoji)).size, search('thumbs', 20).length)
eq('search none', search('qqqqzzzz'), [])
eq('search empty', search(''), [])
eq('search colon', search(':joy')[0]?.name, 'joy')
eq('search contains', search('laughing').some((h) => h.name.includes('laughing')), true)

// typing: a finished :name: plus the next character replaces it; ":ab" opens the list.
eq('type replace', emojiTyping('hi :joy: ', 9), { kind: 'replace', start: 3, end: 9, text: '😂 ' })
eq('type replace punctuation', emojiTyping(':fire:!', 7), { kind: 'replace', start: 0, end: 7, text: '🔥!' })
eq('type no char after', emojiTyping('hi :joy:', 8), null)
eq('type unknown', emojiTyping('hi :nope_nope: ', 15), null)
eq('type query', emojiTyping('hi :ro', 6), { kind: 'query', start: 3, query: 'ro' })
eq('type one letter', emojiTyping('hi :r', 5), null)
eq('type query at start', emojiTyping(':smi', 4), { kind: 'query', start: 0, query: 'smi' })
eq('type time', emojiTyping('at 12:30', 8), null)
eq('type time done', emojiTyping('at 12:30:45 ', 12), null)
eq('type url', emojiTyping('http://example.com:80', 21), null)
eq('type url name', emojiTyping('http://x:fire', 13), null)
eq('type word colon', emojiTyping('note:fire', 9), null)
eq('type caret mid text', emojiTyping('hi :ro and more', 6), { kind: 'query', start: 3, query: 'ro' })
eq('type inline code', emojiTyping('use `a :ro', 10), null)
eq('type after closed code', emojiTyping('use `a` :ro', 11), { kind: 'query', start: 8, query: 'ro' })
eq('type replace in code', emojiTyping('`:joy: ', 7), null)
eq('type fenced block', emojiTyping('```js\nx :ro', 11), null)
eq('type after fence', emojiTyping('```js\nx\n```\nhi :ro', 18), { kind: 'query', start: 15, query: 'ro' })
eq('type next line fresh', emojiTyping('`open\nhi :ro', 12), { kind: 'query', start: 9, query: 'ro' })

if (failed) {
  console.log(`${failed} failed`)
  process.exit(1)
}
console.log('emoji: all checks passed')
