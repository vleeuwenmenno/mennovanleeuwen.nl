import { useEffect, useState } from 'react'
import { api } from './account'

// Spotlight's "Go to example.com": is the query a web address, and what does that page say about
// itself (server/preview.ts, signed in only, cached there for a day and here for the session).

export type LinkPreview = { url: string; host: string; title: string | null; description: string | null; image: string | null; icon: string | null; siteName: string | null }

// Common top-level domains: enough to tell "github.com" from "notes.txt". Not .md (it is a country,
// but here it is nearly always a Markdown file).
const TLDS = new Set(
  'com net org io dev app ai co me sh so to gg fm tv ly gl cc xyz tech info biz site online store blog page link cloud wiki news codes zone lol nl de be fr uk eu us ca au nz ch at se no dk fi is es it pl pt ie cz sk hu ro gr jp kr cn tw hk sg in br mx ar ru ua za'.split(' '),
)

/** A full URL when `q` looks like a web address (google.com, git.mvl.sh/x, https://…), else null. */
export function asWebAddress(q: string): string | null {
  const s = q.trim()
  if (!s || /\s/.test(s)) return null
  if (/^https?:\/\/[^\s/]+\.[^\s]+$/i.test(s)) return s
  const m = /^((?:[a-z0-9-]+\.)+([a-z]{2,24}))(?::\d+)?(?:[/?#]\S*)?$/i.exec(s)
  return m && TLDS.has(m[2].toLowerCase()) ? `https://${s}` : null
}

const cache = new Map<string, LinkPreview | null>()

export function useLinkPreview(url: string | null, enabled: boolean): LinkPreview | null {
  const [preview, setPreview] = useState<{ url: string; value: LinkPreview | null } | null>(null)
  useEffect(() => {
    if (!url || !enabled) return
    if (cache.has(url)) return setPreview({ url, value: cache.get(url)! })
    let live = true
    // A short wait so typing "github.co" on the way to ".com" doesn't fetch both.
    const t = setTimeout(() => {
      api<LinkPreview>(`/api/preview?url=${encodeURIComponent(url)}`).then(
        (p) => {
          cache.set(url, p)
          if (live) setPreview({ url, value: p })
        },
        () => {
          cache.set(url, null)
          if (live) setPreview({ url, value: null })
        },
      )
    }, 300)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [url, enabled])
  return preview && preview.url === url ? preview.value : null
}
