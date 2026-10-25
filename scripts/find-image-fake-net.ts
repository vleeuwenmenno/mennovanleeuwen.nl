// A stand-in web for find_image (server/findImage.ts), for checks and local browser tests only:
// preload it (NODE_OPTIONS="--import ./scripts/find-image-fake-net.ts") with
//
//   FIND_IMAGE_FAKE_WEB=http://127.0.0.1:<port>   a server that answers /<host>/<path> for every host
//   FIND_IMAGE_FAKE_DNS={"evil.test":"10.0.0.5"}  what names resolve to (others: a public address)
//
// Only the last step changes: names still go through find_image's address checks with these
// answers (a private one is refused before anything is sent), and only allowed requests reach
// the stand-in, as plain HTTP to 127.0.0.1. Nothing in the server loads this file by itself.

import type { LookupAddress } from 'node:dns'

const web = process.env.FIND_IMAGE_FAKE_WEB
if (web) {
  const dns = JSON.parse(process.env.FIND_IMAGE_FAKE_DNS || '{}') as Record<string, string>
  ;(globalThis as Record<string, unknown>).__mvlFindImageNet = {
    resolve: async (host: string): Promise<LookupAddress[]> => {
      const ip = dns[host.toLowerCase()] ?? '93.184.215.14'
      return [{ address: ip, family: ip.includes(':') ? 6 : 4 }]
    },
    request: (url: URL, init: RequestInit) => fetch(`${web}/${url.host}${url.pathname}${url.search}`, { ...init, redirect: 'manual' }),
  }
}
