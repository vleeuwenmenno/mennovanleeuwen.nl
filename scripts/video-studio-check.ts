// The Video Studio (src/data/videoModels.ts, src/data/videoPlan.ts, server/agentVideoGraphs.ts,
// server/agentVideo.ts): the frame and size rules of MiniMax H3 and LTX 2.5, the lanes → plan →
// prompt compiler with its badges, the two graphs, and the server against a stand-in ComfyUI that
// records each graph: render jobs that outlive the request (done, cancelled, interrupted by a
// restart), the one-job slot shared with the Image Studio, quota refusals before queueing and at
// save time, byte ranges, per-account isolation, and the agent tools' permissions (render always
// asks, Plan refuses it, task runs never get it). No GPU, no real data.
// pnpm check:video-studio
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Server } from './empires-harness.ts'
import { asPage } from './as-page.ts'
import { effectiveSeconds, h3FrameCount, ltxFrameCount, resolveVideoModels, snapDuration, snapVideoSize, videoParameterProblem, videoSizeFor, emptyVideoModels } from '../src/data/videoModels.ts'
import { compileProject, defaultProject, laneBadge, lanesFromPlan, normalizeProject, validateVideoPromptPlan, videoPromptFromPlan, FIRST_FRAME_TOKEN, type VideoProject } from '../src/data/videoPlan.ts'
import { buildVideoGraph, fitVideoNodes, videoGraphProblem, type VideoRender } from '../server/agentVideoGraphs.ts'
import { defaultPolicy, taskDecide, TASK_TOOLS, toolVerdict } from '../src/data/agentTaskPolicy.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// --- frames and sizes --------------------------------------------------------------------------------
{
  assert.equal(h3FrameCount(5), 124)
  assert.equal(h3FrameCount(6), 158)
  for (const s of [5, 6.5, 10, 12.25, 15]) assert.equal(h3FrameCount(s) % 17, 5, `H3 ${s} s is 17k + 5 frames`)
  assert.ok(h3FrameCount(10) >= 240)
  assert.throws(() => h3FrameCount(4.9), /5 to 15/)
  assert.throws(() => h3FrameCount(15.5), /5 to 15/)
  assert.equal(ltxFrameCount(1), 25)
  assert.equal(ltxFrameCount(15), 361)
  assert.throws(() => ltxFrameCount(2.5), /whole number/)
  assert.throws(() => ltxFrameCount(16), /whole number/)
  assert.equal(effectiveSeconds('minimax_h3', 5).toFixed(2), '5.17')
  assert.deepEqual(videoSizeFor(16 / 9, 768, 'minimax_h3'), { width: 1344, height: 768 })
  assert.deepEqual(videoSizeFor(16 / 9, 480, 'minimax_h3'), { width: 832, height: 480 })
  const ltx = videoSizeFor(16 / 9, 720, 'ltx25')
  assert.ok(ltx.width % 64 === 0 && ltx.height % 64 === 0 && ltx.width <= 2048, JSON.stringify(ltx))
  const tall = videoSizeFor(9 / 16, 768, 'minimax_h3')
  assert.ok(tall.height > tall.width && tall.width === 768)
  assert.deepEqual(snapVideoSize(1344, 768, 'ltx25'), { width: 1344, height: 768 })
  assert.deepEqual(snapVideoSize(1350, 770, 'ltx25'), { width: 1344, height: 768 })
  assert.equal(snapDuration('ltx25', 6.4), 6)
  assert.equal(snapDuration('minimax_h3', 3), 5)
  assert.equal(snapDuration('minimax_h3', 7.3), 7.25)
  assert.equal(videoParameterProblem('minimax_h3', 10, 1344, 768), null)
  assert.match(videoParameterProblem('minimax_h3', 10, 1340, 768) ?? '', /multiples of 32/)
  assert.match(videoParameterProblem('ltx25', 5, 1344, 736) ?? '', /multiples of 64/)
  assert.match(videoParameterProblem('ltx25', 5.5, 1280, 704) ?? '', /whole number/)
  console.log('PASS frame and size rules: H3 17k + 5 frames for 5–15 s, LTX seconds × 24 + 1 for whole 1–15 s, size grids (32 / 64), tiers and aspects, snapping')
}

// --- the compiler ------------------------------------------------------------------------------------
const frame = { sourceId: '11111111-1111-4111-8111-111111111111', name: 'ship.png', width: 1344, height: 768, prepared: true }
function ship(): VideoProject {
  const p = defaultProject()
  p.speakers = [{ id: 'S1', who: 'the pilot', voice: 'a low, calm male voice' }]
  p.soundscape = 'hangar hum, wind'
  const seg = p.segments[0]
  seg.duration = 10
  seg.firstFrame = frame
  seg.lanes.shots = [{ id: 'sh1', start: 0, framing: 'a wide shot of the ship on the pad' }, { id: 'sh2', start: 4, framing: 'a close-up of the engines', transition: 'cut' }]
  seg.lanes.action = [{ id: 'a1', at: 0.5, text: 'The crew steps back' }, { id: 'a2', at: 2.5, text: 'The engines glow' }, { id: 'a3', at: 5, text: 'Flame bursts from the nozzles' }]
  seg.lanes.camera = [{ id: 'c1', at: 0.2, move: 'arc', speed: 'slow' }]
  seg.lanes.speech = [{ id: 's1', at: 1, speaker: 'S1', language: 'English', line: 'Clear the pad!' }]
  seg.lanes.sound = [{ id: 'x1', at: 0, text: 'a klaxon wails' }]
  seg.lanes.text = [{ id: 't1', at: 6, content: 'NX-01', on: 'the hull' }]
  return p
}
{
  const c = compileProject(ship())
  assert.deepEqual(c.problems, [])
  assert.ok(c.plan && c.plan.shots.length === 2)
  assert.match(c.prompt, /^For the target video, at 0\.00 seconds into the target video, <Picture 1> \(from \[Shot 1\]\) is fully referenced\./)
  assert.match(c.prompt, /\[Shot 2\] At 00:04\.000, the camera cuts to a close-up of the engines\./)
  assert.match(c.prompt, /<d>\[English\] Clear the pad!<\/d>/)
  assert.match(c.prompt, /overall_soundscape: Hangar hum, wind\./)
  // Items before the shot's first action join it (no filler moment); the camera and the sound come with "The crew steps back".
  assert.equal(c.plan!.shots[0].moments[0].action, 'The crew steps back')
  assert.equal(c.plan!.shots[0].moments[0].camera?.move, 'arc')
  assert.equal(c.plan!.shots[0].moments[0].sound, 'a klaxon wails')
  // Badges: H3 times its cuts; inside a shot only the order counts; visible text is a hint.
  assert.equal(c.items.sh2.badge, 'Timed'); assert.equal(c.items.a1.badge, 'Ordered'); assert.equal(c.items.c1.badge, 'Ordered'); assert.equal(c.items.s1.badge, 'Ordered'); assert.equal(c.items.t1.badge, 'Hint')
  assert.equal(c.items.a3.shot, 1); assert.equal(c.items.t1.shot, 1)
  assert.equal(laneBadge('minimax_h3', 'keyframe'), 'Real'); assert.equal(laneBadge('minimax_h3', 'lastFrame'), 'Real'); assert.equal(laneBadge('ltx25', 'lastFrame'), 'Off'); assert.equal(laneBadge('ltx25', 'shots'), 'Ordered'); assert.equal(laneBadge('minimax_h3', 'bed'), 'Hint')
  // LTX: one chronological paragraph.
  const l = ship(); l.family = 'ltx25'; l.segments[0].duration = 6
  const lc = compileProject(normalizeProject(l))
  assert.deepEqual(lc.problems, [])
  assert.match(lc.prompt, /^Live-action, cinematic\. The scene begins exactly as in the first frame\./)
  assert.match(lc.prompt, /Then the shot cuts to a close-up of the engines\./)
  assert.ok(!lc.prompt.includes('[Shot'))
  assert.equal(lc.items.sh2.badge, 'Ordered')
  // A last frame: H3 keeps it (FL2VA, landed on in the last shot), LTX drops it.
  const fl = ship(); fl.segments[0].lastFrame = { ...frame, sourceId: '22222222-2222-4222-8222-222222222222' }
  const flc = compileProject(fl)
  assert.match(flc.prompt, /^How the reference pictures align with the target video — Picture 1 \(from Shot 1\) aligns with the 0\.00-second mark of the target video; Picture 2 \(from Shot 2\) aligns with the 10\.13-second mark/)
  assert.match(flc.prompt, /Picture 2 at the end of the shot/)
  assert.equal(normalizeProject({ ...fl, family: 'ltx25' }).segments[0].lastFrame, null)
  // Warnings and problems.
  const w = ship()
  w.segments[0].lanes.action.push({ id: 'neg', at: 6, text: 'No smoke anywhere' })
  w.segments[0].lanes.sound.push({ id: 'long', at: 3, end: 6, text: 'a rumble' })
  w.segments[0].lanes.speech.push({ id: 'ghost', at: 7, speaker: 'S3', language: 'English', line: 'Who?' })
  const wc = compileProject(w)
  assert.ok(wc.warnings.some((x) => /naming something/.test(x)), 'negative phrasing warns')
  assert.ok(wc.warnings.some((x) => /crosses the cut at 4\.00/.test(x)) && wc.items.long.note, 'an item crossing a cut is flagged')
  assert.ok(wc.problems.some((x) => /S3/.test(x)), 'an unknown speaker stops the render')
  const many = ship()
  for (let i = 0; i < 9; i++) many.segments[0].lanes.action.push({ id: `m${i}`, at: 4.1 + i * 0.5, text: `Beat ${i}` })
  const mc = compileProject(many)
  assert.ok(mc.plan!.shots[1].moments.length <= 6 && mc.warnings.some((x) => /more than 6 moments/.test(x)))
  // An empty timeline still makes a valid plan, anchored on the first frame.
  const empty = defaultProject(); empty.segments[0].firstFrame = frame
  const ec = compileProject(empty)
  assert.deepEqual(ec.problems, []); assert.ok(ec.plan!.shots[0].framing.includes(FIRST_FRAME_TOKEN))
  // Too-short shots merge; the raw prompt detaches the lanes.
  const short = ship(); short.segments[0].lanes.shots.push({ id: 'sh3', start: 4.5, framing: 'x' })
  assert.ok(compileProject(short).warnings.some((x) => /shorter than a second/.test(x)))
  const raw = ship(); raw.rawPrompt = 'A hand-written prompt.'
  const rc = compileProject(raw)
  assert.equal(rc.prompt, 'A hand-written prompt.'); assert.ok(rc.warnings[0].includes('by hand'))
  // The agent's plan: validated with errors to fix, and laid out on the lanes again.
  assert.match((validateVideoPromptPlan({ style: 'x', soundscape: 'y', shots: [{ start: 0, end: 3, framing: 'f', moments: [{ action: 'a' }] }, { start: 4, end: 10, framing: 'g', moments: [{ action: 'b' }] }] }, { duration: 10, hasFirstFrame: false }) as { error: string }).error, /must start at 3/)
  const planned = validateVideoPromptPlan(c.plan, { duration: 10, hasFirstFrame: true })
  assert.ok(planned.ok)
  const back = lanesFromPlan(c.plan!)
  assert.equal(back.shots.length, 2); assert.ok(back.action.length >= 3 && back.camera.length === 1 && back.speech.length === 1 && back.text.length === 1)
  assert.equal(videoPromptFromPlan(c.plan!, { family: 'minimax_h3', duration: 10, hasFirstFrame: true }), c.prompt)
  // A stored project is cleaned: unknown fields, bad times and ids.
  const dirty = normalizeProject({ family: 'nonsense', title: 'x'.repeat(500), segments: [{ duration: 99, firstFrame: { sourceId: '../etc/passwd' }, lanes: { action: [{ at: -5, text: 'a' }, { at: 400, text: 'b' }], camera: [{ at: 1, move: 'teleport' }] } }], evil: true })
  assert.equal(dirty.family, 'minimax_h3'); assert.equal(dirty.title.length, 120); assert.equal(dirty.segments[0].duration, 15); assert.equal(dirty.segments[0].firstFrame, null)
  assert.deepEqual(dirty.segments[0].lanes.action.map((a) => a.at), [0, 15]); assert.equal(dirty.segments[0].lanes.camera.length, 0); assert.ok(!('evil' in dirty))
  console.log('PASS compiler: lanes to shots and moments, keyframe anchors (I2VA, FL2VA), H3 and LTX prompts, badges (Real, Timed, Ordered, Hint, Off), crossing cuts, negative phrasing, merged moments and shots, speakers, raw prompt, agent plans both ways, cleaning')
}

// --- the graphs --------------------------------------------------------------------------------------
const H3_FILES = { model: 'video/minimax_h3_fl2va.safetensors', clip: 'enc/minimax_h3_text.safetensors', videoVae: 'vae/minimax_h3_video.safetensors', audioVae: 'vae/minimax_h3_audio.safetensors', turboLora: 'loras/minimax_h3_turbo.safetensors', latentUpscaler: '' }
const LTX_FILES = { model: 'video/ltx-2.5-distilled.safetensors', clip: 'enc/ltx_gemma.safetensors', videoVae: 'vae/ltx_video.safetensors', audioVae: 'vae/ltx_audio.safetensors', turboLora: '', latentUpscaler: 'upscale/ltx_spatial_x2.safetensors' }
const classes = (g: Record<string, { class_type: string }>) => Object.values(g).map((n) => n.class_type).sort()
{
  const r: VideoRender = { family: 'minimax_h3', models: H3_FILES, prompt: 'p', width: 1344, height: 768, duration: 10, seed: 7, steps: 20, turbo: true, turboStrength: 1, turboSteps: 8 }
  const h3 = buildVideoGraph(r, { first: 'a.png', last: 'b.png' })
  assert.deepEqual(classes(h3.graph), ['BasicGuider', 'BasicScheduler', 'CLIPLoader', 'CreateVideo', 'ImageScale', 'ImageScale', 'KSamplerSelect', 'LoadImage', 'LoadImage', 'LoraLoaderModelOnly', 'MiniMaxH3ImageToVideo', 'RandomNoise', 'SamplerCustomAdvanced', 'SaveVideo', 'UNETLoader', 'VAEDecode', 'VAEDecodeAudio', 'VAELoader', 'VAELoader'])
  assert.equal(h3.graph.conditioning.inputs.length, h3FrameCount(10)); assert.equal(h3.frames, h3FrameCount(10))
  assert.deepEqual(h3.graph.conditioning.inputs.first_frame, ['first_frame_fit', 0]); assert.deepEqual(h3.graph.conditioning.inputs.last_frame, ['last_frame_fit', 0])
  assert.deepEqual(h3.graph.first_frame_fit.inputs, { image: ['first_frame_load', 0], upscale_method: 'lanczos', width: 1344, height: 768, crop: 'center' })
  assert.equal(h3.graph.clip.inputs.type, 'minimax'); assert.equal(h3.graph.schedule.inputs.steps, 8, 'Turbo runs 8 steps'); assert.equal(h3.graph.sampler.inputs.sampler_name, 'res_multistep')
  assert.equal(h3.graph.noise.inputs.noise_seed, 7); assert.equal(h3.graph.save.inputs.format, 'mp4'); assert.equal(h3.progress.counters.sample, 'sampling')
  const plain = buildVideoGraph({ ...r, turbo: false }, {})
  assert.ok(!plain.graph.turbo && !plain.graph.first_frame_load && plain.graph.schedule.inputs.steps === 20)
  const lt = buildVideoGraph({ ...r, family: 'ltx25', models: LTX_FILES, duration: 5, width: 1280, height: 704, turbo: false }, { first: 'a.png' })
  assert.equal(lt.graph.latent.inputs.width, 640); assert.equal(lt.graph.latent.inputs.length, 121); assert.equal(lt.graph.clip.inputs.type, 'ltxv')
  assert.equal(lt.graph.image_stage1.inputs.strength, 0.7); assert.equal(lt.graph.image_stage2.inputs.strength, 1); assert.equal(lt.graph.refine_noise.inputs.noise_seed, 42)
  assert.deepEqual(lt.progress.counters, { sample_stage1: 'sampling', sample_stage2: 'refining' })
  assert.throws(() => buildVideoGraph({ ...r, family: 'ltx25', models: LTX_FILES, duration: 5 }, { last: 'b.png' }), /last frame/)
  // Checked against what ComfyUI reports: a missing node, the paid API node, an uninstalled file, the newer SaveVideo shape.
  const schemas = fakeSchemas()
  assert.equal(videoGraphProblem(h3.graph, schemas), null)
  assert.equal(videoGraphProblem(lt.graph, schemas), null)
  assert.match(videoGraphProblem(h3.graph, { ...schemas, MiniMaxH3ImageToVideo: { ...schemas.MiniMaxH3ImageToVideo, api_node: true } }) ?? '', /native MiniMax H3/)
  const { LTXVLatentUpsampler: _gone, ...noUpsampler } = schemas
  assert.match(videoGraphProblem(lt.graph, noUpsampler) ?? '', /missing the LTXVLatentUpsampler/)
  assert.match(videoGraphProblem(buildVideoGraph({ ...r, models: { ...H3_FILES, model: 'nope.safetensors' } }, {}).graph, schemas) ?? '', /not installed/)
  const v3 = { ...schemas, SaveVideo: { input: { required: { filename_prefix: ['STRING'], format: ['COMFY_DYNAMICCOMBO_V3', { options: [{ key: 'mp4', inputs: { required: { codec: [['h264']] } } }] }] } }, output: [] }, CreateVideo: { input: { required: { fps: ['FLOAT', { min: 1, max: 120 }], bit_depth: ['INT'], color_space: [['sRGB', 'Rec709']] }, optional: {} }, output: ['VIDEO'] } }
  const fitted = buildVideoGraph({ ...r, turbo: false }, {})
  fitVideoNodes(fitted.graph, v3 as never)
  assert.equal(fitted.graph.save.inputs['format.codec'], 'h264'); assert.ok(!('codec' in fitted.graph.save.inputs)); assert.equal(fitted.graph.video.inputs.bit_depth, 8); assert.equal(fitted.graph.video.inputs.color_space, 'sRGB')
  assert.equal(videoGraphProblem(fitted.graph, v3 as never), null)
  // Files picked by name when the account left them on Automatic; its own picks win when installed.
  const cat = { models: [H3_FILES.model, LTX_FILES.model, 'video/ltx-2.5-dev.safetensors'], clips: [H3_FILES.clip, LTX_FILES.clip], vaes: [H3_FILES.videoVae, H3_FILES.audioVae, LTX_FILES.videoVae, LTX_FILES.audioVae], loras: [H3_FILES.turboLora], latentUpscalers: [LTX_FILES.latentUpscaler] }
  assert.deepEqual(resolveVideoModels('minimax_h3', emptyVideoModels().minimax_h3, cat), H3_FILES)
  assert.deepEqual(resolveVideoModels('ltx25', emptyVideoModels().ltx25, cat), LTX_FILES)
  console.log('PASS graphs: H3 (Turbo LoRA, first and last frame fitted by ImageScale, 17k + 5 frames) and LTX (two stages, half-size latent, fixed refine seed), refused LTX last frame, schema checks (missing node, API node, uninstalled file), SaveVideo/CreateVideo shapes, automatic file picks')
}

function fakeSchemas() {
  const out = (o: string[]) => o
  const req = (r: Record<string, unknown>) => ({ required: r })
  const n = (required: Record<string, unknown>, output: string[], optional: Record<string, unknown> = {}) => ({ input: { required, optional }, output: out(output) })
  return {
    UNETLoader: n({ unet_name: [[H3_FILES.model, LTX_FILES.model]] }, ['MODEL']),
    CLIPLoader: n({ clip_name: [[H3_FILES.clip, LTX_FILES.clip]], type: [['minimax', 'ltxv', 'sdxl']] }, ['CLIP']),
    VAELoader: n({ vae_name: [[H3_FILES.videoVae, H3_FILES.audioVae, LTX_FILES.videoVae, LTX_FILES.audioVae]] }, ['VAE']),
    LoraLoaderModelOnly: n({ lora_name: [[H3_FILES.turboLora]] }, ['MODEL']),
    MiniMaxH3ImageToVideo: n({ width: ['INT', { min: 32, max: 16384 }], height: ['INT', { min: 32, max: 16384 }], length: ['INT', { min: 1, max: 1000 }] }, ['CONDITIONING', 'LATENT'], { first_frame: ['IMAGE'], last_frame: ['IMAGE'] }),
    LoadImage: n({ image: [[]] }, ['IMAGE', 'MASK']),
    ImageScale: n({ upscale_method: [['lanczos', 'bilinear']], crop: [['disabled', 'center']] }, ['IMAGE']),
    RandomNoise: n({}, ['NOISE']),
    BasicGuider: n({}, ['GUIDER']),
    KSamplerSelect: n({ sampler_name: [['euler', 'euler_ancestral', 'res_multistep']] }, ['SAMPLER']),
    BasicScheduler: n({ scheduler: [['simple', 'beta']] }, ['SIGMAS']),
    SamplerCustomAdvanced: n({}, ['LATENT', 'LATENT']),
    VAEDecode: n({}, ['IMAGE']),
    VAEDecodeAudio: n({}, ['AUDIO']),
    CreateVideo: n({ fps: ['FLOAT', { min: 1, max: 120 }] }, ['VIDEO']),
    SaveVideo: n({ format: [['auto', 'mp4']], codec: [['auto', 'h264']] }, []),
    CLIPTextEncode: n({}, ['CONDITIONING']),
    LTXVConditioning: n({}, ['CONDITIONING', 'CONDITIONING']),
    LTXVDualCFGGuider: n({}, ['GUIDER']),
    EmptyLTXVLatentVideo: n({ width: ['INT', { min: 64, max: 8192 }] }, ['LATENT']),
    LTXVPreprocess: n({}, ['IMAGE']),
    LTXVImgToVideoInplace: n({}, ['LATENT']),
    LTXVEmptyLatentAudio: n({}, ['LATENT']),
    LTXVConcatAVLatent: n({}, ['LATENT']),
    ManualSigmas: n({}, ['SIGMAS']),
    LTXVSeparateAVLatent: n({}, ['LATENT', 'LATENT']),
    LatentUpscaleModelLoader: n({ model_name: [[LTX_FILES.latentUpscaler]] }, ['LATENT_UPSCALE_MODEL']),
    LTXVLatentUpsampler: n({}, ['LATENT']),
    VAEDecodeTiled: n({}, ['IMAGE']),
    LTXVAudioVAEDecode: n({}, ['AUDIO']),
    _unused: req({}),
  } as Record<string, any>
}

// --- the agent tools' permissions --------------------------------------------------------------------
{
  for (const name of ['plan_video', 'render_video']) {
    assert.ok(TASK_TOOLS[name], `${name} is classified for tasks`)
    assert.equal(TASK_TOOLS[name].default, 'block'); assert.ok(TASK_TOOLS[name].unavailable)
    assert.equal(toolVerdict({ ...defaultPolicy(), tools: { [name]: 'allow' }, groups: { images: 'allow' } }, name), 'block', `${name}: a task's policy cannot allow it`)
    assert.equal(taskDecide(defaultPolicy(), { name }, { holdsPrivate: false, given: () => false, dryRun: false }).verdict, 'block')
  }
  console.log('PASS task runs: plan_video and render_video are classified and always blocked')
}

// --- the server, against a stand-in ComfyUI -----------------------------------------------------------
const png = readFileSync(new URL('./fixtures/agent-image-sources/source.png', import.meta.url))
const schemas = fakeSchemas()
const graphs: any[] = []
const deletions: string[] = []
const uploads: string[] = []
/** hold: video prompts never finish; holdImage: picture prompts never finish. */
let hold = false
let holdImage = false
let videoBytes = 256 * 1024
/** How /view sends a video: whole (with its length), slow (a first piece, then waits for releaseSlow), or chunked (no length). */
let viewMode: 'whole' | 'slow' | 'chunked' = 'whole'
let releaseSlow: () => void = () => {}
const promptGraphs = new Map<string, any>()
const isVideo = (g: any) => Object.values(g).some((n: any) => n.class_type === 'SaveVideo')
let jobs = 0
const mp4 = () => {
  const b = Buffer.alloc(videoBytes, 7)
  Buffer.from([0, 0, 0, 0x18]).copy(b, 0)
  Buffer.from('ftypmp42', 'ascii').copy(b, 4)
  return b
}
// The image nodes too, so an Image Studio run plans and reaches the shared one-job slot.
const IMAGE_NODES: Record<string, unknown> = Object.fromEntries(Object.entries({
  CheckpointLoaderSimple: { ckpt_name: [['SDXL/studio.safetensors']] }, KSampler: { sampler_name: [['euler']], scheduler: [['normal']] },
  EmptyLatentImage: {}, SaveImage: {}, VAEEncode: {}, ConditioningZeroOut: {}, LoraLoader: { lora_name: [[]] }, CLIPSetLastLayer: {}, ModelSamplingDiscrete: {},
}).map(([k, required]) => [k, { input: { required }, output: [] }]))
const comfy = createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', (b) => chunks.push(b))
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('latin1')
    const path = new URL(req.url!, 'http://fixture').pathname
    const send = (v: unknown) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(v))
    if (path.startsWith('/object_info/')) {
      const node = path.slice(13)
      // The image catalog (Settings) asks for its own nodes too: SaveImage and friends, minimal.
      return send(schemas[node] ? { [node]: schemas[node] } : IMAGE_NODES[node] ? { [node]: IMAGE_NODES[node] } : {})
    }
    if (path === '/upload/image') {
      const name = /filename="([^"]+)"/.exec(raw)![1]
      uploads.push(name)
      return send({ name, subfolder: '', type: 'input' })
    }
    if (path === '/prompt') {
      const graph = JSON.parse(raw).prompt
      graphs.push(graph)
      promptGraphs.set(`job-${++jobs}`, graph)
      return send({ prompt_id: `job-${jobs}` })
    }
    if (path.startsWith('/history/')) {
      const id = path.split('/').pop()!
      const graph = promptGraphs.get(id) ?? {}
      if (isVideo(graph) ? hold : holdImage) return send({})
      if (!isVideo(graph)) {
        const save = Object.entries(graph).find(([, n]: any) => n.class_type === 'SaveImage')?.[0] ?? '9'
        return send({ [id]: { status: { completed: true, status_str: 'success' }, outputs: { [save]: { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } } } })
      }
      return send({ [id]: { status: { completed: true, status_str: 'success' }, outputs: { save: { images: [{ filename: 'MvL_H3_00001_.mp4', subfolder: 'video', type: 'output' }], animated: [true] } } } })
    }
    if (path === '/view' && new URL(req.url!, 'http://fixture').searchParams.get('filename')?.endsWith('.png')) return res.writeHead(200, { 'Content-Type': 'image/png' }).end(png)
    if (path === '/view') {
      const body = mp4()
      if (viewMode === 'whole') return res.writeHead(200, { 'Content-Type': 'video/mp4' }).end(body)
      if (viewMode === 'chunked') {
        res.writeHead(200, { 'Content-Type': 'video/mp4' })
        for (let i = 0; i < body.length; i += 1024 * 1024) res.write(body.subarray(i, i + 1024 * 1024))
        return res.end()
      }
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': String(body.length) })
      res.write(body.subarray(0, 64 * 1024))
      releaseSlow = () => res.end(body.subarray(64 * 1024))
      return
    }
    if (path === '/queue' && req.method === 'POST') {
      deletions.push(...JSON.parse(raw).delete)
      return send({})
    }
    if (path === '/queue') return send({ queue_running: [], queue_pending: [] })
    res.writeHead(404).end()
  })
})
await new Promise<void>((r) => comfy.listen(0, '127.0.0.1', r))
const comfyUrl = `http://127.0.0.1:${(comfy.address() as { port: number }).port}`
const server = new Server({ GITHUB_CLIENT_ID: 'x', GITHUB_CLIENT_SECRET: 'x', ADMIN_GITHUB_IDS: '1,2' })
process.env.DATA_DIR = server.data
const { database, encrypt, sha256 } = await import('../server/db.ts')
const sessions = [randomBytes(24).toString('hex'), randomBytes(24).toString('hex')]
for (let i = 1; i <= 2; i++) {
  database().prepare('INSERT INTO users (id, github_id, login, github_token, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(i, i, i === 1 ? 'video-owner' : 'video-other', encrypt('none'), Date.now(), Date.now())
  database().prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(sessions[i - 1]), i, Date.now(), Date.now() + 86400_000)
}
// The decisions themselves (server/agents.ts decide), in this process; it never starts the agents (no job recovery here).
const { decide } = await import('../server/agents.ts')
await server.start()
const call = async (method: string, path: string, body?: unknown, account: number | null = 0, headers: Record<string, string> = {}) =>
  fetch(server.origin + path, { method, headers: { ...(account === null ? { 'X-MvL-Account': 'visitor' } : { Cookie: `mvlos_sid=${sessions[account]}`, ...(await asPage(sessions[account])) }), 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
const ok = async (method: string, path: string, body?: unknown, account = 0) => {
  const res = await call(method, path, body, account)
  assert.equal(res.status, 200, `${method} ${path}: ${await res.clone().text()}`)
  return res.json() as Promise<any>
}
const job = (id: string, account = 0) => ok('GET', `/api/video/jobs/${id}`, undefined, account)
const until = async (id: string, statuses: string[], ms = 15_000) => {
  const end = Date.now() + ms
  for (;;) {
    const j = await job(id)
    if (statuses.includes(j.status)) return j
    if (Date.now() > end) throw new Error(`job ${id} stayed ${j.status} (${j.error ?? ''}), wanted ${statuses.join('/')}`)
    await sleep(100)
  }
}
const pngData = png.toString('base64')
const waitFor = async (what: string, test: () => boolean | Promise<boolean>, ms = 15_000) => {
  const end = Date.now() + ms
  while (!(await test())) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`)
    await sleep(50)
  }
}
const picture = { preset: 'sdxl', model: 'SDXL/studio.safetensors', prompt: 'p', steps: 4, cfg: 6, sampler: 'euler', scheduler: 'normal', width: 512, height: 512 }
/** An Image Studio run, read to its end: its NDJSON events. */
const studioRun = (batch = 1) => call('POST', '/api/agents/images/studio/run', { input: picture, batch }).then(async (r) => (await r.text()).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)))
const parts = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.part')) : [])

// Signed in only.
assert.ok([401, 403].includes((await call('GET', '/api/video/projects', undefined, null)).status))
assert.ok([401, 403].includes((await call('GET', '/api/video/media/11111111-1111-4111-8111-111111111111', undefined, null)).status))
// A keyframe must be one of the account's own pictures.
assert.equal((await call('POST', '/api/video/projects', { project: ship() })).status, 404)
try {
  const src = await ok('POST', '/api/video/sources', { name: 'ship.png', data: pngData })
  assert.match(src.id, /^[0-9a-f-]{36}$/)
  assert.equal((await call('GET', `/api/video/sources/${src.id}`)).status, 200)
  assert.equal((await call('GET', `/api/video/sources/${src.id}`, undefined, 1)).status, 404, 'another account cannot read a keyframe')
  const notPng = await call('POST', '/api/video/sources', { name: 'x.png', data: Buffer.from('hello').toString('base64') })
  assert.equal(notPng.status >= 400, true)
  const p = ship()
  p.segments[0].firstFrame = { sourceId: src.id, name: 'ship.png', width: 1344, height: 768, prepared: true }
  p.segments[0].lastFrame = { sourceId: src.id, name: 'ship.png', width: 1344, height: 768, prepared: true }
  const rec = await ok('POST', '/api/video/projects', { project: p })
  const id = rec.id
  // Isolation: another account sees none of it.
  for (const [method, path] of [['GET', `/api/video/projects/${id}`], ['PUT', `/api/video/projects/${id}`], ['DELETE', `/api/video/projects/${id}`], ['POST', `/api/video/projects/${id}/render`]] as const) assert.equal((await call(method, path, method === 'PUT' ? { revision: 1, project: p } : method === 'POST' ? {} : undefined, 1)).status, 404, `${method} ${path} as another account`)
  assert.equal((await ok('GET', '/api/video/projects', undefined, 1)).projects.length, 0)
  const theirs = ship(); theirs.segments[0].firstFrame = { ...p.segments[0].firstFrame! }
  assert.equal((await call('POST', '/api/video/projects', { project: theirs }, 1)).status, 404, 'another account cannot use this keyframe')
  // Revisions: a save based on an old revision is refused with the current one.
  const saved = await ok('PUT', `/api/video/projects/${id}`, { revision: 1, project: { ...p, title: 'Launch' } })
  assert.equal(saved.revision, 2); assert.equal(saved.project.title, 'Launch')
  const stale = await call('PUT', `/api/video/projects/${id}`, { revision: 1, project: p })
  assert.equal(stale.status, 409); assert.equal((await stale.json()).current.revision, 2)
  console.log('PASS projects and keyframes: sign-in, PNG keyframes, owner-only on every route, revisions refuse stale saves')

  // Not connected yet.
  const off = await call('POST', `/api/video/projects/${id}/render`, {})
  assert.equal(off.status, 409); assert.match(await off.text(), /Connect ComfyUI/)
  await ok('PUT', '/api/agents/images/settings', { url: comfyUrl, preset: 'sdxl' })
  const cat = await ok('GET', '/api/video/catalog')
  assert.ok(cat.catalog.families.minimax_h3.ok && cat.catalog.families.ltx25.ok, JSON.stringify(cat.catalog.families))
  assert.equal(cat.resolved.minimax_h3.model, H3_FILES.model)

  // A render: queued, run by the server, saved as a file, served with ranges.
  const started = await ok('POST', `/api/video/projects/${id}/render`, {})
  assert.ok(['queued', 'uploading'].includes(started.status), started.status)
  const done = await until(started.id, ['done', 'failed'])
  assert.equal(done.status, 'done', done.error)
  const g = graphs.at(-1)
  assert.equal(g.conditioning.class_type, 'MiniMaxH3ImageToVideo'); assert.equal(g.conditioning.inputs.length, h3FrameCount(10))
  assert.ok(uploads.length === 2 && uploads.every((u) => /^mvl-video-[0-9a-f-]{36}\.png$/.test(u)) && g.first_frame_load.inputs.image === uploads[0] && g.last_frame_load.inputs.image === uploads[1], 'keyframes uploaded under random names')
  assert.match(g.conditioning.inputs.prompt, /\[Shot 2\] At 00:04\.000/)
  const vids = (await ok('GET', `/api/video/videos?project=${id}`)).videos
  assert.equal(vids.length, 1); assert.equal(vids[0].size, videoBytes); assert.equal(vids[0].frames, h3FrameCount(10))
  const vid = vids[0].id
  const dir = join(server.data, 'videos', '1')
  assert.ok(existsSync(join(dir, `${vid}.mp4`)), 'the video is a file in DATA_DIR/videos/<user>')
  const full = await call('GET', `/api/video/media/${vid}`)
  assert.equal(full.status, 200); assert.equal(full.headers.get('accept-ranges'), 'bytes'); assert.equal(full.headers.get('content-type'), 'video/mp4'); assert.equal((await full.arrayBuffer()).byteLength, videoBytes)
  const part = await call('GET', `/api/video/media/${vid}`, undefined, 0, { Range: 'bytes=4-11' })
  assert.equal(part.status, 206); assert.equal(part.headers.get('content-range'), `bytes 4-11/${videoBytes}`); assert.equal(Buffer.from(await part.arrayBuffer()).toString('ascii'), 'ftypmp42')
  const tail = await call('GET', `/api/video/media/${vid}`, undefined, 0, { Range: 'bytes=-10' })
  assert.equal(tail.status, 206); assert.equal(tail.headers.get('content-range'), `bytes ${videoBytes - 10}-${videoBytes - 1}/${videoBytes}`)
  const open = await call('GET', `/api/video/media/${vid}`, undefined, 0, { Range: 'bytes=1000-' })
  assert.equal(open.status, 206); assert.equal(Number(open.headers.get('content-length')), videoBytes - 1000)
  assert.equal((await call('GET', `/api/video/media/${vid}`, undefined, 0, { Range: `bytes=${videoBytes}-` })).status, 416)
  assert.equal((await call('GET', `/api/video/media/${vid}`, undefined, 0, { Range: 'bytes=5-2' })).status, 416)
  const head = await call('HEAD', `/api/video/media/${vid}`)
  assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), String(videoBytes))
  assert.equal((await call('GET', `/api/video/media/${vid}`, undefined, 1)).status, 404, 'another account cannot play it')
  assert.equal((await call('DELETE', `/api/video/videos/${vid}`, undefined, 1)).status, 404)
  assert.equal((await call('GET', `/api/video/jobs/${started.id}`, undefined, 1)).status, 404)
  assert.equal((await call('DELETE', `/api/video/jobs/${started.id}`, undefined, 1)).status, 404)
  console.log('PASS render: queued, run on the server, keyframes under random names, the compiled prompt, an MP4 file in DATA_DIR, byte ranges (206, suffix, open-ended, 416, HEAD), owner-only')

  // Cancel: our queued prompt is deleted, nothing is kept.
  hold = true
  const held = await ok('POST', `/api/video/projects/${id}/render`, {})
  await until(held.id, ['running'])
  const heldPrompt = `job-${jobs}`
  // The one ComfyUI slot is the account's: a picture asked for during a render waits for it, and does not fail.
  const before = graphs.length
  const waitingPicture = studioRun()
  await sleep(800)
  assert.equal(graphs.length, before, 'the picture waits: nothing sent to ComfyUI while the video holds the slot')
  await ok('DELETE', `/api/video/jobs/${held.id}`)
  const after = await until(held.id, ['cancelled'])
  assert.match(after.error, /Cancelled/)
  assert.ok(deletions.includes(heldPrompt), 'its queued prompt is deleted from ComfyUI')
  const waited = await waitingPicture
  assert.ok(waited.some((e) => e.type === 'image') && !waited.some((e) => e.type === 'error'), `the waiting picture is made once the slot is free: ${JSON.stringify(waited.at(-1))}`)
  assert.equal((await ok('GET', `/api/video/videos?project=${id}`)).videos.length, 1, 'nothing kept')
  // An Image Studio batch keeps the slot between its pictures: a render queued meanwhile starts after it.
  holdImage = true
  const g0 = graphs.length
  const batch = studioRun(2)
  await waitFor('the first picture of the batch is sent', () => graphs.length > g0)
  const between = await ok('POST', `/api/video/projects/${id}/render`, {})
  holdImage = false
  await waitFor('the second picture is sent', () => graphs.filter((g) => !isVideo(g)).length >= graphs.filter((g, i) => i < g0 && !isVideo(g)).length + 2)
  const batchEvents = await batch
  assert.equal(batchEvents.filter((e) => e.type === 'image').length, 2, JSON.stringify(batchEvents.at(-1)))
  assert.ok(!batchEvents.some((e) => e.type === 'error'), 'no picture of the batch fails')
  hold = false
  assert.equal((await until(between.id, ['done', 'failed'])).status, 'done')
  const sent = graphs.slice(g0).map((g) => isVideo(g))
  assert.ok(sent.indexOf(true) > sent.lastIndexOf(false), `the render was sent only after both pictures: ${sent.join(',')}`)
  hold = true

  // A restart: the running job is marked interrupted, not lost and not resubmitted.
  const cut = await ok('POST', `/api/video/projects/${id}/render`, {})
  await until(cut.id, ['running'])
  const submitted = jobs
  writeFileSync(join(dir, 'leftover.part'), 'half a video')
  await server.stop()
  await server.start()
  assert.deepEqual(parts(dir), [], 'a restart removes half-written downloads')
  const interrupted = await job(cut.id)
  assert.equal(interrupted.status, 'interrupted'); assert.match(interrupted.error, /restarted/)
  await sleep(500)
  assert.equal(jobs, submitted, 'nothing resubmitted after the restart')
  hold = false
  // Cancelled while the video downloads: the download stops, its file goes, the slot is free again.
  viewMode = 'slow'
  const slow = await ok('POST', `/api/video/projects/${id}/render`, {})
  await until(slow.id, ['saving'])
  await waitFor('a half-written download', () => parts(dir).length > 0)
  await ok('DELETE', `/api/video/jobs/${slow.id}`)
  assert.equal((await until(slow.id, ['cancelled', 'failed', 'done'])).status, 'cancelled')
  assert.deepEqual(parts(dir), [], 'the half-written file is removed')
  releaseSlow()
  viewMode = 'whole'
  assert.equal((await until((await ok('POST', `/api/video/projects/${id}/render`, {})).id, ['done', 'failed'])).status, 'done', 'the slot was let go')
  console.log('PASS jobs: cancel deletes only our prompt and keeps nothing; a picture waits for a running render instead of failing, and a Studio batch keeps the slot between its pictures; a restart marks the running render interrupted without resubmitting and removes half-written files; a cancel mid-download removes the file and frees the slot')

  // A queue limit per account.
  hold = true
  const posts = await Promise.all(Array.from({ length: 6 }, () => call('POST', `/api/video/projects/${id}/render`, {})))
  const queued: string[] = []
  for (const r of posts) if (r.status === 200) queued.push((await r.json()).id)
  else assert.equal(r.status, 429)
  assert.equal(queued.length, 4, 'six at once: four queued, two refused')
  assert.equal((await ok('GET', '/api/video/jobs?active=1')).jobs.length, 4)
  for (const q of queued) await ok('DELETE', `/api/video/jobs/${q}`)
  for (const q of queued) await until(q, ['cancelled'])
  hold = false

  // Quota: refused before queueing when there is no room for the estimate, and at save time when the real file does not fit.
  database().prepare("INSERT INTO app_settings (key, value) VALUES ('user_storage_mb', '1') ON CONFLICT (key) DO UPDATE SET value = excluded.value").run()
  const full1 = await call('POST', `/api/video/projects/${id}/render`, {})
  assert.equal(full1.status, 413); assert.match(await full1.text(), /storage is full/)
  database().prepare("UPDATE app_settings SET value = '48' WHERE key = 'user_storage_mb'").run()
  videoBytes = 52 * 1024 * 1024
  const big = await ok('POST', `/api/video/projects/${id}/render`, {})
  const failed = await until(big.id, ['failed', 'done'])
  assert.equal(failed.status, 'failed'); assert.match(failed.error, /storage is full.*was not kept/)
  const files = () => readdirSync(dir).filter((f) => f !== `${vid}.mp4` && !(f.endsWith('.mp4') && existsSync(join(dir, f)) && (Date.now() - 0) > 0 && (database().prepare('SELECT 1 FROM agent_videos WHERE id = ?').get(f.replace('.mp4', '')))))
  assert.deepEqual(files(), [], 'no half-written or refused file left')
  // Without a length up front: the download stops at the room the account has.
  viewMode = 'chunked'
  const chunked = await until((await ok('POST', `/api/video/projects/${id}/render`, {})).id, ['failed', 'done'])
  assert.equal(chunked.status, 'failed'); assert.match(chunked.error, /storage is full.*was not kept/)
  assert.deepEqual(files(), [], 'nothing left of the refused stream')
  viewMode = 'whole'
  database().prepare("DELETE FROM app_settings WHERE key = 'user_storage_mb'").run()
  videoBytes = 256 * 1024
  console.log('PASS limits: four renders per account at a time, also when asked for at once; storage refused before queueing (estimate), before reading (announced size) and while streaming (no size), leaving no file')

  // Keyframes: the same picture copied again is the same keyframe; ones nothing uses are swept.
  const thread = '33333333-3333-4333-8333-333333333333', imageId = '44444444-4444-4444-8444-444444444444'
  database().prepare("INSERT INTO agent_threads (id, user_id, title, mode, model, archived, created_at, updated_at, quick) VALUES (?, 1, 'x', 'quick', '', 0, ?, ?, 0)").run(thread, Date.now(), Date.now())
  database().prepare('INSERT INTO agent_images (id, thread_id, name, body, created_at) VALUES (?, ?, ?, ?, ?)').run(imageId, thread, 'made.png', png, Date.now())
  const copy1 = await ok('POST', '/api/video/sources', { image_id: imageId })
  const copy2 = await ok('POST', '/api/video/sources', { image_id: imageId })
  assert.equal(copy2.id, copy1.id, 'copied again: the same keyframe')
  assert.equal((await call('POST', '/api/video/sources', { image_id: imageId }, 1)).status, 404, 'not another account\'s picture')
  const loose = await ok('POST', '/api/video/sources', { name: 'loose.png', data: pngData })
  const fresh = await ok('POST', '/api/video/sources', { name: 'fresh.png', data: pngData })
  database().prepare('UPDATE agent_video_sources SET created_at = ? WHERE id IN (?, ?, ?)').run(Date.now() - 2 * 3600_000, loose.id, copy1.id, src.id)
  const cur = await ok('GET', `/api/video/projects/${id}`)
  await ok('PUT', `/api/video/projects/${id}`, { revision: cur.revision, project: cur.project })
  assert.equal((await call('GET', `/api/video/sources/${loose.id}`)).status, 404, 'an old keyframe nothing uses is swept on save')
  assert.equal((await call('GET', `/api/video/sources/${copy1.id}`)).status, 404)
  assert.equal((await call('GET', `/api/video/sources/${src.id}`)).status, 200, 'the project\'s keyframe stays')
  assert.equal((await call('GET', `/api/video/sources/${fresh.id}`)).status, 200, 'a just-uploaded keyframe stays (not saved into its project yet)')
  console.log('PASS keyframes: a picture copied again reuses its keyframe; old keyframes no project or render uses are swept on save, the project\'s and fresh uploads stay')

  // LTX: first frame only; the project drops a last frame.
  const l = await ok('PUT', `/api/video/projects/${id}`, { revision: (await ok('GET', `/api/video/projects/${id}`)).revision, project: { ...p, family: 'ltx25', width: 1280, height: 704, segments: [{ ...p.segments[0], duration: 5 }] } })
  assert.equal(l.project.segments[0].lastFrame, null)
  const lj = await until((await ok('POST', `/api/video/projects/${id}/render`, {})).id, ['done', 'failed'])
  assert.equal(lj.status, 'done', lj.error)
  assert.equal(graphs.at(-1).latent.class_type, 'EmptyLTXVLatentVideo'); assert.equal(graphs.at(-1).latent.inputs.length, 121)
  console.log('PASS LTX 2.5: a whole-second clip from a first frame, its two-stage graph; a last frame is dropped')

  // The agent tools: plan_video saves a project (errors back to the model), render_video always asks and Plan refuses it.
  const { planVideoTool } = await import('../server/agentVideo.ts')
  const owner = { id: 1, githubId: 1, login: 'video-owner', name: null, avatar: null, githubToken: '', githubScopes: [], admin: true }
  assert.throws(() => planVideoTool(owner, 't', { duration: 10, plan: { style: 'x', soundscape: 'y', shots: [{ start: 0, end: 4, framing: 'f', moments: [{ action: 'a' }] }] } }), /last shot ends at 4s/)
  assert.throws(() => planVideoTool(owner, 't', { family: 'ltx25', duration: 5.5, plan: {} }), /whole number/)
  const planned = planVideoTool(owner, 't', { title: 'Orbit', duration: 6, plan: { style: 'Live-action', soundscape: 'wind', shots: [{ start: 0, end: 6, framing: 'the ship', moments: [{ action: 'The camera circles the ship', camera: { move: 'arc', speed: 'slow' } }] }] } })
  assert.match(planned.project_id, /^[0-9a-f-]{36}$/); assert.deepEqual(planned.problems, [])
  const agentProject = await ok('GET', `/api/video/projects/${planned.project_id}`)
  assert.equal(agentProject.origin, 'agent'); assert.equal(agentProject.project.segments[0].lanes.camera[0].move, 'arc')
  const t = 'thread-x'
  for (const mode of ['default', 'auto', 'acceptEdits', 'bypass'] as const) {
    assert.equal(decide(t, mode, { name: 'render_video', arguments: { project_id: planned.project_id } }, 1), 'ask', `render_video asks in ${mode}`)
    assert.equal(decide(t, mode, { name: 'plan_video', arguments: {} }, 1), 'run', `plan_video runs in ${mode}`)
  }
  assert.equal(decide(t, 'plan', { name: 'render_video', arguments: {} }, 1), 'refuse')
  assert.equal(decide(t, 'plan', { name: 'plan_video', arguments: {} }, 1), 'run', 'planning a new video is fine in Plan mode')
  assert.equal(decide(t, 'plan', { name: 'plan_video', arguments: { project_id: planned.project_id } }, 1), 'refuse', 'Plan mode does not replace an earlier plan')
  // plan_video replaces only a plan this thread's agent made; any other id gets a new project.
  const orbit = { duration: 6, plan: { style: 'Live-action', soundscape: 'wind', shots: [{ start: 0, end: 6, framing: 'the ship', moments: [{ action: 'It drifts' }] }] } }
  const again = planVideoTool(owner, 't', { ...orbit, title: 'Orbit 2', project_id: planned.project_id })
  assert.equal(again.project_id, planned.project_id); assert.equal(again.replaced, true)
  const elsewhere = planVideoTool(owner, 'thread-y', { ...orbit, project_id: planned.project_id })
  assert.notEqual(elsewhere.project_id, planned.project_id); assert.equal(elsewhere.replaced, false)
  const studioTitle = (await ok('GET', `/api/video/projects/${id}`)).project.title
  const notTheirs = planVideoTool(owner, 't', { ...orbit, title: 'Overwrite?', project_id: id })
  assert.notEqual(notTheirs.project_id, id); assert.equal((await ok('GET', `/api/video/projects/${id}`)).project.title, studioTitle, 'a Studio project is never overwritten by an agent')
  assert.equal((await ok('GET', `/api/video/projects/${planned.project_id}`)).project.title, 'Orbit 2')
  // The approval card shows the whole prompt, not the first 4000 characters.
  const { prepareRenderTool } = await import('../server/agentVideo.ts')
  const long = defaultProject()
  long.segments[0].lanes.action = Array.from({ length: 6 }, (_, i) => ({ id: `l${i}`, at: i, text: `${'A long, carefully described beat of action. '.repeat(25)}${i}` }))
  const longId = (await ok('POST', '/api/video/projects', { project: long })).id
  const card = await prepareRenderTool(owner, { project_id: longId }, AbortSignal.timeout(20_000))
  const fullPrompt = compileProject(long).prompt
  assert.ok(fullPrompt.length > 4000); assert.equal(card.summary.body, fullPrompt)
  console.log('PASS agent tools: plan_video saves an editable project and returns plan errors, replaces only its own thread\'s plans (never in Plan mode); render_video asks in every mode (Bypass too) with the whole prompt on its card, and Plan refuses it')
} finally {
  await server.dispose()
  comfy.close()
}
console.log('all passed')
