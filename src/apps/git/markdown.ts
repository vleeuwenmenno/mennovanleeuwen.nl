import type { GitRepo } from '../../data/gitTypes'

// READMEs and pull request bodies often mix HTML into their Markdown (a centred logo, badges in a
// <p>, <details>). MarkdownPreview never renders HTML, so the common tags become Markdown here and
// the rest are dropped, leaving their text. Nothing in the result is ever used as HTML.

const attr = (tag: string, name: string) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)?.slice(1).find((x) => x !== undefined) ?? ''

export function htmlToMarkdown(text: string): string {
  // Leave fenced and inline code alone: split them out first.
  const parts = text.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/)
  return parts
    .map((p, i) => {
      if (i % 2) return p
      return p
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<img\b[^>]*>/gi, (tag) => {
          const src = attr(tag, 'src')
          return src ? `![${attr(tag, 'alt').replace(/[[\]]/g, '')}](${src.replace(/ /g, '%20')})` : ''
        })
        .replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, (tag, inner: string) => {
          const href = attr(tag, 'href')
          return href ? `[${inner.trim()}](${href.replace(/ /g, '%20')})` : inner
        })
        .replace(/<br\s*\/?>/gi, '  \n')
        .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n: string, inner: string) => `\n\n${'#'.repeat(Number(n))} ${inner.trim()}\n\n`)
        .replace(/<summary\b[^>]*>([\s\S]*?)<\/summary>/gi, (_m, inner: string) => `\n\n**${inner.trim()}**\n\n`)
        .replace(/<\/?(b|strong)>/gi, '**')
        .replace(/<\/?(i|em)>/gi, '_')
        .replace(/<\/?code>/gi, '`')
        .replace(/<\/?(p|div|details|picture|center|span|sup|sub|kbd|table|thead|tbody|tr|td|th|ul|ol|li|source|video|hr)\b[^>]*>/gi, (t) => (/^<\/?(p|div|details|center|table|tr|ul|ol|hr)\b/i.test(t) ? '\n\n' : ''))
        .replace(/\n{3,}/g, '\n\n')
    })
    .join('')
}

/** Relative links and images in a README point into the repository, as on the host's own page. */
export function repoUrlResolver(repo: GitRepo) {
  const branch = encodeURIComponent(repo.defaultBranch).replace(/%2F/g, '/')
  const github = repo.kind === 'github'
  return (url: string, image: boolean): string => {
    if (!url || /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//') || url.startsWith('#')) return url
    const path = url.replace(/^\.?\//, '').replace(/^\/+/, '')
    if (github) return image ? `${repo.url}/raw/${branch}/${path}` : `${repo.url}/blob/${branch}/${path}`
    return image ? `${repo.url}/raw/branch/${branch}/${path}` : `${repo.url}/src/branch/${branch}/${path}`
  }
}

/** In a pull request or issue body, a path is relative to the host ("/owner/repo/pull/2"). */
export function hostUrlResolver(web: string) {
  return (url: string): string => (url.startsWith('/') && !url.startsWith('//') ? `${web}${url}` : url)
}
