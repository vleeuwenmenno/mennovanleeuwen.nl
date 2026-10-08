import { useEffect, useState } from 'react'

// A year of daily contribution counts from GitHub and git.mvl.sh, written by scripts/fetch-data.ts
// (neither source can be read from the browser directly).

export type ContributionDay = { date: string; github: number; forgejo: number }
export type Contributions = { generatedAt: string; days: ContributionDay[] }

let cache: Promise<Contributions | null> | null = null

export function loadContributions(): Promise<Contributions | null> {
  cache ??= fetch('/contributions.json')
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
  return cache
}

export function useContributions() {
  const [data, setData] = useState<Contributions | null | undefined>(undefined)
  useEffect(() => {
    loadContributions().then(setData)
  }, [])
  return data
}

export type Source = 'all' | 'github' | 'forgejo'
export const countFor = (d: ContributionDay, s: Source) => (s === 'github' ? d.github : s === 'forgejo' ? d.forgejo : d.github + d.forgejo)

/** GitHub-style levels 0-4, scaled to this person's busier days rather than a fixed number. */
export function levels(days: ContributionDay[], s: Source) {
  const counts = days.map((d) => countFor(d, s)).filter((n) => n > 0).sort((a, b) => a - b)
  const q = (p: number) => counts[Math.min(counts.length - 1, Math.floor(p * counts.length))] ?? 1
  const [a, b, c] = [q(0.25), q(0.5), q(0.75)]
  return (n: number) => (n === 0 ? 0 : n <= a ? 1 : n <= b ? 2 : n <= c ? 3 : 4)
}
