// A failed web read's recovery (src/data/agentWebRecovery.ts): which results count as the reader's
// failure, the label that never cuts an address silently, what may be opened, and how pasted page
// text is staged. Pure logic, no browser or server: pnpm check:agents-web-recovery
import assert from 'node:assert/strict'
import { appendToDraft, failedWebRead, labelUrl, openableUrl, pageTextParts } from '../src/data/agentWebRecovery.ts'

const call = (url: unknown) => ({ name: 'web_fetch', arguments: { url } })
const err = (error: string) => JSON.stringify({ error })
const long = `https://www.example.com/${'a'.repeat(120)}`

// The reader's failures are recognised, with the address and the error as given.
assert.deepEqual(failedWebRead(call('https://a.example/x'), err('Page not found (404): the address may be wrong')), { url: 'https://a.example/x', error: 'Page not found (404): the address may be wrong' })
assert.deepEqual(failedWebRead(call('https://a.example/x'), err("Couldn't read the page (forbidden): try another source.")), { url: 'https://a.example/x', error: "Couldn't read the page (forbidden): try another source." })
// What the user, a timeout or a cancelled run did is not the reader's doing: no recovery card.
for (const e of ['The user declined this. Ask what they want instead.', 'The user declined this and said: no', 'The user did not allow reading that address. Read addresses from search results.', 'The user denied this call. Do without it', 'Not run: nobody answered within 12 hours', 'Not run: the run was cancelled', 'Only http(s) URLs']) assert.equal(failedWebRead(call('https://a.example/x'), err(e)), null, e)
// Not failures, not web reads, no result yet, no address, not JSON.
assert.equal(failedWebRead(call('https://a.example/x'), JSON.stringify({ title: 't', content: 'c' })), null)
assert.equal(failedWebRead({ name: 'web_search', arguments: { url: 'https://a.example' } }, err('x')), null)
assert.equal(failedWebRead(call('https://a.example/x'), undefined), null)
assert.equal(failedWebRead(call(5), err('x')), null)
assert.equal(failedWebRead(call(''), err('x')), null)
assert.equal(failedWebRead(call('https://a.example/x'), 'plain text'), null)
assert.equal(failedWebRead(call('https://a.example/x'), '[1,2]'), null)

// A label shows 80 characters of the address and says so when it cuts; the whole address is elsewhere.
assert.equal(labelUrl('https://www.example.com/a'), 'example.com/a')
assert.equal(labelUrl(long).length, 81)
assert.ok(labelUrl(long).endsWith('…'))
assert.equal(labelUrl(`https://${'b'.repeat(80)}`), 'b'.repeat(80))

// Only web addresses open.
assert.equal(openableUrl('https://a.example/x?y=1#z'), 'https://a.example/x?y=1#z')
assert.equal(openableUrl(' http://a.example '), 'http://a.example/')
for (const bad of ['javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', 'ftp://a.example', 'a.example/x', '', '  ', null, 5, 'https://']) assert.equal(openableUrl(bad), null, String(bad))

// Short text goes in the box after a line naming the page; the whole address is in the line.
const short = pageTextParts('https://a.example/x', 'Hello\r\nworld  ', 5000)
assert.equal(short.file, undefined)
assert.ok(short.message.includes('https://a.example/x') && short.message.endsWith('Hello\nworld'))
// Long text, or text that would overflow the box, rides along as a file naming the page.
const big = pageTextParts('https://a.example/x', 'x'.repeat(5000), 5000)
assert.ok(big.file?.startsWith('Source: https://a.example/x\n\n') && !big.message.includes('xxxx'))
// The naming line counts: text just under the limit that the line pushes over becomes a file.
const edge = pageTextParts('https://a.example/x', 'y'.repeat(4990), 5000)
assert.ok(edge.file, 'the line naming the page counts toward the limit')
// What is typed already counts toward the room left in the box.
assert.ok(pageTextParts('https://a.example/x', 'z'.repeat(100), 5000, 19_900, 20_000).file)
assert.equal(pageTextParts('https://a.example/x', 'z'.repeat(100), 5000, 100, 20_000).file, undefined)

// The draft is kept: new text goes after it, a blank line between; an empty box just gets it.
assert.equal(appendToDraft('my question', 'page'), 'my question\n\npage')
assert.equal(appendToDraft('my question  \n', 'page'), 'my question\n\npage')
assert.equal(appendToDraft('', 'page'), 'page')
assert.equal(appendToDraft('  \n', 'page'), 'page')
console.log('agents-web-recovery: ok')
