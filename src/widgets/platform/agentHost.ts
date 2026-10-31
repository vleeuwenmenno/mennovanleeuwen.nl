import { createElement } from 'react'
import { choose } from '../../os/Dialogs'
import { getAccount } from '../../os/account'
import type { WidgetHost } from '../../terminal/widget'
import { randomTilt, setWidgetConfig } from '../config'
import { activate, allowRevision, installation, installationVersion, installations } from './installations'
import { execute } from './runtime'
import { readSource, sourceIdentity } from './sources'

// The browser's side of the agents' `widget` command (src/terminal/widget.ts): the bounded VM, the
// installation records, and the two things only the desktop can do, ask the user and show a preview.
// Nothing here is reachable except through that command, and activation always goes through the dialog.

const open = (name: string, detail: unknown) => typeof window !== 'undefined' && window.dispatchEvent(new CustomEvent(name, { detail }))

export const browserHost: WidgetHost = {
  // Agents run while the tab may be in the background: they still get to test (the cancel/limit rules stay the same).
  run: (snapshot, input, event, signal) => execute(snapshot, input, event, signal, { owner: 'agent', eligible: () => true }),
  installed: () => Object.values(installations.get()).map((i) => ({ instance: i.instance, kind: i.kind, name: i.active.snapshot.manifest.name, digest: i.active.snapshot.digest, generation: i.generation })),
  current: (instance) => {
    const found = installation(instance)
    const version = installationVersion(instance)
    return { exists: !!found, kind: found?.kind, generation: version.generation, identity: version.identity, digest: found?.active.snapshot.digest, source: found?.active.source }
  },
  identity: sourceIdentity,
  readSource,
  signedIn: () => getAccount().status === 'user',
  activate,
  allow: allowRevision,
  approve: (request, signal) => {
    const row = (label: string, value: string, code = false) => createElement('li', { key: label }, `${label}: `, code ? createElement('code', null, value) : value)
    const list = request.capabilities.length ? request.capabilities.map((c) => c.text).join('; ') : 'nothing beyond drawing itself (no saved state, no data)'
    return choose(
      {
        title: `Let an agent ${request.isNew ? 'add' : 'update'} the widget "${request.name}"?`,
        body: createElement(
          'div',
          null,
          createElement('p', null, request.isNew ? 'An agent wants to install this widget and put it on your desktop. Its code runs in a bounded sandbox.' : `An agent wants to replace the code of the widget ${request.instance}. The current revision is kept to recover.`),
          createElement(
            'ul',
            null,
            row('Package', `${request.name} (${request.id})`),
            row('Digest', request.digest, true),
            row('Widget', request.isNew ? `new ${request.kind} widget ${request.instance}` : `${request.kind} widget ${request.instance}, generation ${request.generation}`),
            row('Source folder', request.dir),
            row('Access granted', list),
          ),
        ),
        buttons: [
          { id: 'cancel', label: 'Deny' },
          { id: 'ok', label: 'Allow', primary: true },
        ],
      },
      signal,
    ).then((id) => id === 'ok')
  },
  preview: (path) => open('mvlos:open', { app: 'widgetworkshop', props: { kind: 'custom', path, preview: '1', t: String(Date.now()) } }),
  placed: (kind, instance, fresh) => {
    if (!fresh) return
    setWidgetConfig(instance, { tilt: randomTilt() })
    open('mvlos:open-widget', { kind, id: instance })
  },
}
