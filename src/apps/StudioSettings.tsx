import { useEffect, useState } from 'react'
import { getImageSettings, IMAGE_SETTINGS_EVENT } from '../data/agentImages'
import { AgentsImageSettings } from './AgentsImageSettings'
import { VideoSettings } from './video/VideoSettings'

// Settings → Apps → Image & Video Studio: the account's ComfyUI connection and the models the
// Image Studio, the Video Studio and Agents use. Agents → Images shows the connection too.

export function StudioSettings() {
  const [connected, setConnected] = useState(false)
  useEffect(() => {
    const read = () => void getImageSettings().then((s) => setConnected(!!s.url), () => {})
    read()
    window.addEventListener(IMAGE_SETTINGS_EVENT, read)
    return () => window.removeEventListener(IMAGE_SETTINGS_EVENT, read)
  }, [])
  return (
    <>
      <p className="muted set-help">The Image Studio and the Video Studio run on your own ComfyUI server. Its address and token are stored encrypted with your account and used only by this site's server; your browser never talks to ComfyUI directly. Agents generates pictures with the same connection.</p>
      <AgentsImageSettings />
      <VideoSettings connected={connected} />
    </>
  )
}
