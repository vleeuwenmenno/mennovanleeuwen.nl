import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Listen on all interfaces so the dev site can be opened from a phone over Tailscale or LAN.
  server: { host: '0.0.0.0', allowedHosts: ['.ts.net'] },
  preview: { host: '0.0.0.0', allowedHosts: ['.ts.net'] },
})
