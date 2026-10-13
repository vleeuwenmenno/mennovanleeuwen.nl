import { useEffect, useMemo, useState } from 'react'
import { useAccount } from '../../os/account'
import { askText, ask } from '../../os/Dialogs'
import { IntegrationNotice } from '../../os/IntegrationNotice'
import { Select } from '../../os/Select'
import { useWM } from '../../os/wm'
import { allowSender, bootstrap, MARK_AFTER, removeAllowed, setMailPrefs, useMailAccounts, useMailPrefs, type Identity, type MailAccount, type MarkRead } from '../../data/mail'
import { parseSender, type RemoteMode } from '../../data/mailRemote'
import { Row, Seg, SetGroup, Toggle } from '../AppSettings'

// Settings → Apps → Mail: how the Mail app reads and writes. Read and written through the same
// store the app uses (src/data/mail.ts, synced), so an open Mail window follows a change at once.
// The accounts themselves are linked in Settings → Integrations → Mail (MailSettings.tsx).

/** The allow list shows a search box from this many entries on. */
const SEARCH_FROM = 8

const day = (at: number) => (at ? `Added ${new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}` : 'Added earlier')

export function MailPane() {
  const me = useAccount()
  const wm = useWM()
  const prefs = useMailPrefs()
  const { accounts } = useMailAccounts()
  const list = accounts ?? []
  return (
    <>
      {me.status === 'user' && <IntegrationNotice sub="mail" linked={list.length > 0} app="Mail" invite="Link a mail account to start using Mail." />}
      <SetGroup title="Reading">
        <ul className="set-list">
          <Row title="Mark as read" hint="Opening a conversation in Mail" stack>
            <Seg<MarkRead>
              label="Mark as read"
              value={prefs.markRead}
              options={[
                ['open', 'When opened'],
                ['after', 'After a delay'],
                ['never', 'Never'],
              ]}
              onChange={(markRead) => setMailPrefs({ markRead })}
            />
          </Row>
          {prefs.markRead === 'after' && (
            <Row title="Delay" hint="Closing or leaving the conversation sooner leaves it unread" stack>
              <Seg label="Seconds before it is marked as read" value={String(prefs.markReadAfter)} options={MARK_AFTER.map((n) => [String(n), `${n} seconds`])} onChange={(n) => setMailPrefs({ markReadAfter: Number(n) })} />
            </Row>
          )}
          <Row title="Remote content" hint="Images and styles that live on the sender's server, in HTML mail" stack>
            <Seg<RemoteMode>
              label="Remote content"
              value={prefs.remote}
              options={[
                ['ask', 'Ask'],
                ['allowed', 'Allowed senders'],
                ['always', 'Always load'],
              ]}
              onChange={(remote) => setMailPrefs({ remote })}
            />
          </Row>
          <Row title="Quoted text" hint="The earlier messages under a reply" stack>
            <Seg
              label="Quoted text"
              value={prefs.quotes}
              options={[
                ['collapsed', 'Collapsed'],
                ['expanded', 'Expanded'],
              ]}
              onChange={(quotes) => setMailPrefs({ quotes })}
            />
          </Row>
        </ul>
        <p className="muted set-help">
          {prefs.remote === 'ask' && 'Remote content stays blocked, and a bar over the message offers to load it, for that message or for its sender.'}
          {prefs.remote === 'allowed' && 'Remote content loads for the senders and domains on the list below, and stays blocked, with the bar to load it, for everyone else.'}
          {prefs.remote === 'always' && 'Remote content loads in every message. Whoever sent it can tell that you opened it, and from where.'} Tracking pixels (images made to be seen by nobody) stay blocked in every mode, and the sender's server never sees your address or browser: the message loads in a sandbox without a referrer.
        </p>
      </SetGroup>
      <AllowedSenders />
      <SetGroup title="Writing">
        <ul className="set-list">
          <Row title="Reply key" hint="R in Mail. A is always reply all" stack>
            <Seg
              label="What R does"
              value={prefs.replyAll}
              options={[
                [false, 'Reply'],
                [true, 'Reply all'],
              ]}
              onChange={(replyAll) => setMailPrefs({ replyAll })}
            />
          </Row>
          <Row title="Ctrl+Enter sends" hint="While writing a message. The Send button always does">
            <Toggle on={prefs.ctrlEnter} onChange={(ctrlEnter) => setMailPrefs({ ctrlEnter })} label="Ctrl+Enter sends" />
          </Row>
        </ul>
        <Accounts accounts={list} />
        <h4 className="set-subhead">Signature</h4>
        <ul className="set-list">
          <Row title="In new messages">
            <Toggle on={prefs.signNew} onChange={(signNew) => setMailPrefs({ signNew })} label="Signature in new messages" />
          </Row>
          <Row title="In replies" hint="Above the quoted message">
            <Toggle on={prefs.signReply} onChange={(signReply) => setMailPrefs({ signReply })} label="Signature in replies" />
          </Row>
          <Row title="In forwards" hint="Above the forwarded message">
            <Toggle on={prefs.signForward} onChange={(signForward) => setMailPrefs({ signForward })} label="Signature in forwards" />
          </Row>
        </ul>
        <Signatures accounts={list} />
      </SetGroup>
      <SetGroup title="Notifications">
        <ul className="set-list">
          <Row title="New mail" hint="Unread mail arriving in an Inbox is switched on or off with the other notifications" stack>
            <button className="btn btn-small" onClick={() => wm.open('settings', { section: 'notifications', t: String(Date.now()) })}>
              Open Notifications
            </button>
          </Row>
        </ul>
      </SetGroup>
      <p className="muted set-help">Saved with your account, so they are the same on every device. The Mail window follows a change here at once.</p>
    </>
  )
}

// --- Allowed senders ---------------------------------------------------------------------------

function AllowedSenders() {
  const { allowed, remote } = useMailPrefs()
  const [q, setQ] = useState('')
  const sorted = useMemo(() => [...allowed].sort((a, b) => b.at - a.at || a.who.localeCompare(b.who)), [allowed])
  const shown = q.trim() ? sorted.filter((a) => a.who.includes(q.trim().toLowerCase())) : sorted
  const add = async () => {
    const who = await askText({
      title: 'Add a sender or domain',
      body: 'An address (news@shop.example) or a whole domain (@shop.example). Their remote content loads without asking.',
      label: 'Sender or domain',
      placeholder: 'news@shop.example or @shop.example',
      confirm: 'Add',
      validate: (v) => {
        const w = parseSender(v.includes('@') || !v.includes('.') ? v : `@${v}`)
        if (!w) return 'That is not an address or a domain. Try news@shop.example or @shop.example.'
        return allowed.some((a) => a.who === w) ? 'That one is on the list already.' : null
      },
    })
    if (who) allowSender(who.includes('@') || !who.includes('.') ? who : `@${who}`)
  }
  const clear = async () => {
    if (await ask({ title: 'Clear the whole list?', body: `Remote content is blocked again, and asked about, for all ${allowed.length} ${allowed.length === 1 ? 'entry' : 'entries'}.`, confirm: 'Clear all', danger: true })) setMailPrefs({ allowed: [] })
  }
  return (
    <SetGroup title="Allowed senders">
      <p className="muted set-help">
        Built from "Always for this sender" in a message's image bar.{' '}
        {remote === 'ask' && 'Not used while remote content is on Ask: choose Allowed senders above to use it.'}
        {remote === 'allowed' && 'Their remote content loads without asking.'}
        {remote === 'always' && 'Not needed while remote content always loads.'}
      </p>
      {allowed.length >= SEARCH_FROM && <input className="mset-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${allowed.length} senders`} aria-label="Search the allowed senders" spellCheck={false} />}
      {allowed.length === 0 ? (
        <p className="muted set-help">Nobody yet.</p>
      ) : (
        <ul className="set-list mset-allowed">
          {shown.map((a) => (
            <li key={a.who} className="set-row">
              <span className="set-row-text">
                <strong>{a.who.startsWith('@') ? `Everyone at ${a.who.slice(1)}` : a.who}</strong>
                <span className="muted">
                  {a.who.startsWith('@') ? `${a.who} · ` : ''}
                  {day(a.at)}
                </span>
              </span>
              <button className="btn btn-small" onClick={() => removeAllowed(a.who)} aria-label={`Remove ${a.who}`}>
                Remove
              </button>
            </li>
          ))}
          {shown.length === 0 && <li className="set-row muted">Nothing matches "{q.trim()}".</li>}
        </ul>
      )}
      <div className="set-actions">
        <button className="btn btn-small" onClick={() => void add()}>
          Add sender or domain…
        </button>
        {allowed.length > 0 && (
          <button className="btn btn-small btn-ghost" onClick={() => void clear()}>
            Clear all
          </button>
        )}
      </div>
    </SetGroup>
  )
}

// --- Accounts, identities, signatures ----------------------------------------------------------

/** Each account's identities (From addresses), asked of the mail server once per account while the pane is open. */
function useIdentities(accounts: MailAccount[]): Record<number, Identity[]> {
  const [found, setFound] = useState<Record<number, Identity[]>>({})
  const key = accounts.map((a) => a.id).join(',')
  useEffect(() => {
    let live = true
    for (const a of accounts)
      bootstrap(a.id)
        .then((b) => live && setFound((f) => ({ ...f, [a.id]: b.identities })))
        .catch(() => {})
    return () => {
      live = false
    }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  return found
}

const identityLabel = (i: Identity) => (i.name ? `${i.name} <${i.email}>` : i.email)

/** The account Mail opens on, and the From a new message starts with, when there is more than one to choose from. */
function Accounts({ accounts }: { accounts: MailAccount[] }) {
  const prefs = useMailPrefs()
  const identities = useIdentities(accounts)
  const several = accounts.filter((a) => (identities[a.id]?.length ?? 0) > 1)
  if (accounts.length < 2 && !several.length) return null
  return (
    <ul className="set-list">
      {accounts.length > 1 && (
        <Row title="Opens on" hint="The account Mail shows first">
          <Select<number> className="set-select" value={accounts.some((a) => a.id === prefs.defaultAccount) ? prefs.defaultAccount : accounts[0].id} onChange={(defaultAccount) => setMailPrefs({ defaultAccount })} aria-label="Default account" options={accounts.map((a) => ({ value: a.id, label: a.label }))} />
        </Row>
      )}
      {several.map((a) => (
        <Row key={a.id} title={accounts.length > 1 ? `New messages from, in ${a.label}` : 'New messages are from'} hint="Replies are from the address they were sent to">
          <Select
            className="set-select"
            value={prefs.defaultIdentity[String(a.id)] ?? identities[a.id][0].id}
            onChange={(id) => setMailPrefs({ defaultIdentity: { ...prefs.defaultIdentity, [String(a.id)]: id } })}
            aria-label={`From address for ${a.label}`}
            options={identities[a.id].map((i) => ({ value: i.id, label: identityLabel(i) }))}
          />
        </Row>
      ))}
    </ul>
  )
}

/** One plain-text signature per identity. Empty: the one the mail server keeps for it, if any. */
function Signatures({ accounts }: { accounts: MailAccount[] }) {
  const prefs = useMailPrefs()
  const identities = useIdentities(accounts)
  const set = (key: string, text: string) => setMailPrefs({ signatures: { ...prefs.signatures, [key]: text } })
  const rows = accounts.flatMap((a) => (identities[a.id] ?? []).map((i) => ({ a, i, key: `${a.id}:${i.id}` })))
  if (!accounts.length) return <p className="muted set-help">Link a mail account to write signatures for its addresses.</p>
  return (
    <div className="mset-sigs">
      {rows.map(({ a, i, key }) => (
        <label key={key} className="mset-sig">
          <span>
            <strong>{identityLabel(i)}</strong>
            {accounts.length > 1 && <span className="muted"> · {a.label}</span>}
          </span>
          <textarea
            value={prefs.signatures[key] ?? ''}
            onChange={(e) => set(key, e.target.value)}
            rows={3}
            maxLength={4000}
            placeholder={i.textSignature?.trim() ? `Empty: the signature kept at ${a.label} is used` : 'Plain text, added under a "-- " line'}
            aria-label={`Signature for ${identityLabel(i)}`}
          />
        </label>
      ))}
      <p className="muted set-help">Added to the message above any quoted text, after the standard "-- " line.</p>
    </div>
  )
}
