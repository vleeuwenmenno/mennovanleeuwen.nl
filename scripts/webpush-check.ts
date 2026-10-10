// Checks server/webpush.ts against RFC 8291's worked example (section 5 and appendix A) and that
// its VAPID header verifies with its own public key: `node scripts/webpush-check.ts`.
import { createPublicKey, verify } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DATA_DIR ??= mkdtempSync(join(tmpdir(), 'webpush-check-'))
const { encryptPayload, vapidHeader, pushPublicKey } = await import('../server/webpush.ts')

const b = (s: string) => Buffer.from(s.replace(/\s+/g, ''), 'base64url')
const expected = b(`DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml
  mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT
  pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN`)
const body = encryptPayload(Buffer.from('When I grow up, I want to be a watermelon'), b('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'), b('BTBZMqHH6r4Tts7J_aSIgg'), {
  salt: b('DGv6ra1nlYgDCS1FRnbzlw'),
  senderPrivate: b('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'),
})
const encryptionOk = body.equals(expected)
console.log(`RFC 8291 example: ${encryptionOk ? 'matches' : 'DIFFERS'} (${body.length} of ${expected.length} bytes)`)

const header = vapidHeader('https://fcm.googleapis.com/fcm/send/abc')
const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(header) ?? []
const [h, p, s] = jwt.split('.')
const pub = Buffer.from(k, 'base64url')
const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' })
const signatureOk = verify('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'))
const claims = JSON.parse(Buffer.from(p, 'base64url').toString())
console.log(`VAPID JWT: signature ${signatureOk ? 'verifies' : 'DOES NOT VERIFY'}, aud ${claims.aud}, sub ${claims.sub}, key matches ${k === pushPublicKey().publicKey}`)
process.exit(encryptionOk && signatureOk ? 0 : 1)
