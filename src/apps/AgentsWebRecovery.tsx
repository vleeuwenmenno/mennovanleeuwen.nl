import { choose } from '../os/Dialogs'
import { failedWebRead, openableUrl } from '../data/agentWebRecovery'
import type { ToolCall } from '../data/agents'

/** Handed down from the open conversation: where the pasted page text goes. `blocked`: why not right now. */
export type PastePage = { run: (url: string) => void; blocked?: string }

/** The one-line reason shown on a failed web read's card (the server's own words are under it). */
export const READ_FAILED = 'Reader couldn’t retrieve this page'

/** Asks for the page's text in the OS's own dialog; the text typed or pasted, or null for Cancel. `problem`: why the last text could not be added (it stays in the box). */
export async function askPageText(url: string, value = '', problem: string | null = null): Promise<string | null> {
  let text = value
  for (;;) {
    const id = await choose({
      title: 'Paste page text',
      body: (
        <>
          <p className="muted agt-paste-url copyable">{url}</p>
          <p>Open the page in your browser, copy its text, and paste it here. It goes into your message box for you to read and send; nothing is sent from here.</p>
          <textarea
            className="dlg-input agt-paste-box"
            data-autofocus=""
            rows={8}
            placeholder="Paste the page text"
            aria-label="Page text"
            spellCheck={false}
            defaultValue={text}
            aria-invalid={!!problem}
            onChange={(e) => (text = e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) e.currentTarget.closest('.dlg')?.querySelector<HTMLButtonElement>('.btn-primary')?.click()
            }}
          />
          {problem && <p className="t-red dlg-problem copyable">{problem}</p>}
        </>
      ),
      buttons: [
        { id: 'cancel', label: 'Cancel' },
        { id: 'ok', label: 'Add to message', primary: true },
      ],
    })
    if (id !== 'ok') return null
    if (text.trim()) return text
  }
}

/** What opens under a web_fetch card that failed: the whole address, what is and is not known, the raw error, and the two ways on. */
export function WebFetchRecovery({ call, result, paste }: { call: ToolCall; result: string | undefined; paste?: PastePage }) {
  const failed = failedWebRead(call, result)
  if (!failed) return null
  const href = openableUrl(failed.url)
  return (
    <div className="agt-recover">
      <p className="agt-recover-title">{READ_FAILED}</p>
      <p className="muted agt-recover-why">The reader may be blocked from this site, or the page may not exist: the error below does not say which. The agent saw only that error, not the page.</p>
      <p className="agt-recover-url copyable" data-testid="recover-url">
        {href ? (
          <a href={href} target="_blank" rel="noopener noreferrer">
            {failed.url}
          </a>
        ) : (
          failed.url
        )}
      </p>
      <div className="agt-ask-actions agt-recover-actions">
        {href ? (
          <a className="btn btn-small" href={href} target="_blank" rel="noopener noreferrer">
            Open page
          </a>
        ) : (
          <button type="button" className="btn btn-small" disabled title="Only web addresses (http or https) open">
            Open page
          </button>
        )}
        {paste && (
          <button type="button" className="btn btn-small" disabled={!!paste.blocked} title={paste.blocked ?? 'Paste the page text from your browser into your next message'} onClick={() => paste.run(failed.url)}>
            Paste page text…
          </button>
        )}
      </div>
      <details className="agt-recover-raw">
        <summary className="muted">Error from the reader</summary>
        <pre className="agt-tool-body copyable">{failed.error}</pre>
      </details>
    </div>
  )
}
