import { createRoot } from 'react-dom/client'
import { AgentsMaskEditor, type AgentsMaskEditorProps } from '../../src/apps/AgentsMaskEditor'
import '../../src/styles.css'

// Synthetic fixture only; never imported by the production entry point.
const host = window as typeof window & { maskResult?: { bytes: number[]; width: number; height: number }; maskCanceled?: boolean; mountMask?: (overrides?: Partial<AgentsMaskEditorProps>) => void }
const root = createRoot(document.getElementById('root')!)
let serial = 0
host.mountMask = (overrides = {}) => {
  host.maskResult = undefined
  host.maskCanceled = false
  root.render(<AgentsMaskEditor key={++serial} sourceUrl="/scripts/fixtures/agents-mask.svg" sourceName="Synthetic checker" width={640} height={400}
    onApply={async ({ mask, width, height }) => { host.maskResult = { bytes: [...new Uint8Array(await mask.arrayBuffer())], width, height } }}
    onCancel={() => { host.maskCanceled = true; root.render(<button>Editor closed</button>) }} {...overrides} />)
}
host.mountMask()
