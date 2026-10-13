import { useWM } from './wm'

// The line at the top of an app's own settings (Settings → Apps → Calendar and Contacts, and
// Photos' own ⚙ view) that points at where its accounts live. Accounts are linked in Settings →
// Integrations, so an app's pane keeps only what is about the app; this says so, with a button
// that opens that integration's pane. Without an account it is an invitation instead.

export type IntegrationSub = 'calendars' | 'contacts' | 'mail' | 'immich' | 'seafile' | 'ollama' | 'onlyoffice' | 'updown'

type Props = {
  /** The integration's pane in Settings → Integrations */
  sub: IntegrationSub
  /** Whether an account is linked already */
  linked: boolean
  /** What the app is called in "Accounts for … are linked in Integrations" */
  app: string
  /** The invitation when nothing is linked: "Link a calendar account to get started" */
  invite: string
}

export function IntegrationNotice({ sub, linked, app, invite }: Props) {
  const wm = useWM()
  return (
    <div className={`set-notice ${linked ? '' : 'is-invite'}`}>
      <span>{linked ? `Accounts for ${app} are linked in Integrations.` : invite}</span>
      <button className={`btn btn-small ${linked ? '' : 'btn-primary'}`} onClick={() => wm.open('settings', { section: 'integrations', sub, t: String(Date.now()) })}>
        {linked ? 'Open Integrations' : 'Go to Integrations'}
      </button>
    </div>
  )
}
