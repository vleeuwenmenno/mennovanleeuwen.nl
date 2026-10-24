import { createRoot } from 'react-dom/client'
import { AgentsMaskEditor, type AgentsMaskEditorProps } from '../../src/apps/AgentsMaskEditor'
import '../../src/styles.css'
import '../../src/home.css'

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

// Isolated integration fixture: only mask/catalog requests are intercepted; no real account data.
const scenario = window as unknown as {
  mountInpaint: (attachment?: boolean) => Promise<void>; inpaintResult?: unknown; maskUploads: number; maskDiscards: number;
  holdMaskUpload: boolean; finishMaskUpload?: () => void
}
const originalFetch = window.fetch.bind(window)
scenario.mountInpaint = async (attachment = false) => {
  const { InpaintDialog } = await import('../../src/apps/AgentsInpaint')
  scenario.inpaintResult = undefined; scenario.maskUploads = 0; scenario.maskDiscards = 0; scenario.holdMaskUpload = false
  window.fetch = async (input, init) => {
    const path = typeof input === 'string' ? input : input instanceof Request ? input.url : input.href
    if (path === '/api/agents/images/catalog') return Response.json({ inpaint: true })
    if (path === '/api/agents/threads/fixture/image-masks') {
      if (attachment && JSON.parse(String(init?.body)).source_image_id !== 'attachment:42:0') throw new Error('Wrong attachment source binding')
      scenario.maskUploads++
      const result = () => Response.json({ id: '00000000-0000-4000-8000-000000000001', width: 640, height: 400 })
      return scenario.holdMaskUpload ? new Promise<Response>(resolve => { scenario.finishMaskUpload = () => resolve(result()) }) : result()
    }
    if (path === '/api/agents/image-masks/00000000-0000-4000-8000-000000000001' && init?.method === 'DELETE') { scenario.maskDiscards++; return Response.json({ deleted: true }) }
    return originalFetch(input, init)
  }
  root.render(<InpaintDialog key={++serial} threadId="fixture" disabled={false} image={{ id: attachment ? 'attachment:42:0' : '00000000-0000-4000-8000-000000000002', name: 'Synthetic checker', url: '/scripts/fixtures/agents-mask.svg', ...(attachment ? {} : { width: 640, height: 400 }) }} onClose={() => root.render(<button>Editor closed</button>)} onInpaint={input => { scenario.inpaintResult = input; root.render(<button>Submitted</button>) }} />)
}
