// Image observations as fields: the stored text and JSON parse, odd rows fall back to their raw
// text, filters count right, and the read-only route stays owner-scoped. Scratch DATA_DIR, no server.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { freeName, imageFileName } from '../src/data/agentImageFiles.ts'
import { matchesObservation, modelKey, NO_FILTER, observationFromText, readObservation, settingsLine } from '../src/data/imageObservations.ts'

const data = mkdtempSync(join(tmpdir(), 'mvlos-observations-'))
process.env.DATA_DIR = data
try {
  const image = '0a1b2c3d-1111-4222-8333-444455556666'
  const settings = { preset: 'krea2_turbo', model: 'Krea2/Turbo/custom.safetensors', clip: 'qwen.safetensors', vae: 'vae.safetensors', steps: 8, cfg: 1, sampler: 'euler_ancestral', scheduler: 'beta', loras: [{ name: 'styles/ink-wash.safetensors', weight: 0.8 }], width: 1024, height: 768, seed: 42, prompt: 'A lighthouse at dusk,\nink wash', negative_prompt: '', denoise: 1 }
  // Exactly what server/agentImageLearning.ts writes as the memory text.
  const text = (profile: number | 'none', kind: string, task: string, note: string, message: number | 'none', quote: string) =>
    `Image learning · profile ${profile} · ${kind} · ${task}\nInterpretation (not verified): ${note}\nEvidence #${message}: ${quote}\nImage: ${image}\nRecorded settings: ${JSON.stringify(settings)}`
  const row = { id: 7, threadId: 't', createdAt: 1000, updatedAt: null }

  const feedback = observationFromText(row, text(3, 'user_feedback', 'Lighthouse · ink', 'Softer contrast\nworked better.', 331, 'I like this one more'))!
  assert.equal(feedback.profileId, 3)
  assert.equal(feedback.source, 'user_feedback')
  assert.equal(feedback.task, 'Lighthouse · ink', 'a task with the separator in it stays whole')
  assert.equal(feedback.note, 'Softer contrast\nworked better.', 'a note may span lines')
  assert.equal(feedback.quote, 'I like this one more')
  assert.equal(feedback.messageId, 331)
  assert.equal(feedback.imageId, image)
  assert.equal(feedback.prompt, settings.prompt)
  assert.equal(feedback.updatedAt, 1000)
  assert.equal(feedback.raw, undefined)
  assert.equal(settingsLine(feedback.settings), 'Krea2 Turbo · 8 steps · CFG 1 · euler_ancestral/beta · custom · ink-wash 0.8')

  const guess = observationFromText(row, text('none', 'suggestion', 'Poster', 'Try fewer steps.', 'none', 'Unverified suggestion'))!
  assert.equal(guess.profileId, null)
  assert.equal(guess.quote, '', 'a guess has no evidence quote')
  assert.equal(guess.messageId, null)

  // Settings edited into nonsense: the rest still reads. A row of another shape: raw text, only it.
  const broken = observationFromText(row, text(3, 'vision', 'Portrait', 'Hands off.', 9, 'two hands').replace(/Recorded settings: .*/, 'Recorded settings: {oops'))!
  assert.equal(broken.settings, null)
  assert.equal(broken.task, 'Portrait')
  const odd = readObservation(row, 'Image learning: remember softer light')
  assert.equal(odd.raw, 'Image learning: remember softer light')
  assert.equal(odd.source, null)

  // The structured JSON wins over the text; bad JSON falls back to the text.
  const learning = { version: 1, profileId: 5, scope: 'abc', artifactId: image, settings, task: 'From JSON', note: 'n', source: { kind: 'vision', messageId: 12, quote: 'q' } }
  assert.equal(readObservation(row, text(3, 'vision', 'From text', 'n', 12, 'q'), JSON.stringify(learning)).task, 'From JSON')
  assert.equal(readObservation(row, text(3, 'vision', 'From text', 'n', 12, 'q'), '{nope').task, 'From text')

  // Filters: profile (and "no profile"), source, model, and text over task and note only.
  assert.ok(matchesObservation(feedback, { ...NO_FILTER, profile: 3, source: 'user_feedback', model: 'krea2_turbo|Krea2/Turbo/custom.safetensors', query: 'SOFTER' }))
  assert.ok(!matchesObservation(feedback, { ...NO_FILTER, profile: 'none' }))
  assert.ok(matchesObservation(guess, { ...NO_FILTER, profile: 'none' }))
  assert.ok(!matchesObservation(feedback, { ...NO_FILTER, source: 'vision' }))
  assert.ok(!matchesObservation(feedback, { ...NO_FILTER, query: 'lighthouse at dusk' }), 'the prompt is not searched')
  console.log('PASS observation text and JSON parse, raw fallback, settings line, filters')

  // Upscalers retain their identity in structured and legacy text records, without diffusion facts.
  const upscaleSettings = { operation: 'upscale', upscale_model: 'detail/4x-detail.pth', width: 2048, height: 1536 }
  const upscale = readObservation(row, '', JSON.stringify({ ...learning, settings: upscaleSettings }))
  const upscaleText = observationFromText(row, text(3, 'vision', 'Upscale', 'Sharper', 9, 'edges').replace(/Recorded settings: .*/, `Recorded settings: ${JSON.stringify(upscaleSettings)}`))!
  assert.equal(upscale.settings?.operation, 'upscale')
  assert.equal(upscale.settings?.upscale_model, upscaleSettings.upscale_model)
  assert.deepEqual(upscaleText.settings, upscale.settings)
  assert.equal(settingsLine(upscale.settings), 'Upscale · 4x-detail · 2048 × 1536')
  assert.equal(upscale.settings?.seed, null)
  assert.equal(modelKey(upscale), 'upscale|detail/4x-detail.pth')
  const otherUpscale = readObservation(row, '', JSON.stringify({ ...learning, settings: { ...upscaleSettings, upscale_model: 'photos/2x-photo.pth' } }))
  assert.notEqual(modelKey(upscale), modelKey(otherUpscale))
  assert.ok(matchesObservation(upscale, { ...NO_FILTER, model: modelKey(upscale) }))
  assert.ok(!matchesObservation(otherUpscale, { ...NO_FILTER, model: modelKey(upscale) }))
  assert.ok(!matchesObservation(feedback, { ...NO_FILTER, model: modelKey(upscale) }))
  // A LaMa removal has no model or sampler: it reads as remove, with its own summary and filter key.
  const removalSettings = { operation: 'remove', width: 1152, height: 768, mask: { id: '00000000-0000-4000-8000-000000000001', url: '/api/agents/image-masks/00000000-0000-4000-8000-000000000001', width: 1152, height: 768, semantics: 'white-edits-black-preserves' }, source: { id: 'attachment:1:0', name: 'street.png', url: '/x', width: 1152, height: 768, resize: 'none' } }
  const removal = readObservation(row, '', JSON.stringify({ ...learning, settings: removalSettings }))
  const removalText = observationFromText(row, text(3, 'vision', 'Remove', 'Clean fill', 9, 'edges').replace(/Recorded settings: .*/, `Recorded settings: ${JSON.stringify(removalSettings)}`))!
  assert.equal(removal.settings?.operation, 'remove'); assert.equal(removalText.settings?.operation, 'remove')
  assert.equal(settingsLine(removal.settings), 'Remove (LaMa) · 1152 × 768')
  assert.equal(modelKey(removal), 'remove|lama')
  assert.ok(matchesObservation(removal, { ...NO_FILTER, model: 'remove|lama' }))
  assert.ok(!matchesObservation(upscale, { ...NO_FILTER, model: 'remove|lama' }))
  const refined = readObservation(row, '', JSON.stringify({ ...learning, settings: { ...settings, operation: 'refine', denoise: 0.2 } }))
  assert.equal(refined.settings?.operation, 'refine')
  assert.ok(settingsLine(refined.settings).startsWith('Refine · strength 0.2 · Krea2 Turbo'))
  assert.notEqual(modelKey(refined), modelKey(feedback))
  const hires = { base_width: 1024, base_height: 768, width: 1536, height: 1152, denoise: 0.25, seed: 43, steps: 12, cfg: 5, sampler: 'euler', scheduler: 'simple', upscale_model: 'detail/4x-detail.pth' }
  const hiresSettings = { ...settings, operation: 'generate', width: 1536, height: 1152, hires }
  const hiresObservation = readObservation(row, '', JSON.stringify({ ...learning, settings: hiresSettings }))
  assert.equal(hiresObservation.settings?.operation, 'generate', 'hires preserves its recorded operation')
  assert.deepEqual(hiresObservation.settings?.hires, hires, 'all stage settings survive')
  assert.equal(refined.settings?.denoise, 0.2)
  assert.ok(settingsLine(hiresObservation.settings).includes('Hires · 1024 × 768 · to 1536 × 1152 · strength 0.25 · 12 steps · CFG 5 · euler/simple · 4x-detail'))
  assert.notEqual(modelKey(hiresObservation), modelKey(feedback))
  assert.notEqual(modelKey(hiresObservation), modelKey(refined))
  const hiresText = observationFromText(row, text(3, 'vision', 'Hires', 'Sharper', 9, 'edges').replace(/Recorded settings: .*/, `Recorded settings: ${JSON.stringify(hiresSettings)}`))!
  assert.deepEqual(hiresText.settings, hiresObservation.settings)
  const inpaintSettings = { ...settings, operation: 'inpaint', denoise: 0.65, mask: { id: image, width: 1024, height: 1024 } }
  const inpaintObservation = observationFromText(row, text(3, 'vision', 'Masked edit', 'Matches', 9, 'edges').replace(/Recorded settings: .*/, `Recorded settings: ${JSON.stringify(inpaintSettings)}`))!
  assert.equal(inpaintObservation.settings?.operation, 'inpaint')
  assert.deepEqual(inpaintObservation.settings?.mask, inpaintSettings.mask)
  assert.match(settingsLine(inpaintObservation.settings), /Inpaint · strength 0.65/)
  assert.notEqual(modelKey(inpaintObservation), modelKey(refined))
  console.log('PASS upscale/refine observation identity, text/JSON parity, summary and model filters')

  // Save to Files names: a prompt slug and the short id, stable, never a bare id, never a taken name.
  assert.equal(imageFileName({ id: image, settings }), 'a-lighthouse-at-dusk-ink-wash-0a1b2c3d.png')
  assert.equal(imageFileName({ id: image, settings }), imageFileName({ id: image, settings }), 'the same picture, the same name')
  assert.equal(imageFileName({ id: image }), 'image-0a1b2c3d.png')
  assert.equal(imageFileName({ id: image, settings: { prompt: '!!! ??? 漢字' } }), 'image-0a1b2c3d.png')
  assert.equal(imageFileName({ id: image, settings: { prompt: 'Café crème brûlée' } }), 'cafe-creme-brulee-0a1b2c3d.png')
  assert.ok(imageFileName({ id: image, settings: { prompt: 'word '.repeat(40) } }).length <= 48 + 13)
  const taken = new Set(['x.png', 'x 2.png'])
  assert.equal(freeName('y.png', (n) => taken.has(n)), 'y.png')
  assert.equal(freeName('x.png', (n) => taken.has(n)), 'x 3.png')
  console.log('PASS Save to Files names: readable, stable, numbered instead of replacing')

  // The route: owner-scoped, newest first, profile counts and pins, missing pictures flagged.
  const { database } = await import('../server/db.ts')
  const { imageObservations, OBSERVATIONS_LIMIT } = await import('../server/agentImageObservations.ts')
  const db = database()
  for (const id of [1, 2]) db.prepare('INSERT INTO users (id, github_id, login, github_token, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0)').run(id, id, `u${id}`, '')
  db.prepare("INSERT INTO agent_threads (id, user_id, title, mode, model, created_at, updated_at) VALUES ('t1', 1, 'Lighthouse', 'quick', 'm', 0, 0)").run()
  db.prepare('INSERT INTO agent_images (id, thread_id, name, body, created_at) VALUES (?, ?, ?, ?, 0)').run(image, 't1', 'a.png', new Uint8Array([1]))
  const profileId = Number(db.prepare("INSERT INTO agent_memories (user_id, text, category, created_at, image_profile) VALUES (1, 'Image profile · Ink · user\nSoft ink.', 'Images/Profiles', 5, ?)").run(JSON.stringify({ name: 'Ink', description: 'Soft ink.', origin: 'user' })).lastInsertRowid)
  db.prepare('UPDATE agent_threads SET image_profile_id = ? WHERE id = ?').run(profileId, 't1')
  const insert = (user: number, at: number, l: object | null, t: string) => db.prepare("INSERT INTO agent_memories (user_id, text, category, thread_id, created_at, image_learning) VALUES (?, ?, 'Images/Learnings', 't1', ?, ?)").run(user, t, at, l ? JSON.stringify(l) : '{}')
  insert(1, 10, { ...learning, profileId }, text(profileId, 'vision', 'From JSON', 'n', 12, 'q'))
  insert(1, 20, { ...learning, profileId: null, artifactId: '99999999-1111-4222-8333-444455556666' }, 'x')
  insert(1, 30, null, 'Hand-edited note')
  insert(2, 40, learning, 'Someone else')
  const view = imageObservations({ id: 1 } as never)
  assert.equal(view.total, 3)
  assert.equal(view.limit, OBSERVATIONS_LIMIT)
  assert.deepEqual(view.observations.map((o) => o.updatedAt), [30, 20, 10], 'newest first, own rows only')
  assert.equal(view.observations[0].raw, 'Hand-edited note')
  assert.equal(view.observations[1].imageAvailable, false, 'a picture deleted with its thread')
  assert.equal(view.observations[2].imageAvailable, true)
  assert.equal(view.observations[2].currentBackend, false, 'saved against another ComfyUI')
  assert.equal(view.unfiled, 2)
  assert.deepEqual(view.profiles.map((p) => [p.name, p.observations, p.lastTouched, p.threads.map((t) => t.title), p.threadCount]), [['Ink', 1, 10, ['Lighthouse'], 1]])
  assert.equal(imageObservations({ id: 2 } as never).observations.length, 1)
  console.log('PASS observations route: owner-scoped, newest first, counts, pins and missing pictures')
} finally {
  rmSync(data, { recursive: true, force: true })
}
