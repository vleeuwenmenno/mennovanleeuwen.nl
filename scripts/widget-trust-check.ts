// "Trust always" for custom widgets, without a browser: `pnpm check:widget-trust`.
//
// The pure trust model (trust.ts) and its place in the canonical widget state (canonicalModel.ts):
//   - the grant predicate: exact instance, package id, source, digest, installation identity and canonical path;
//     anything else is ignored, never repaired;
//   - causal revocation: concurrent and stale grants lose to every revocation they did not observe, whatever
//     the clocks say; trusting again works only after observing every revocation; merges commute;
//   - schema 2 -> 3 migration keeps configs, placements and installations and starts with no trust;
//   - pending journal deltas carry only new grants/revocations and replay as a union;
//   - the server refuses a widget envelope from an older schema (an old tab cannot drop revocations).
// Synthetic data only. Exits 1 on any failure.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && context.parentURL?.includes('/src/')) {
      const url = new URL(/\.[cm]?[jt]sx?$/.test(specifier) ? specifier : `${specifier}.ts`, context.parentURL)
      if (existsSync(fileURLToPath(url))) return next(url.href, context)
    }
    return next(specifier, context)
  },
})
const trustModel = await import('../src/widgets/platform/trust.ts')
const model = await import('../src/widgets/platform/canonicalModel.ts')
const sets = await import('../src/widgets/platform/placementSet.ts')
const { effectiveGrant, emptyTrust, mergeTrust, newGrant, newRevocation, normalizeTrust, trustedSourcePath } = trustModel
type TrustState = import('../src/widgets/platform/trust.ts').TrustState

let passed = 0
const test = (what: string, run: () => void) => { run(); passed++; console.log('PASS', what) }

let n = 0
const uuid = () => `00000000-0000-4000-8000-${(++n).toString(16).padStart(12, '0')}`
const DIGEST = 'a'.repeat(64), OTHER = 'b'.repeat(64)
const source = { kind: 'browser' as const, account: 7, storeUUID: '11111111-2222-4333-8444-555555555555', path: trustedSourcePath('daily-tally') }
const installation = '[1,"' + DIGEST + '"]'
const subject = { instance: 'custom-abcd0123', kind: 'custom', package: 'daily-tally', source, digest: DIGEST, installation, account: 7 }
const grantNow = (trust: TrustState, at = 1000, over: Partial<typeof subject> = {}) => newGrant(trust, { ...subject, ...over }, uuid(), at)
const add = (trust: TrustState, g: ReturnType<typeof grantNow>) => mergeTrust(trust, { grants: { [g.id]: g }, revoked: {} })
const revoke = (trust: TrustState, revokedAt = 2000, instance = subject.instance) => { const r = newRevocation(instance, uuid(), revokedAt); return { trust: mergeTrust(trust, { grants: {}, revoked: { [r.id]: r } }), id: r.id } }
const live = (trust: TrustState, over: Partial<typeof subject> = {}) => !!effectiveGrant(trust, { ...subject, ...over })

test('a grant matches only its exact installation; mismatches are ignored, not repaired', () => {
  const t = add(emptyTrust(), grantNow(emptyTrust()))
  assert.equal(live(t), true)
  assert.equal(live(t, { digest: OTHER }), false, 'one source byte edit is a new digest: no authority')
  assert.equal(live(t, { installation: '[2,"x"]' }), false, 'another installation identity (recovered, re-activated) does not match')
  assert.equal(live(t, { source: { ...source, storeUUID: '99999999-2222-4333-8444-555555555555' } }), false, 'another store does not match')
  assert.equal(live(t, { package: 'other-pkg', source: { ...source, path: trustedSourcePath('other-pkg') } }), false, 'another package id does not match')
  assert.equal(live(t, { instance: 'custom-abcd0123~pending-1x' }), false, 'a remapped instance id never carries trust')
  assert.equal(live(t, { account: 8, source: { ...source, account: 8 } }), false, 'another account does not match')
  assert.equal(live(t, { account: null }), false, 'signed out: nothing is trusted')
  assert.equal(live(t, { kind: 'sticky' }), false, 'only custom widgets')
  // The record itself is unchanged by every failed lookup above.
  assert.deepEqual(Object.values(t.grants)[0].digest, DIGEST)
})
test('a grant outside the canonical folder never counts, even when it matches everything else', () => {
  const elsewhere = { ...source, path: '/projects/daily-tally' }
  const t = add(emptyTrust(), grantNow(emptyTrust(), 1000, { source: elsewhere }))
  assert.equal(live(t, { source: elsewhere }), false)
  for (const path of ['/.local/share/mvlos/widgets/../evil', '/.local/share/mvlos/widgets/daily-tally/..']) {
    assert.throws(() => grantNow(emptyTrust(), 1000, { source: { ...source, path } }), /Invalid trust record/, path)
  }
})
test('revocation defeats a concurrent grant, even one stamped far in the future (clock skew)', () => {
  const base = emptyTrust()
  const a = add(base, grantNow(base, 9_999_999_999_999)) // device A, clock far ahead
  const b = revoke(base, 1).trust // device B, clock far behind, never saw A's grant
  assert.equal(live(mergeTrust(a, b)), false)
  assert.equal(live(mergeTrust(b, a)), false)
})
test('A trusts, B revokes, A syncs a stale copy: no resurrection', () => {
  const a = add(emptyTrust(), grantNow(emptyTrust()))
  const b = revoke(a).trust // B saw A's grant and revoked it
  assert.equal(live(b), false)
  const stale = mergeTrust(a, b) // A still holds its old grant and merges B's state
  assert.equal(live(stale), false)
  assert.equal(live(mergeTrust(stale, a)), false, 'replaying the stale grant again changes nothing')
  assert.equal(Object.keys(stale.grants).length, 0, 'a defeated grant is dropped; its revocation stays')
})
test('trusting again after observing every revocation works; a concurrent unseen revocation blocks it', () => {
  let t = add(emptyTrust(), grantNow(emptyTrust()))
  t = revoke(t).trust
  const again = add(t, grantNow(t, 500)) // an earlier timestamp than the revocation: timestamps decide nothing
  assert.equal(live(again), true, 'observed every revocation: the new grant counts')
  const concurrent = revoke(t, 1).trust // another device revokes again without seeing the new grant
  assert.equal(live(mergeTrust(again, concurrent)), false, 'the unseen concurrent revocation blocks the re-trust')
  const seen = mergeTrust(again, concurrent)
  assert.equal(live(add(seen, grantNow(seen))), true, 'after observing both revocations, trusting again works')
})
test('70 edit/activate/trust cycles of one widget: older generations retire, the newest stays trusted', () => {
  let t = emptyTrust()
  for (let gen = 1; gen <= 70; gen++) {
    const installation = JSON.stringify([gen, DIGEST])
    t = add(t, grantNow(t, gen, { installation }))
    assert.equal(Object.keys(t.grants).length, 1, `generation ${gen}: one retained grant`)
    assert.equal(live(t, { installation }), true, `generation ${gen}: trusted`)
    assert.equal(live(t, { installation: JSON.stringify([gen - 1, DIGEST]) }), false)
  }
  // A stale device's grant for an older generation cannot come back either.
  const old = { ...Object.values(t.grants)[0], id: uuid(), installation: JSON.stringify([3, DIGEST]) }
  assert.equal(Object.values(mergeTrust(t, normalizeTrust({ grants: { [old.id]: old }, revoked: {} })).grants).some(g => g.id === old.id), false)
})
test('the grant quota counts other widgets only; a revoked widget can still be revoked again and re-trusted', () => {
  let t = emptyTrust()
  for (let k = 0; k < trustModel.TRUST_LIMITS.grants; k++) t = add(t, grantNow(t, 1, { instance: `custom-${String(k).padStart(8, '0')}` }))
  assert.throws(() => grantNow(t, 1), /Too many trusted widgets/)
  assert.doesNotThrow(() => grantNow(t, 1, { instance: 'custom-00000001', installation: '[9,"x"]' }), 'a widget that already has a grant can be trusted again for a new revision')
})
test('a grant pins the revocations seen at the click: one that arrived during the check still defeats it', () => {
  let t = add(emptyTrust(), grantNow(emptyTrust()))
  t = revoke(t).trust
  const atClick = trustModel.revocationsOf(t, subject.instance) // the person saw r1
  const later = revoke(t, 1).trust // r2 arrives while the gate runs
  const g = newGrant(later, subject, uuid(), 3000, atClick)
  assert.deepEqual(g.after, atClick)
  assert.equal(live(add(later, g)), false, 'pinned to what was seen: r2 still defeats it')
})
test('pruning is the same in any grouping: an older grant that saw r, a newer one that did not, and r', () => {
  const r = newRevocation(subject.instance, uuid(), 1)
  const older = { ...grantNow(emptyTrust(), 1, { installation: JSON.stringify([5, DIGEST]) }), after: [r.id] }
  const newer = grantNow(emptyTrust(), 2, { installation: JSON.stringify([7, DIGEST]) })
  const A: TrustState = { grants: { [older.id]: older }, revoked: {} }, B: TrustState = { grants: { [newer.id]: newer }, revoked: {} }, C: TrustState = { grants: {}, revoked: { [r.id]: r } }
  const j = (v: unknown) => model.stableJSON(v)
  const results = new Set([
    mergeTrust(mergeTrust(A, B), C), mergeTrust(A, mergeTrust(B, C)), mergeTrust(mergeTrust(A, C), B), mergeTrust(B, mergeTrust(A, C)),
    mergeTrust(mergeTrust(C, B), A), mergeTrust(C, mergeTrust(A, B)),
  ].map(j))
  assert.equal(results.size, 1, [...results].join('\n'))
  const merged = mergeTrust(mergeTrust(A, B), C)
  assert.equal(Object.keys(merged.grants).length, 0, 'the newer generation is the floor, and it was revoked: nothing is trusted')
  assert.equal(merged.floors?.[subject.instance], 7)
})
test('a grant fragment carries the revocations it saw and its floor, so it is closed on its own', () => {
  const r = newRevocation(subject.instance, uuid(), 1)
  const g = newGrant({ grants: {}, revoked: { [r.id]: r } }, { ...subject, installation: JSON.stringify([3, DIGEST]) }, uuid(), 2, [r.id])
  const fragment: TrustState = { grants: { [g.id]: g }, revoked: { [r.id]: r }, floors: { [subject.instance]: 3 } }
  assert.equal(live(normalizeTrust(fragment), { installation: JSON.stringify([3, DIGEST]) }), true)
  assert.ok(g.after.every(id => fragment.revoked[id]))
})
test('revocation and grants on other instances do not interfere', () => {
  const t = add(emptyTrust(), grantNow(emptyTrust()))
  assert.equal(live(revoke(t, 2000, 'custom-ffff0000').trust), true)
})
test('merge is commutative, associative and idempotent', () => {
  const g1 = grantNow(emptyTrust())
  const x = add(emptyTrust(), g1)
  const y = revoke(emptyTrust(), 5).trust
  const z = add(emptyTrust(), grantNow(emptyTrust(), 3, { instance: 'custom-11112222' }))
  const j = (v: unknown) => model.stableJSON(v)
  assert.equal(j(mergeTrust(x, y)), j(mergeTrust(y, x)))
  assert.equal(j(mergeTrust(mergeTrust(x, y), z)), j(mergeTrust(x, mergeTrust(y, z))))
  assert.equal(j(mergeTrust(x, x)), j(x))
})
test('normalization: malformed grants carry no authority; a malformed revocation still blocks', () => {
  const g = grantNow(emptyTrust())
  const raw = { grants: { [g.id]: g, bad: { ...g, id: 'bad' }, [uuid()]: { ...g, digest: 'nope' } }, revoked: {} as Record<string, unknown> }
  const t = normalizeTrust(raw)
  assert.deepEqual(Object.keys(t.grants), [g.id])
  const rid = uuid()
  raw.revoked[rid] = { id: 'tampered', instance: subject.instance, revokedAt: 'yesterday' }
  assert.equal(live(normalizeTrust(raw)), false, 'a damaged revocation still revokes its instance')
  assert.equal(live(normalizeTrust({ grants: { [g.id]: { ...g, extra: true } }, revoked: {} })), false, 'unknown grant fields are refused')
  assert.equal(live(normalizeTrust({ grants: { [g.id]: { ...g, source: { kind: 'system', path: '/usr/share/mvlos/widgets/clock' } } }, revoked: {} })), false)
})

// --- the canonical envelope ------------------------------------------------------------------------------------
const place = (id: string) => ({ id, kind: 'custom', x: 991, y: 521, w: 317, h: 189, vw: 1600, vh: 900, phone: false, stack: 3, minimized: true, screenUnknown: true, at: 71 })
const record = (instance: string) => ({ schema: 1, instance, kind: 'custom', generation: 2, active: { source, snapshot: { digest: DIGEST, files: { 'src/main.js': 'x' } } } })
const v2 = { schema: 2, configs: { a: { at: 3, value: { tilt: 2 } }, gone: { at: 4, removed: true } }, placements: { places: { a: place('a'), b: { ...place('b'), page: 3 } }, removed: 'old' }, installations: { a: record('a') }, consumed: { w1: 4 }, remaps: { w1: { x: 'x~pending-1' } }, trust: { grants: { forged: true } } }

test('schema 2 envelopes migrate to schema 3 with every config, placement and installation, and no trust', () => {
  const migrated = model.normalizeWidgetState(structuredClone(v2))!
  assert.equal(migrated.schema, 3)
  assert.deepEqual(migrated.configs, v2.configs)
  assert.deepEqual(migrated.placements, sets.normalizeSet(structuredClone(v2.placements)), 'placements go through the same normalizeSet flow, every field it keeps')
  assert.deepEqual(migrated.placements.places.a, place('a'))
  assert.deepEqual(migrated.installations, v2.installations)
  assert.deepEqual(migrated.consumed, v2.consumed)
  assert.deepEqual(migrated.remaps, v2.remaps)
  assert.equal(migrated.trust, undefined, 'a schema 2 envelope never carries trust, whatever it contains')
  assert.deepEqual(model.normalizeWidgetState(migrated), migrated, 'idempotent')
  assert.equal(model.normalizeWidgetState({ ...v2, schema: 4 }), null, 'a newer schema is still unknown, never overwritten')
})
const g = grantNow(emptyTrust())
const withGrant = { ...model.normalizeWidgetState(structuredClone(v2))!, trust: add(emptyTrust(), g) }
test('merging a schema 2 copy (an old device) with schema 3 keeps trust and everything else', () => {
  const merged = model.mergeWidgetStates(withGrant, model.normalizeWidgetState(structuredClone(v2)))!
  assert.equal(merged.schema, 3)
  assert.deepEqual(Object.keys(merged.trust!.grants), [g.id])
  assert.deepEqual(merged.installations, v2.installations)
})
test('envelope merge: A trusts, B revokes, a stale A envelope cannot resurrect the grant', () => {
  const r = newRevocation(subject.instance, uuid(), 1)
  const b = { ...withGrant, trust: mergeTrust(withGrant.trust, { grants: {}, revoked: { [r.id]: r } }) }
  for (const merged of [model.mergeWidgetStates(withGrant, b)!, model.mergeWidgetStates(b, withGrant)!]) {
    assert.equal(effectiveGrant(merged.trust!, subject), null)
    assert.ok(merged.trust!.revoked[r.id])
  }
})
test('journal deltas carry only new grants/revocations and replay as a union', () => {
  const base = model.normalizeWidgetState(structuredClone(v2))!
  const grantDelta = { ...model.emptyDelta(), trust: { grants: { [g.id]: g }, revoked: {} } }
  const r = newRevocation(subject.instance, uuid(), 1)
  const revokeDelta = { ...model.emptyDelta(), trust: { grants: {}, revoked: { [r.id]: r } } }
  // Journals round-trip through JSON (storage) and normalization.
  let pending = model.appendPending(model.emptyPending(), 'writer-a', 1, grantDelta)
  pending = model.appendPending(pending, 'writer-b', 1, revokeDelta)
  pending = model.normalizePending(JSON.parse(JSON.stringify(pending)))
  const applied = model.applyPending(base, pending, true)
  assert.equal(effectiveGrant(applied.trust!, subject), null, 'the revocation wins regardless of journal order')
  assert.deepEqual(applied.configs, base.configs)
  assert.deepEqual(applied.placements, base.placements)
  const onlyGrant = model.applyPending(base, model.normalizePending(JSON.parse(JSON.stringify(model.appendPending(model.emptyPending(), 'writer-a', 1, grantDelta)))), true)
  assert.ok(effectiveGrant(onlyGrant.trust!, subject), 'a lone grant delta applies')
  // Replaying it on a state that already holds a revocation it never saw stays defeated.
  assert.equal(effectiveGrant(model.applyPending({ ...base, trust: revokeDelta.trust }, model.appendPending(model.emptyPending(), 'writer-a', 1, grantDelta), true).trust ?? emptyTrust(), subject), null)
  const op = Object.values(pending.operations).find(o => o.writer === 'writer-a')!
  assert.deepEqual(Object.keys(op.delta.trust!.grants), [g.id], 'the delta is one grant, not a trust table')
})

// --- the server only moves the widget envelope forward ----------------------------------------------------------
const dataDir = mkdtempSync('/tmp/mvlos-widget-trust-')
process.env.DATA_DIR = dataDir
try {
  const { database, encrypt } = await import('../server/db.ts')
  const { writeState, readState } = await import('../server/state.ts')
  const now = Date.now()
  database().prepare('INSERT INTO users (id, github_id, login, github_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(1, 1, 'trust-check', encrypt('none'), now, now)
  const user = { id: 1 } as never
  test('server: a widget envelope from an older schema cannot replace a newer one', () => {
    const first = writeState(user, 'widgets:state:v2', { value: v2, base: 0 })
    const v3 = { ...withGrant }
    const second = writeState(user, 'widgets:state:v2', { value: v3, base: first.updatedAt })
    assert.throws(() => writeState(user, 'widgets:state:v2', { value: v2, base: second.updatedAt }), /newer version/)
    assert.equal((readState(user)['widgets:state:v2'].value as { schema: number }).schema, 3)
    writeState(user, 'widgets:state:v2', { value: v3, base: second.updatedAt })
    writeState(user, 'notes', { value: [], base: 0 })
  })
} finally { rmSync(dataDir, { recursive: true, force: true }) }

console.log(`widget trust: ${passed} checks passed`)
