// Checks server/egress.ts's address rules: which IPv4 and IPv6 addresses count as private, IPv6
// forms that carry an IPv4 address inside (mapped, compatible, SIIT, NAT64, 6to4) judged by that
// address, and that URLs written with them are refused before anything is fetched.
//
//   node scripts/egress-check.ts
//
// No network: only literal addresses. Exits 1 on any failure.

import { isPrivate, publicAddresses, resolveHost, v6Groups } from '../server/egress.ts'

let failed = false
const check = (what: string, test: boolean, detail?: unknown) => {
  if (test) console.log('PASS', what)
  else {
    failed = true
    console.log('FAIL', what, detail ?? '')
  }
}

const privateOnes = [
  // IPv4
  '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1', '192.0.2.1',
  // IPv6 itself
  '::', '::1', 'fe80::1', 'fe80::1%eth0', 'fd00::1', 'fc00::1', 'ff02::1', 'fec0::1', '2001:db8::1', '2001:0:4136:e378::1', '100::1',
  // IPv4-mapped, both ways of writing them (Node's URL parser writes the hex one)
  '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '::ffff:c0a8:101', '::ffff:10.0.0.1', '::ffff:a00:1', '0:0:0:0:0:ffff:7f00:1', '::FFFF:7F00:1',
  // IPv4-compatible and SIIT
  '::127.0.0.1', '::7f00:1', '::ffff:0:7f00:1', '::ffff:0:192.168.0.1',
  // NAT64 and 6to4 around a private address, and NAT64's local-use prefix
  '64:ff9b::7f00:1', '64:ff9b::10.0.0.1', '64:ff9b::a9fe:a9fe', '64:ff9b:1::8.8.8.8', '2002:7f00:1::1', '2002:c0a8:101::1', '2002:a9fe:a9fe::',
  // Not an address at all: refused
  'nonsense', '1.2.3', '::ffff:999.1.1.1', '1:2:3:4:5:6:7:8:9', '1::2::3',
]
const publicOnes = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', '2a00:1450:4001:82a::200e', '::ffff:8.8.8.8', '::ffff:808:808', '64:ff9b::8.8.8.8', '2002:808:808::1']

for (const ip of privateOnes) check(`private: ${ip}`, isPrivate(ip) === true)
for (const ip of publicOnes) check(`public: ${ip}`, isPrivate(ip) === false)

check('v6Groups expands ::', JSON.stringify(v6Groups('::ffff:127.0.0.1')) === JSON.stringify([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]))
check('v6Groups reads hex and dotted alike', JSON.stringify(v6Groups('::ffff:7f00:1')) === JSON.stringify(v6Groups('::ffff:127.0.0.1')))

// Through the URL parser, as the server sees an address someone typed.
for (const raw of ['http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://[::ffff:169.254.169.254]/latest/meta-data/', 'http://[64:ff9b::a9fe:a9fe]/', 'http://[2002:7f00:1::1]/', 'http://[::1]/', 'http://127.0.0.1/', 'http://2130706433/', 'http://0x7f.1/', 'http://localhost/', 'http://app.localhost/']) {
  const url = new URL(raw)
  const refused = await publicAddresses(url).then(
    () => false,
    () => true,
  )
  check(`refused before fetching: ${raw} (${url.hostname})`, refused)
}

const local = await resolveHost('localhost')
check('localhost resolves to 127.0.0.1 without DNS', local.length === 1 && local[0].address === '127.0.0.1')
const aborted = await resolveHost('example.com', AbortSignal.abort())
check('an aborted lookup answers nothing', aborted.length === 0)

console.log(failed ? 'some checks failed' : 'all passed')
process.exit(failed ? 1 : 0)
