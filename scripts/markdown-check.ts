// Checks the Markdown parser behind MarkdownPreview (src/data/markdown/parse.ts) and the code
// highlighter next to it: `node scripts/markdown-check.ts`. Each case parses some Markdown and
// compares the tree, written out as compact HTML, with what CommonMark (and GitHub's additions)
// would render. The tree is what MarkdownPreview maps to React elements one to one.

import { parseMarkdown, type Block, type Inline } from '../src/data/markdown/parse.ts'
import { highlight } from '../src/data/markdown/highlight.ts'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function inl(nodes: Inline[]): string {
  return nodes
    .map((n) => {
      switch (n.type) {
        case 'text':
          return esc(n.text)
        case 'soft':
          return '\n'
        case 'br':
          return '<br>'
        case 'code':
          return `<code>${esc(n.text)}</code>`
        case 'ruby':
          return `<ruby>${esc(n.base)}<rp>(</rp><rt>${esc(n.reading)}</rt><rp>)</rp></ruby>`
        case 'em':
        case 'strong':
        case 'del':
          return `<${n.type}>${inl(n.children)}</${n.type}>`
        case 'link':
          return `<a href="${esc(n.href)}"${n.title ? ` title="${esc(n.title)}"` : ''}>${inl(n.children)}</a>`
        case 'image':
          return `<img src="${esc(n.src)}" alt="${esc(n.alt)}">`
      }
    })
    .join('')
}

function html(blocks: Block[], tight = false): string {
  return blocks
    .map((b) => {
      switch (b.type) {
        case 'paragraph':
          return tight ? inl(b.children) : `<p>${inl(b.children)}</p>`
        case 'heading':
          return `<h${b.level}>${inl(b.children)}</h${b.level}>`
        case 'hr':
          return '<hr>'
        case 'code':
          return `<pre${b.lang ? ` lang="${b.lang}"` : ''}>${esc(b.text)}</pre>`
        case 'quote':
          return `<blockquote>${html(b.children)}</blockquote>`
        case 'list': {
          const tag = b.ordered ? 'ol' : 'ul'
          const items = b.items.map((it) => `<li>${it.checked === null ? '' : it.checked ? '[x]' : '[ ]'}${html(it.children, b.tight)}</li>`).join('')
          return `<${tag}${b.ordered && b.start !== 1 ? ` start="${b.start}"` : ''}>${items}</${tag}>`
        }
        case 'table': {
          const al = (j: number) => (b.align[j] ? ` ${b.align[j]}` : '')
          const head = b.head.map((c, j) => `<th${al(j)}>${inl(c)}</th>`).join('')
          const rows = b.rows.map((r) => `<tr>${r.map((c, j) => `<td${al(j)}>${inl(c)}</td>`).join('')}</tr>`).join('')
          return `<table><tr>${head}</tr>${rows}</table>`
        }
      }
    })
    .join('')
}

const cases: [name: string, md: string, want: string][] = [
  // Emphasis
  ['the Sakura answer', '**Sakura has battery *cooling* but no battery *heating*.**', '<p><strong>Sakura has battery <em>cooling</em> but no battery <em>heating</em>.</strong></p>'],
  ['strong and em together', '***both*** and ___both___', '<p><em><strong>both</strong></em> and <em><strong>both</strong></em></p>'],
  ['em around strong', '*a **b** c*', '<p><em>a <strong>b</strong> c</em></p>'],
  ['strong around em with underscores', '__a _b_ c__', '<p><strong>a <em>b</em> c</strong></p>'],
  ['strong then em closing together', '**bold *both***', '<p><strong>bold <em>both</em></strong></p>'],
  ['rule of three', '*foo**bar**baz*', '<p><em>foo<strong>bar</strong>baz</em></p>'],
  ['snake_case stays literal', 'call snake_case_name and __init__ here', '<p>call snake_case_name and <strong>init</strong> here</p>'],
  ['intraword asterisks do emphasise', 'un*frigging*believable', '<p>un<em>frigging</em>believable</p>'],
  ['unmatched delimiters stay text', '**open and *half', '<p>**open and *half</p>'],
  ['spaced asterisks are not emphasis', 'a * b * c and 2*3*4', '<p>a * b * c and 2<em>3</em>4</p>'],
  ['strikethrough', '~~gone~~ but ~10 minutes stays', '<p><del>gone</del> but ~10 minutes stays</p>'],
  ['emphasis in a link', '[**bold** link](https://a.example)', '<p><a href="https://a.example"><strong>bold</strong> link</a></p>'],
  // Code spans
  ['code span', 'run `ls -la` now', '<p>run <code>ls -la</code> now</p>'],
  ['double backticks around one', '`` a ` b ``', '<p><code>a ` b</code></p>'],
  ['no formatting in code', '`**not bold** _x_`', '<p><code>**not bold** _x_</code></p>'],
  ['unclosed backticks', 'a `b', '<p>a `b</p>'],
  // Escapes, entities, breaks, HTML
  ['backslash escapes', '\\*not em\\* \\_x\\_ \\\\ \\| \\#', '<p>*not em* _x_ \\ | #</p>'],
  ['entities', 'a &amp; b &copy; &#65; &bogus;', '<p>a &amp; b © A &amp;bogus;</p>'],
  ['hard break by spaces', 'one  \ntwo', '<p>one<br>two</p>'],
  ['hard break by backslash', 'one\\\ntwo', '<p>one<br>two</p>'],
  ['soft break', 'one\ntwo', '<p>one\ntwo</p>'],
  ['raw HTML is text', 'a <b>bold</b> <script>x</script>', '<p>a &lt;b&gt;bold&lt;/b&gt; &lt;script&gt;x&lt;/script&gt;</p>'],
  // Links
  ['inline link with title', '[site](https://a.example/x "Title")', '<p><a href="https://a.example/x" title="Title">site</a></p>'],
  ['relative and anchor links', '[r](docs/a.md) [h](#top) [m](mailto:a@b.c)', '<p><a href="docs/a.md">r</a> <a href="#top">h</a> <a href="mailto:a@b.c">m</a></p>'],
  ['javascript: is not linked', '[click](javascript:alert(1)) <javascript:alert(1)>', '<p>click javascript:alert(1)</p>'],
  ['escaped scheme is not linked', '[x](javascript\\:alert(1)) [y](data:text/html,hi)', '<p>x y</p>'],
  ['reference links', '[one][a], [A] and [two][]\n\n[a]: https://a.example "T"\n[two]: <https://b.example>', '<p><a href="https://a.example" title="T">one</a>, <a href="https://a.example" title="T">A</a> and <a href="https://b.example">two</a></p>'],
  ['missing reference stays text', '[nope][missing]', '<p>[nope][missing]</p>'],
  ['autolinks', '<https://a.example/b> and <me@x.example>', '<p><a href="https://a.example/b">https://a.example/b</a> and <a href="mailto:me@x.example">me@x.example</a></p>'],
  ['bare URL without trailing punctuation', 'See https://a.example/x. Or (https://a.example/y), https://en.wikipedia.org/wiki/Foo_(bar)!', '<p>See <a href="https://a.example/x">https://a.example/x</a>. Or (<a href="https://a.example/y">https://a.example/y</a>), <a href="https://en.wikipedia.org/wiki/Foo_(bar)">https://en.wikipedia.org/wiki/Foo_(bar)</a>!</p>'],
  ['bare URL in bold', '**https://a.example**', '<p><strong><a href="https://a.example">https://a.example</a></strong></p>'],
  ['URL as link text', '[https://a.example](https://a.example)', '<p><a href="https://a.example">https://a.example</a></p>'],
  ['images', '![cat](https://a.example/c.png) ![dot](data:image/png;base64,AAA=) ![rel](pic.png) ![bad](javascript:x)', '<p><img src="https://a.example/c.png" alt="cat"> <img src="data:image/png;base64,AAA=" alt="dot"> <a href="pic.png">rel</a> bad</p>'],
  // Headings and rules
  ['ATX headings', '# One #\n###### Six\n#no', '<h1>One</h1><h6>Six</h6><p>#no</p>'],
  ['setext headings', 'Big\n===\n\nSmaller\n---', '<h1>Big</h1><h2>Smaller</h2>'],
  ['a lone --- is a rule', 'para\n\n---\n\n***\n- - -', '<p>para</p><hr><hr><hr>'],
  ['a paragraph then a single -', 'Here:\n-', '<p>Here:\n-</p>'],
  // Lists
  ['nested bullets, 2 spaces', '- a\n  - b\n    - c\n- d', '<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li><li>d</li></ul>'],
  ['nested bullets, 4 spaces and tabs', '* a\n    * b\n\t* c', '<ul><li>a<ul><li>b</li><li>c</li></ul></li></ul>'],
  ['ordered start', '3. three\n4. four', '<ol start="3"><li>three</li><li>four</li></ol>'],
  ['sublist under an ordered item, 2 spaces', '1. **Step**\n  - detail\n2. Next', '<ol><li><strong>Step</strong><ul><li>detail</li></ul></li><li>Next</li></ol>'],
  ['task list', '- [ ] todo\n- [x] done\n- [link](#x)', '<ul><li>[ ]todo</li><li>[x]done</li><li><a href="#x">link</a></li></ul>'],
  ['loose list', '- a\n\n- b', '<ul><li><p>a</p></li><li><p>b</p></li></ul>'],
  ['multi-paragraph item with code', '- item\n\n  more\n\n  ```sh\n  ls\n  ```\n- next', '<ul><li><p>item</p><p>more</p><pre lang="sh">ls</pre></li><li><p>next</p></li></ul>'],
  ['list right after a paragraph', 'Steps:\n- one\n- two', '<p>Steps:</p><ul><li>one</li><li>two</li></ul>'],
  ['a 2. does not interrupt a paragraph', 'In\n2. no', '<p>In\n2. no</p>'],
  ['bullet change starts a new list', '- a\n+ b', '<ul><li>a</li></ul><ul><li>b</li></ul>'],
  ['lazy continuation in an item', '- a\ncontinued', '<ul><li>a\ncontinued</li></ul>'],
  // Quotes
  ['quote with a list and a nested quote', '> quote\n> - one\n> - two\n>\n> > deeper', '<blockquote><p>quote</p><ul><li>one</li><li>two</li></ul><blockquote><p>deeper</p></blockquote></blockquote>'],
  ['lazy quote continuation', '> a\nb', '<blockquote><p>a\nb</p></blockquote>'],
  ['code in a quote', '> ```js\n> x()\n> ```', '<blockquote><pre lang="js">x()</pre></blockquote>'],
  // Code blocks
  ['backtick and tilde fences', '```ts\nconst a = 1\n```\n~~~\n```inside```\n~~~', '<pre lang="ts">const a = 1</pre><pre>```inside```</pre>'],
  ['an unclosed fence runs to the end', 'text\n```py\nprint(1)\n\nmore', '<p>text</p><pre lang="py">print(1)\n\nmore</pre>'],
  ['indented code', '    code\n      more\n\npara', '<pre>code\n  more</pre><p>para</p>'],
  ['a longer closing fence', '````\n```\nstill code\n````', '<pre>```\nstill code</pre>'],
  ['tabs in code survive', '```go\n\tfmt.Println()\n```', '<pre lang="go">\tfmt.Println()</pre>'],
  // Tables
  ['table with alignment and inline marks', '| a | b | c |\n|:--|:-:|--:|\n| *x* | `y` | \\| |\n| 1 |', '<table><tr><th left>a</th><th center>b</th><th right>c</th></tr><tr><td left><em>x</em></td><td center><code>y</code></td><td right>|</td></tr><tr><td left>1</td><td center></td><td right></td></tr></table>'],
  ['table without outer pipes, then text', 'Name | Value\n--- | ---\nk | v\n\nafter', '<table><tr><th>Name</th><th>Value</th></tr><tr><td>k</td><td>v</td></tr></table><p>after</p>'],
  ['table after a paragraph line', 'Intro\n| a | b |\n|---|---|\n| 1 | 2 |', '<p>Intro</p><table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>'],
  ['mismatched delimiter row is no table', '| a | b |\n|---|', '<p>| a | b |\n|---|</p>'],
  // Furigana: {base|reading} becomes ruby
  ['furigana', '{漢字|かんじ}', '<p><ruby>漢字<rp>(</rp><rt>かんじ</rt><rp>)</rp></ruby></p>'],
  ['furigana, several in a line', '{日本語|にほんご}を{勉強|べんきょう}する', '<p><ruby>日本語<rp>(</rp><rt>にほんご</rt><rp>)</rp></ruby>を<ruby>勉強<rp>(</rp><rt>べんきょう</rt><rp>)</rp></ruby>する</p>'],
  ['furigana over a few words', '{東京 大学|とうきょう だいがく}', '<p><ruby>東京 大学<rp>(</rp><rt>とうきょう だいがく</rt><rp>)</rp></ruby></p>'],
  ['furigana over plain text', '{Tokyo|toh-kyoh}', '<p><ruby>Tokyo<rp>(</rp><rt>toh-kyoh</rt><rp>)</rp></ruby></p>'],
  ['furigana in bold, em and a link', '**{漢字|かんじ}** *{字|じ}* [{本|ほん}](https://a.example)', '<p><strong><ruby>漢字<rp>(</rp><rt>かんじ</rt><rp>)</rp></ruby></strong> <em><ruby>字<rp>(</rp><rt>じ</rt><rp>)</rp></ruby></em> <a href="https://a.example"><ruby>本<rp>(</rp><rt>ほん</rt><rp>)</rp></ruby></a></p>'],
  ['furigana inside bold between Japanese text', '私は**{日本語|にほんご}**を*{勉強|べんきょう}*する', '<p>私は<strong><ruby>日本語<rp>(</rp><rt>にほんご</rt><rp>)</rp></ruby></strong>を<em><ruby>勉強<rp>(</rp><rt>べんきょう</rt><rp>)</rp></ruby></em>する</p>'],
  ['furigana in strikethrough', '~~{字|じ}~~', '<p><del><ruby>字<rp>(</rp><rt>じ</rt><rp>)</rp></ruby></del></p>'],
  ['furigana in a heading and a list', '# {題|だい}\n\n- {項|こう}', '<h1><ruby>題<rp>(</rp><rt>だい</rt><rp>)</rp></ruby></h1><ul><li><ruby>項<rp>(</rp><rt>こう</rt><rp>)</rp></ruby></li></ul>'],
  ['furigana in table cells', '| {漢字|かんじ} | b |\n|---|---|\n| {本|ほん} | {字|じ}x |', '<table><tr><th><ruby>漢字<rp>(</rp><rt>かんじ</rt><rp>)</rp></ruby></th><th>b</th></tr><tr><td><ruby>本<rp>(</rp><rt>ほん</rt><rp>)</rp></ruby></td><td><ruby>字<rp>(</rp><rt>じ</rt><rp>)</rp></ruby>x</td></tr></table>'],
  ['furigana in a table without outer pipes', '{a|b} | c\n--- | ---\n{d|e} | f', '<table><tr><th><ruby>a<rp>(</rp><rt>b</rt><rp>)</rp></ruby></th><th>c</th></tr><tr><td><ruby>d<rp>(</rp><rt>e</rt><rp>)</rp></ruby></td><td>f</td></tr></table>'],
  ['not in a code span', '`{漢字|かんじ}` and {漢字|かんじ}', '<p><code>{漢字|かんじ}</code> and <ruby>漢字<rp>(</rp><rt>かんじ</rt><rp>)</rp></ruby></p>'],
  ['not in a code block', '```\n{漢字|かんじ}\n```', '<pre>{漢字|かんじ}</pre>'],
  ['not in an indented code block', '    {漢字|かんじ}', '<pre>{漢字|かんじ}</pre>'],
  ['an escaped brace stays literal', '\\{漢字|かんじ}', '<p>{漢字|かんじ}</p>'],
  ['html in furigana is text', '{<b>x</b>|<img src=x onerror=alert(1)>} {"a"|&amp;}', '<p><ruby>&lt;b&gt;x&lt;/b&gt;<rp>(</rp><rt>&lt;img src=x onerror=alert(1)&gt;</rt><rp>)</rp></ruby> <ruby>&quot;a&quot;<rp>(</rp><rt>&amp;amp;</rt><rp>)</rp></ruby></p>'],
  ['an empty base or reading stays literal', '{|かな} {漢字|} {  |  } {|}', '<p>{|かな} {漢字|} {  |  } {|}</p>'],
  ['malformed furigana stays literal', '{漢字} {漢字|かな {a|b|c} {a|{b}} {\n|x} {漢字}かな|', '<p>{漢字} {漢字|かな {a|b|c} {a|{b}} {\n|x} {漢字}かな|</p>'],
  ['a shell or template ${a|b} is not furigana', 'echo ${HOME|x} and {{a|b}}', '<p>echo ${HOME|x} and {{a|b}}</p>'],
  ['streaming: furigana still open', '{漢字|かん', '<p>{漢字|かん</p>'],
  ['braces and pipes elsewhere are untouched', 'obj = {a: 1} | b {x} and a|b', '<p>obj = {a: 1} | b {x} and a|b</p>'],
  // Streaming
  ['streaming: open strong', 'This is **impor', '<p>This is **impor</p>'],
  ['streaming: open link', 'see [the docs](https://a.exa', '<p>see [the docs](<a href="https://a.exa">https://a.exa</a></p>'],
]

let failed = 0
for (const [name, md, want] of cases) {
  const got = html(parseMarkdown(md))
  if (got === want) continue
  failed++
  console.log(`FAIL ${name}\n  markdown: ${JSON.stringify(md)}\n  want:     ${JSON.stringify(want)}\n  got:      ${JSON.stringify(got)}`)
}

// Highlighting: the classes a few snippets come out with.
const hl = (code: string, lang: string) =>
  highlight(code, lang)
    .filter((t) => t.cls)
    .map((t) => `${t.cls}:${t.text}`)
    .join(' ')
const hlCases: [name: string, got: string, want: string][] = [
  ['ts', hl('const x: Foo = load("a") // hi', 'ts'), 'kw:const type:Foo fn:load str:"a" com:// hi'],
  ['python', hl('def f(n=1):\n    return None  # done', 'python'), 'kw:def fn:f num:1 kw:return lit:None com:# done'],
  ['bash', hl('ls -la $HOME | grep "x" # files', 'bash'), 'fn:ls attr:-la var:$HOME fn:grep str:"x" com:# files'],
  ['json', hl('{"a": 1, "b": true}', 'json'), 'attr:"a" num:1 attr:"b" lit:true'],
  ['diff', hl('@@ -1 +1 @@\n-old\n+new', 'diff'), 'fn:@@ -1 +1 @@ del:-old add:+new'],
  ['unclosed block comment', hl('a /* open\nstill', 'js'), 'com:/* open\nstill'],
  ['unknown language', hl('anything', 'klingon'), ''],
]
for (const [name, got, want] of hlCases) {
  if (got === want) continue
  failed++
  console.log(`FAIL highlight ${name}\n  want: ${JSON.stringify(want)}\n  got:  ${JSON.stringify(got)}`)
}

// Robustness: every prefix of a document (what streaming shows on the way) and random soup from
// Markdown's punctuation must parse without throwing.
const sample = cases.map(([, md]) => md).join('\n\n')
let crashes = 0
const tryParse = (md: string) => {
  try {
    parseMarkdown(md)
  } catch (e) {
    if (!crashes++) console.log(`FAIL parse threw on ${JSON.stringify(md.slice(-80))}: ${(e as Error).stack}`)
  }
}
for (let i = 0; i <= sample.length; i += 3) tryParse(sample.slice(0, i))
let seed = 7
const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n)
const soup = ['*', '**', '_', '`', '```', '~~', '[', ']', '(', ')', '!', '<', '>', '\\', '#', '-', '+', '1.', '|', ':', ' ', '  ', '\t', '\n', '\n\n', 'a', 'word', 'https://x.y', '&amp;', '[x]', '    ', '{', '}', '{a|b}', '{漢|か}']
for (let i = 0; i < 3000; i++) tryParse(Array.from({ length: 5 + rand(60) }, () => soup[rand(soup.length)]).join(''))
if (crashes) failed++

// Speed: a long streamed answer is parsed again on every chunk, so one parse must stay cheap.
const big = Array.from({ length: 300 }, (_, i) => `## Part ${i}\n\nSome **bold *nested* text** with \`code\`, a [link](https://a.example/${i}) and snake_case.\n\n- item one\n  - nested\n- [x] task\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n\`\`\`ts\nconst x = ${i}\n\`\`\`\n`).join('\n')
const t0 = performance.now()
for (let i = 0; i < 5; i++) parseMarkdown(big)
const ms = (performance.now() - t0) / 5
const fast = ms < 150
if (!fast) failed++

const total = cases.length + hlCases.length + 2
console.log(`${total - failed} of ${total} checks pass (${crashes} crashes in prefixes and fuzzing); a ${Math.round(big.length / 1024)} KB document parses in ${ms.toFixed(1)} ms${fast ? '' : ' (TOO SLOW)'}`)
process.exit(failed ? 1 : 0)
