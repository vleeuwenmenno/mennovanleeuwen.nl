import { AgentsImageSettings } from './AgentsImageSettings'

// Settings → Apps → Image & Video Studio: the account's ComfyUI connection and the models it uses.
// Agents uses the same connection for generate_image (its Images settings show this too).

export function StudioSettings() {
  return (
    <>
      <p className="muted set-help">The Image Studio runs on your own ComfyUI server. Its address and token are stored encrypted with your account and used only by this site's server; your browser never talks to ComfyUI directly. Agents generates pictures with the same connection.</p>
      <AgentsImageSettings />
    </>
  )
}
