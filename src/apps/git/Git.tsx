import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { GitRepoList, RepoHit } from '../../data/gitTypes'
import { signIn, useAccount } from '../../os/account'
import { localPref } from '../../os/localPref'
import { useIsMobile } from '../../os/useIsMobile'
import { useWM, type WinState } from '../../os/wm'
import { forget, useGet } from './data'
import { repoApi, routeToView, sameRepo, stackFor, viewToRoute, type At, type GitView } from './route'
import { CommitView, IssueView, PullView, RepoList, RepoView, type Nav } from './views'
import './git.css'

// The Git app: your repositories on GitHub and linked Gitea/Forgejo instances, and per repository
// its README, pull requests (conversation, commits, changed files), issues and commits. It only
// reads (server/git.ts); writing, reviewing and the rest are links out to the host's own pages.
//
// Wide windows keep the repository list on the left; narrow ones and phones show one view at a
// time, with Back. A window opened with props.route (src/apps/git/route.ts) starts on that
// repository, pull request or issue; otherwise on the repository that was open last in this
// browser.

/** The repository open last, per browser (storage may be blocked: then it just isn't kept). */
const lastRepo = localPref<string>('mvlos.git.lastRepo', (raw) => raw ?? '', (v) => v)

function initialStack(route: string | undefined): GitView[] {
  const v = routeToView(route) ?? routeToView(lastRepo.get())
  return v ? stackFor(v) : [{ v: 'list' }]
}

const crumb = (v: GitView): string => (v.v === 'list' ? 'Repositories' : v.v === 'repo' ? `${v.owner}/${v.repo}` : v.v === 'pull' ? `PR #${v.number}` : v.v === 'issue' ? `Issue #${v.number}` : v.sha.slice(0, 7))

export function Git({ win }: { win: WinState }) {
  const account = useAccount()
  const wm = useWM()
  const mobile = useIsMobile()
  const root = useRef<HTMLDivElement>(null)
  const [narrowWin, setNarrowWin] = useState(false)
  useEffect(() => {
    const el = root.current
    if (!el) return
    const ro = new ResizeObserver(() => setNarrowWin(el.clientWidth < 760))
    ro.observe(el)
    return () => ro.disconnect()
  }, [account.status])
  const narrow = mobile || narrowWin

  const [stack, setStack] = useState<GitView[]>(() => initialStack(win.props.route))
  const top = stack[stack.length - 1]
  const main = useRef<HTMLDivElement>(null)

  // Opened again with a route (Spotlight's "Open in Git"): go there.
  const opened = useRef(win.props.t)
  useEffect(() => {
    if (win.props.t === opened.current) return
    opened.current = win.props.t
    const v = routeToView(win.props.route)
    if (v) setStack(stackFor(v))
  }, [win.props.route, win.props.t])

  useEffect(() => {
    if (top.v !== 'list') lastRepo.set(viewToRoute({ v: 'repo', src: top.src, owner: top.owner, repo: top.repo, tab: 'overview' }))
    main.current?.scrollTo?.({ top: 0 })
  }, [top])

  const signedIn = account.status === 'user'
  const list = useGet<GitRepoList>(signedIn ? '/api/repos' : null)
  const sources = list.data?.sources

  const nav: Nav = useMemo(
    () => ({
      go: (v) => setStack((s) => [...s, v]),
      replace: (v) => setStack((s) => [...s.slice(0, -1), v]),
      hostLabel: (src) => sources?.find((s) => s.id === src)?.label ?? (src === 'github' ? 'GitHub' : 'the code host'),
      repoWeb: (at) => `${sources?.find((s) => s.id === at.src)?.web ?? 'https://github.com'}/${at.owner}/${at.repo}`,
    }),
    [sources],
  )
  const back = useCallback(() => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)), [])
  const openRepo = (r: RepoHit) => {
    const [owner, repo] = r.fullName.split('/')
    const at: At = { src: r.source, owner, repo }
    // Already open: back to its overview.
    setStack(stackFor({ v: 'repo', ...at, tab: top.v === 'repo' && sameRepo(top, at) ? top.tab : 'overview' }))
  }
  const reloadList = () => {
    forget('/api/repos')
    list.reload()
  }
  // Reload: the open view loads again, from the host (past the server's cache).
  const [generation, setGeneration] = useState(0)
  const reloadView = () => {
    if (top.v === 'list') return reloadList()
    forget(repoApi(top))
    setGeneration((g) => g + 1)
  }

  const onKey = (e: KeyboardEvent) => {
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement
    if (e.altKey && e.key === 'ArrowLeft' && !typing) {
      e.preventDefault()
      back()
    }
  }

  if (account.status !== 'user') {
    return (
      <div className="git git-gate" ref={root}>
        <div className="git-gate-box">
          <h2>Git</h2>
          {account.status === 'loading' ? (
            <p className="muted">Checking your account…</p>
          ) : account.status === 'off' ? (
            <p>Sign-in isn't set up on this server, so there are no repositories to show.</p>
          ) : (
            <>
              <p>Sign in with GitHub to browse your repositories, pull requests, issues and commits, on GitHub and any Gitea or Forgejo instance you link.</p>
              <button className="git-btn is-primary" onClick={signIn}>
                Sign in with GitHub
              </button>
            </>
          )}
        </div>
      </div>
    )
  }

  const current: At | null = top.v === 'list' ? null : top
  const listPane = <RepoList list={list} current={current} onOpen={openRepo} onReload={reloadList} onSettings={() => wm.open('settings', { section: 'instances', t: String(Date.now()) })} />
  const showList = narrow ? top.v === 'list' : true

  return (
    <div ref={root} className={`git ${narrow ? 'is-narrow' : ''}`} onKeyDown={onKey}>
      {showList && <aside className="git-side">{listPane}</aside>}
      {(!narrow || top.v !== 'list') && (
        <main className="git-main" ref={main}>
          {top.v !== 'list' && (
            <nav className="git-crumbs" aria-label="Where you are">
              {stack.length > 1 && (
                <button className="git-btn is-icon" onClick={back} title="Back (Alt+←)" aria-label="Back">
                  ←
                </button>
              )}
              <span className="git-crumb-list">
                {stack.map((v, i) =>
                  i === stack.length - 1 ? (
                    <span key={i} className="git-crumb is-here" aria-current="page">
                      {crumb(v)}
                    </span>
                  ) : narrow || i > 0 ? (
                    <span key={i}>
                      <button className="git-crumb" onClick={() => setStack(stack.slice(0, i + 1))}>
                        {crumb(v)}
                      </button>
                      <span className="git-crumb-sep" aria-hidden>
                        /
                      </span>
                    </span>
                  ) : null,
                )}
              </span>
              <button className="git-btn is-icon git-crumb-reload" onClick={reloadView} title="Reload" aria-label="Reload">
                ↻
              </button>
            </nav>
          )}
          {top.v === 'list' && (
            <div className="git-empty">
              <p className="muted">Pick a repository on the left.</p>
            </div>
          )}
          {top.v === 'repo' && <RepoView key={generation} view={top} nav={nav} />}
          {top.v === 'pull' && <PullView key={generation} view={top} nav={nav} />}
          {top.v === 'issue' && <IssueView key={generation} view={top} nav={nav} />}
          {top.v === 'commit' && <CommitView key={generation} view={top} nav={nav} />}
        </main>
      )}
    </div>
  )
}
