// The Video Studio's prompt plan and its timeline. A plan is what a video model is told: shots
// (each one a cut), what happens within each shot in order (moments: action, camera move, a line
// of dialogue, a synced sound, visible text), the speakers, and the sound beds. The plan part is a
// port of Diffu's promptPlan.ts (MiniMax's base-mode prompt format for H3, one chronological
// paragraph for LTX): `validateVideoPromptPlan` checks a plan and phrases its errors so an agent
// can fix them, and `videoPromptFromPlan` writes the prompt. The timeline part is MvL's: the
// editor's lanes (shots, action, camera, speech, sound, text) and `compileProject`, which turns
// them into a plan, with a badge per item that says honestly how much control it gives.
//
// Shared by the browser (the editor shows the compiled prompt) and the server (which compiles and
// checks again before a render and never takes a prompt from the browser as given). No DOM or
// Node APIs here.
import { h3FrameCount } from './videoModels.ts'

export type VideoPromptFamily = 'minimax_h3' | 'ltx25';

export const CAMERA_MOVES = [
  'push_in', 'pull_out', 'zoom_in', 'zoom_out', 'pan_left', 'pan_right', 'truck_left', 'truck_right',
  'tilt_up', 'tilt_down', 'pedestal_up', 'pedestal_down', 'arc', 'tracking', 'static', 'shake_slightly',
  'shake_strongly', 'pov', 'roll_clockwise', 'roll_counterclockwise',
] as const;
export type CameraMove = (typeof CAMERA_MOVES)[number];

/** MiniMax's camera vocabulary, as the verb phrase that follows "The camera". */
export const CAMERA_PHRASES: Record<CameraMove, { phrase: string; label: string }> = {
  push_in: { phrase: 'pushes in', label: 'Push in' },
  pull_out: { phrase: 'pulls out', label: 'Pull out' },
  zoom_in: { phrase: 'zooms in', label: 'Zoom in' },
  zoom_out: { phrase: 'zooms out', label: 'Zoom out' },
  pan_left: { phrase: 'pans left', label: 'Pan left' },
  pan_right: { phrase: 'pans right', label: 'Pan right' },
  truck_left: { phrase: 'trucks left', label: 'Truck left' },
  truck_right: { phrase: 'trucks right', label: 'Truck right' },
  tilt_up: { phrase: 'tilts up', label: 'Tilt up' },
  tilt_down: { phrase: 'tilts down', label: 'Tilt down' },
  pedestal_up: { phrase: 'pedestals up', label: 'Pedestal up' },
  pedestal_down: { phrase: 'pedestals down', label: 'Pedestal down' },
  arc: { phrase: 'arcs around the subject', label: 'Arc shot' },
  tracking: { phrase: 'tracks the subject', label: 'Tracking shot' },
  static: { phrase: 'holds a static shot', label: 'Static shot' },
  shake_slightly: { phrase: 'shakes slightly', label: 'Slight shake' },
  shake_strongly: { phrase: 'shakes strongly', label: 'Strong shake' },
  pov: { phrase: 'shows a POV shot', label: 'POV' },
  roll_clockwise: { phrase: 'rolls clockwise', label: 'Roll clockwise' },
  roll_counterclockwise: { phrase: 'rolls counterclockwise', label: 'Roll counterclockwise' },
};

export const SHOT_TRANSITIONS = ['cut', 'cross_dissolve', 'fade', 'wipe'] as const;
export type ShotTransition = (typeof SHOT_TRANSITIONS)[number];
const TRANSITION_PHRASES: Record<ShotTransition, string> = {
  cut: 'the camera cuts to',
  cross_dissolve: 'the shot cross-dissolves to',
  fade: 'the shot fades to',
  wipe: 'the shot wipes to',
};

export interface VideoCamera {
  move: CameraMove;
  amplitude?: 'small' | 'large';
  speed?: 'slow' | 'fast';
  /** Where or how, e.g. "toward the folded letter in her hands" or "as the runner exits the frame". */
  target?: string;
}

export interface VideoSpeaker {
  /** S1, S2, ... in order of who speaks first. */
  id: string;
  /** Who it is, e.g. "the young woman". */
  who: string;
  /** How the voice sounds: age, pitch, timbre, pace, accent. */
  voice: string;
}

export interface VideoDialogue {
  speaker: string;
  language: string;
  line: string;
  /** How it is said, e.g. "softly, with a smile". */
  delivery?: string;
  /** Narration over the picture; the speaker's lips stay closed. */
  voiceover?: boolean;
}

export interface VideoMoment {
  /** What happens, in present tense, including sounds synced to it. */
  action: string;
  camera?: VideoCamera;
  dialogue?: VideoDialogue;
  /** Text visible in the frame, quoted verbatim. */
  text?: { content: string; on: string };
  /** A sound synced to this moment's action, e.g. "the door slams shut". */
  sound?: string;
}

export interface VideoShot {
  start: number;
  end: number;
  /** How this shot follows the previous one. Ignored on the first shot. */
  transition?: ShotTransition;
  /** The composition at the start of the shot: shot size and who or what is in frame. */
  framing: string;
  moments: VideoMoment[];
}

export interface VideoPromptPlan {
  /** e.g. "Live-action, cinematic" or "2D-animated". */
  style: string;
  speakers: VideoSpeaker[];
  /** One continuous take is one shot; a new shot is a cut to a new angle, place or time. */
  shots: VideoShot[];
  /** Ambience, action sounds and non-verbal human sounds; never dialogue. */
  soundscape: string;
  /** Score only the audience hears: instruments, tempo, dynamics. Leave out for none. */
  music?: string;
}

export const FIRST_FRAME_TOKEN = '<First frame>';
export const LAST_FRAME_TOKEN = '<Last frame>';

export const VIDEO_PLAN_LIMITS = Object.freeze({
  maxShots: 6,
  maxMoments: 6,
  maxSpeakers: 4,
  minShotSeconds: 1,
  maxText: 1200,
  maxShortText: 200,
  maxPrompt: 16000,
});

const TIME_TOLERANCE = 0.05;

type Result<T> = { ok: true; value: T } | { ok: false; error: string };

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function seconds(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Every piece of prose in a plan, for checks that look across all of it. */
function planText(plan: VideoPromptPlan): string {
  return plan.shots.flatMap(shot => [shot.framing, ...shot.moments.flatMap(moment => [moment.action, moment.camera?.target ?? ''])]).join(' ');
}

/**
 * Check a plan against the clip it will be rendered as. Returns a cleaned copy or an error
 * phrased for the assistant to act on.
 */
export function validateVideoPromptPlan(raw: unknown, { duration, hasFirstFrame, hasLastFrame = false }: { duration: number; hasFirstFrame: boolean; hasLastFrame?: boolean }): Result<VideoPromptPlan> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'plan must be an object with style, shots and soundscape.' };
  const source = raw as Record<string, unknown>;
  const style = text(source.style, VIDEO_PLAN_LIMITS.maxShortText);
  if (!style) return { ok: false, error: 'plan.style is required, e.g. "Live-action, cinematic" or "2D-animated".' };
  const soundscape = text(source.soundscape, VIDEO_PLAN_LIMITS.maxText);
  if (!soundscape) return { ok: false, error: 'plan.soundscape is required: 1-4 sentences of ambience, action sounds and breathing. Use "N/A" only for a silent clip.' };

  const rawSpeakers = Array.isArray(source.speakers) ? source.speakers : [];
  if (rawSpeakers.length > VIDEO_PLAN_LIMITS.maxSpeakers) return { ok: false, error: `Use at most ${VIDEO_PLAN_LIMITS.maxSpeakers} speakers.` };
  const speakers: VideoSpeaker[] = [];
  for (const [index, item] of rawSpeakers.entries()) {
    const speaker = object(item);
    const id = text(speaker.id, 8).toUpperCase() || `S${index + 1}`;
    const who = text(speaker.who, VIDEO_PLAN_LIMITS.maxShortText);
    const voice = text(speaker.voice, VIDEO_PLAN_LIMITS.maxShortText);
    if (!/^S\d+$/.test(id) || speakers.some(entry => entry.id === id)) return { ok: false, error: `Speaker ids must be unique, like S1 and S2; "${id}" is not.` };
    if (!who || !voice) return { ok: false, error: `Speaker ${id} needs "who" (e.g. "the young woman") and "voice" (age, pitch, timbre, pace or accent).` };
    speakers.push({ id, who, voice });
  }
  const speakerIds = new Set(speakers.map(speaker => speaker.id));

  const rawShots = Array.isArray(source.shots) ? source.shots : [];
  if (rawShots.length === 0) return { ok: false, error: 'plan.shots needs at least one shot.' };
  if (rawShots.length > VIDEO_PLAN_LIMITS.maxShots) return { ok: false, error: `Use at most ${VIDEO_PLAN_LIMITS.maxShots} shots. A shot is a cut; continuous action belongs in one shot's moments.` };
  const shots: VideoShot[] = [];
  let previousEnd = 0;
  for (const [index, item] of rawShots.entries()) {
    const shot = object(item);
    const label = `Shot ${index + 1}`;
    const start = seconds(shot.start);
    const end = seconds(shot.end);
    if (start === null || end === null) return { ok: false, error: `${label} needs numeric start and end times in seconds.` };
    if (Math.abs(start - previousEnd) > TIME_TOLERANCE) {
      return { ok: false, error: index === 0 ? 'Shot 1 must start at 0.' : `${label} must start at ${previousEnd}, where Shot ${index} ends. Shots may not overlap or leave gaps.` };
    }
    if (end - start < VIDEO_PLAN_LIMITS.minShotSeconds) return { ok: false, error: `${label} is shorter than ${VIDEO_PLAN_LIMITS.minShotSeconds} second. Merge it into the shot before it.` };
    if (end > duration + TIME_TOLERANCE) return { ok: false, error: `${label} ends at ${end}s, after the ${duration}-second clip ends.` };
    const framing = text(shot.framing, VIDEO_PLAN_LIMITS.maxText);
    if (!framing) return { ok: false, error: `${label} needs framing: the shot size and who or what is in frame, e.g. "a medium-wide shot frames the baker behind the counter".` };
    const transition = SHOT_TRANSITIONS.includes(shot.transition as ShotTransition) ? shot.transition as ShotTransition : 'cut';
    const rawMoments = Array.isArray(shot.moments) ? shot.moments : [];
    if (rawMoments.length === 0) return { ok: false, error: `${label} needs at least one moment.` };
    if (rawMoments.length > VIDEO_PLAN_LIMITS.maxMoments) return { ok: false, error: `${label} has more than ${VIDEO_PLAN_LIMITS.maxMoments} moments.` };
    const moments: VideoMoment[] = [];
    for (const [momentIndex, value] of rawMoments.entries()) {
      const moment = object(value);
      const where = `${label}, moment ${momentIndex + 1}`;
      const action = text(moment.action, VIDEO_PLAN_LIMITS.maxText);
      if (!action) return { ok: false, error: `${where} needs an action.` };
      const cleaned: VideoMoment = { action };
      if (moment.camera !== undefined) {
        const camera = object(moment.camera);
        if (!CAMERA_MOVES.includes(camera.move as CameraMove)) return { ok: false, error: `${where}: camera.move must be one of ${CAMERA_MOVES.join(', ')}.` };
        const amplitude = camera.amplitude === 'small' || camera.amplitude === 'large' ? camera.amplitude : undefined;
        const speed = camera.speed === 'slow' || camera.speed === 'fast' ? camera.speed : undefined;
        const target = text(camera.target, VIDEO_PLAN_LIMITS.maxShortText);
        cleaned.camera = { move: camera.move as CameraMove, ...(amplitude ? { amplitude } : {}), ...(speed ? { speed } : {}), ...(target ? { target } : {}) };
      }
      if (moment.dialogue !== undefined) {
        const dialogue = object(moment.dialogue);
        const line = text(dialogue.line, VIDEO_PLAN_LIMITS.maxText);
        const language = text(dialogue.language, 40);
        const speaker = text(dialogue.speaker, 8).toUpperCase();
        if (!line) return { ok: false, error: `${where}: dialogue needs the exact line.` };
        if (!language) return { ok: false, error: `${where}: dialogue needs a language, for example "English".` };
        if (!speakerIds.has(speaker)) return { ok: false, error: `${where}: dialogue speaker "${speaker}" is not in plan.speakers.` };
        const delivery = text(dialogue.delivery, VIDEO_PLAN_LIMITS.maxShortText);
        cleaned.dialogue = { speaker, language, line, ...(delivery ? { delivery } : {}), ...(dialogue.voiceover === true ? { voiceover: true } : {}) };
      }
      const sound = text(moment.sound, VIDEO_PLAN_LIMITS.maxShortText);
      if (sound) cleaned.sound = sound;
      if (moment.text !== undefined) {
        const visible = object(moment.text);
        const content = typeof visible.content === 'string' ? visible.content.trim().slice(0, VIDEO_PLAN_LIMITS.maxShortText) : '';
        const on = text(visible.on, VIDEO_PLAN_LIMITS.maxShortText);
        if (content && on) cleaned.text = { content, on };
      }
      moments.push(cleaned);
    }
    shots.push({ start, end, ...(index > 0 ? { transition } : {}), framing, moments });
    previousEnd = end;
  }
  if (Math.abs(previousEnd - duration) > TIME_TOLERANCE) return { ok: false, error: `The last shot ends at ${previousEnd}s, but the clip is ${duration} seconds. The shots must cover the whole clip.` };
  shots[shots.length - 1].end = duration;

  const plan: VideoPromptPlan = { style, speakers, shots, soundscape };
  const music = text(source.music, VIDEO_PLAN_LIMITS.maxText);
  if (music && music.toUpperCase() !== 'N/A') plan.music = music;

  // Keyframes are anchored by name, so the model has to say where the image appears.
  const prose = planText(plan);
  if (hasFirstFrame && !shots[0].framing.includes(FIRST_FRAME_TOKEN) && !shots[0].moments.some(moment => moment.action.includes(FIRST_FRAME_TOKEN))) {
    return { ok: false, error: `The clip starts from the first frame image. Shot 1's framing must anchor it by writing ${FIRST_FRAME_TOKEN}, e.g. "the young woman shown in ${FIRST_FRAME_TOKEN} sits by the window, preserving her appearance and clothing".` };
  }
  if (!hasFirstFrame && prose.includes(FIRST_FRAME_TOKEN)) return { ok: false, error: `There is no first frame image; do not write ${FIRST_FRAME_TOKEN}.` };
  const lastShot = shots[shots.length - 1];
  if (hasLastFrame && ![lastShot.framing, ...lastShot.moments.map(moment => moment.action)].some(value => value.includes(LAST_FRAME_TOKEN))) {
    return { ok: false, error: `The clip ends on the last frame image. The last shot must land on it by writing ${LAST_FRAME_TOKEN}, e.g. "settles into the pose and composition established by ${LAST_FRAME_TOKEN} at the end of the shot".` };
  }
  if (!hasLastFrame && prose.includes(LAST_FRAME_TOKEN)) return { ok: false, error: `There is no last frame image; do not write ${LAST_FRAME_TOKEN}.` };
  return { ok: true, value: plan };
}

/** True for a plan saved before the base-mode format (subjects and per-beat shots). */
export function isLegacyVideoPlan(plan: unknown): boolean {
  const shots = object(plan).shots;
  return Array.isArray(shots) && shots.some(shot => !Array.isArray(object(shot).moments));
}

export function formatVideoTimestamp(value: number): string {
  const totalMs = Math.max(0, Math.round(value * 1000));
  const minutes = Math.floor(totalMs / 60000);
  const secs = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

export function cameraLabel(camera: VideoCamera): string {
  return [CAMERA_PHRASES[camera.move].label, camera.amplitude ? `${camera.amplitude} amplitude` : null, camera.speed ? `${camera.speed}` : null].filter(Boolean).join(' · ');
}

function sentence(value: string): string {
  const trimmed = value.trim();
  return !trimmed || /[.!?…]["”')\]]?$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function upper(value: string): string {
  return value ? `${value.charAt(0).toUpperCase()}${value.slice(1)}` : value;
}

/** Lowercase a leading article or pronoun, so a phrase can follow "Live-action, cinematic,". Names stay. */
function lower(value: string): string {
  return /^(?:A|An|The|Her|His|Their|Its|Our|My|Two|Three)\b/.test(value) ? `${value.charAt(0).toLowerCase()}${value.slice(1)}` : value;
}

function cameraSentence(camera: VideoCamera): string {
  const parts = [`The camera ${CAMERA_PHRASES[camera.move].phrase}`];
  if (camera.amplitude) parts.push(`with ${camera.amplitude} amplitude`);
  if (camera.speed) parts.push(`at ${camera.speed} speed`);
  if (camera.target) parts.push(camera.target);
  return sentence(parts.join(' '));
}

type KeyframeMode = 'T2VA' | 'I2VA' | 'FL2VA' | 'L2VA';

function keyframeMode(hasFirstFrame: boolean, hasLastFrame: boolean): KeyframeMode {
  if (hasFirstFrame && hasLastFrame) return 'FL2VA';
  if (hasFirstFrame) return 'I2VA';
  if (hasLastFrame) return 'L2VA';
  return 'T2VA';
}

/** The fixed first line MiniMax's guide gives each keyframe mode, or null for text only. */
function keyframeInstruction(mode: KeyframeMode, lastShot: number, effectiveSeconds: string): string | null {
  if (mode === 'I2VA') return 'For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.';
  if (mode === 'FL2VA') return `How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot ${lastShot}) aligns with the ${effectiveSeconds}-second mark of the target video.`;
  if (mode === 'L2VA') return `How the reference pictures align with the target video — <Picture 1> (from [Shot ${lastShot}]) aligns with the ${effectiveSeconds}-second mark of the target video.`;
  return null;
}

/** How each mode names its keyframes in the body, following the guide's examples. */
function keyframeNames(mode: KeyframeMode): { first: string; last: string } {
  if (mode === 'FL2VA') return { first: 'Picture 1', last: 'Picture 2' };
  if (mode === 'L2VA') return { first: 'the first frame', last: '<Picture 1>' };
  return { first: '<Picture 1>', last: 'the last frame' };
}

function withKeyframes(value: string, names: { first: string; last: string }): string {
  return value.replaceAll(FIRST_FRAME_TOKEN, names.first).replaceAll(LAST_FRAME_TOKEN, names.last);
}

function dialogueSentence(dialogue: VideoDialogue, speakers: VideoSpeaker[], introduced: Set<string>, tagged: boolean): string {
  const speaker = speakers.find(entry => entry.id === dialogue.speaker);
  const first = !introduced.has(dialogue.speaker);
  introduced.add(dialogue.speaker);
  const who = speaker ? (first ? `${speaker.who} with ${speaker.voice.replace(/^(?:a|an|with)\s+/i, 'a ')}` : speaker.who) : 'someone';
  if (!tagged) {
    return sentence(`${upper(who)} ${dialogue.voiceover ? 'says in voiceover' : 'says'}${dialogue.delivery ? ` ${dialogue.delivery}` : ''}, in ${dialogue.language}, "${dialogue.line}"`);
  }
  const verb = dialogue.voiceover ? 'says in an off-screen voiceover' : `says${dialogue.delivery ? ` ${dialogue.delivery}` : ''}`;
  const closed = dialogue.voiceover ? ` while ${speaker?.who ?? 'the speaker'}'s lips remain completely closed.` : '';
  return `${upper(who)} (${dialogue.speaker}) ${verb}: <d>[${dialogue.language}] ${dialogue.line}</d>${closed}`;
}

function momentText(moment: VideoMoment, speakers: VideoSpeaker[], introduced: Set<string>, tagged: boolean, names: { first: string; last: string }): string {
  return [
    sentence(upper(withKeyframes(moment.action, names))),
    moment.camera ? cameraSentence(moment.camera) : '',
    moment.text ? sentence(`${upper(moment.text.on)} reads "${moment.text.content}"`) : '',
    moment.sound ? sentence(upper(withKeyframes(moment.sound, names))) : '',
    moment.dialogue ? dialogueSentence(moment.dialogue, speakers, introduced, tagged) : '',
  ].filter(Boolean).join(' ');
}

/** Speakers renumbered in order of who speaks first, as MiniMax assigns speaker IDs. */
function speakersInOrder(plan: VideoPromptPlan): VideoPromptPlan {
  const order: string[] = [];
  for (const shot of plan.shots) for (const moment of shot.moments) if (moment.dialogue && !order.includes(moment.dialogue.speaker)) order.push(moment.dialogue.speaker);
  const map = new Map(order.map((id, index) => [id, `S${index + 1}`]));
  return {
    ...plan,
    speakers: plan.speakers.filter(speaker => map.has(speaker.id)).map(speaker => ({ ...speaker, id: map.get(speaker.id)! })),
    shots: plan.shots.map(shot => ({ ...shot, moments: shot.moments.map(moment => moment.dialogue ? { ...moment, dialogue: { ...moment.dialogue, speaker: map.get(moment.dialogue.speaker)! } } : moment) })),
  };
}

function h3Prompt(source: VideoPromptPlan, duration: number, hasFirstFrame: boolean, hasLastFrame: boolean): string {
  const plan = speakersInOrder(source);
  const mode = keyframeMode(hasFirstFrame, hasLastFrame);
  const names = keyframeNames(mode);
  const effective = (h3FrameCount(duration) / 24).toFixed(2);
  const introduced = new Set<string>();
  const shots = plan.shots.map((shot, index) => {
    const framing = withKeyframes(shot.framing, names);
    const lead = index === 0
      ? `[Shot 1] ${plan.style.replace(/[.,;\s]+$/, '')}, ${lower(framing)}`
      : `[Shot ${index + 1}] At ${formatVideoTimestamp(shot.start)}, ${TRANSITION_PHRASES[shot.transition ?? 'cut']} ${lower(framing)}`;
    const body = shot.moments.map(moment => momentText(moment, plan.speakers, introduced, true, names)).join(' ');
    return `${sentence(lead)} ${body}`.trim();
  });
  const instruction = keyframeInstruction(mode, plan.shots.length, effective);
  return [
    ...(instruction ? [instruction, ''] : []),
    `integrated_multimodal_description: ${shots.join(' ')}`,
    '',
    `overall_soundscape: ${plan.soundscape.toUpperCase() === 'N/A' ? 'N/A' : sentence(upper(plan.soundscape))}`,
    '',
    `non_diegetic_music: ${plan.music ? sentence(upper(plan.music)) : 'N/A'}`,
  ].join('\n');
}

function ltxPrompt(source: VideoPromptPlan, hasFirstFrame: boolean): string {
  const plan = speakersInOrder(source);
  const names = { first: 'the first frame', last: 'the last frame' };
  const introduced = new Set<string>();
  const parts: string[] = [sentence(upper(plan.style))];
  if (hasFirstFrame) parts.push('The scene begins exactly as in the first frame.');
  for (const [index, shot] of plan.shots.entries()) {
    const framing = withKeyframes(shot.framing, names);
    parts.push(index === 0 ? sentence(upper(framing)) : sentence(`Then the shot cuts to ${lower(framing)}`));
    for (const moment of shot.moments) parts.push(momentText(moment, plan.speakers, introduced, false, names));
  }
  if (plan.soundscape.toUpperCase() !== 'N/A') parts.push(`Audio: ${sentence(plan.soundscape)}`);
  if (plan.music) parts.push(`Music: ${sentence(plan.music)}`);
  return parts.join(' ');
}

/** The prompt text the video model receives for this plan. */
export function videoPromptFromPlan(plan: VideoPromptPlan, { family, duration, hasFirstFrame, hasLastFrame = false }: { family: VideoPromptFamily; duration: number; hasFirstFrame: boolean; hasLastFrame?: boolean }): string {
  const prompt = family === 'ltx25' ? ltxPrompt(plan, hasFirstFrame) : h3Prompt(plan, duration, hasFirstFrame, hasLastFrame);
  return prompt.slice(0, VIDEO_PLAN_LIMITS.maxPrompt);
}

/**
 * The plan adjusted for the frames a clip actually has, when the user picks or removes a
 * frame after the plan was written. A new last frame gets a landing moment, a new first
 * frame an anchor, and references to a frame that is gone are reworded.
 */
export function planForFrames(plan: VideoPromptPlan, { hasFirstFrame, hasLastFrame }: { hasFirstFrame: boolean; hasLastFrame: boolean }): VideoPromptPlan {
  const reword = (value: string) => value
    .replaceAll(FIRST_FRAME_TOKEN, hasFirstFrame ? FIRST_FRAME_TOKEN : 'the opening image')
    .replaceAll(LAST_FRAME_TOKEN, hasLastFrame ? LAST_FRAME_TOKEN : 'the final pose');
  const shots = plan.shots.map(shot => ({ ...shot, framing: reword(shot.framing), moments: shot.moments.map(moment => ({ ...moment, action: reword(moment.action), ...(moment.sound ? { sound: reword(moment.sound) } : {}) })) }));
  const first = shots[0];
  if (hasFirstFrame && !first.framing.includes(FIRST_FRAME_TOKEN) && !first.moments.some(moment => moment.action.includes(FIRST_FRAME_TOKEN))) {
    first.framing = `${first.framing.replace(/[.\s]+$/, '')}, starting exactly from the composition of ${FIRST_FRAME_TOKEN}`;
  }
  const last = shots[shots.length - 1];
  if (hasLastFrame && ![last.framing, ...last.moments.map(moment => moment.action)].some(value => value.includes(LAST_FRAME_TOKEN))) {
    if (last.moments.length >= VIDEO_PLAN_LIMITS.maxMoments) last.moments = last.moments.slice(0, VIDEO_PLAN_LIMITS.maxMoments - 1);
    last.moments = [...last.moments, { action: `The scene settles into the pose, spacing and composition established by ${LAST_FRAME_TOKEN} at the end of the shot` }];
  }
  return { ...plan, shots };
}

// --- the timeline: lanes, compiled into a plan ---------------------------------------------------

/** A keyframe: an owned picture (server/agentVideo.ts sources), `prepared` when the browser already cropped it to the clip's size. */
export type Keyframe = { sourceId: string; name: string; width: number; height: number; prepared: boolean }
export type ShotItem = { id: string; start: number; framing: string; transition?: ShotTransition }
type Timed = { id: string; at: number; end?: number }
export type ActionItem = Timed & { text: string }
export type CameraItem = Timed & VideoCamera
export type SpeechItem = Timed & VideoDialogue
export type SoundItem = Timed & { text: string }
export type TextItem = Timed & { content: string; on: string }
export type Lanes = { shots: ShotItem[]; action: ActionItem[]; camera: CameraItem[]; speech: SpeechItem[]; sound: SoundItem[]; text: TextItem[] }
export type LaneKind = keyof Lanes
export const LANE_KINDS: readonly LaneKind[] = ['shots', 'action', 'camera', 'speech', 'sound', 'text']
export const LANE_LABEL: Record<LaneKind, string> = { shots: 'Shots', action: 'Action', camera: 'Camera', speech: 'Speech', sound: 'Sound', text: 'Text' }

/** One generation: v1 renders exactly one segment; longer timelines chain segments later. */
export type Segment = { id: string; duration: number; firstFrame: Keyframe | null; lastFrame: Keyframe | null; seed: number; turbo: boolean; lanes: Lanes }
export type VideoProject = {
  version: 1
  title: string
  family: VideoPromptFamily
  width: number
  height: number
  style: string
  speakers: VideoSpeaker[]
  segments: Segment[]
  soundscape: string
  music: string
  /** "Edit as text": the prompt written by hand, the lanes no longer used. Null: compiled from the lanes. */
  rawPrompt: string | null
}

export const PROJECT_LIMITS = Object.freeze({ title: 120, itemsPerLane: 40, rawPrompt: VIDEO_PLAN_LIMITS.maxPrompt, segments: 1 })

const newId = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`).replace(/-/g, '').slice(0, 10)
export const itemId = newId

export const emptyLanes = (): Lanes => ({ shots: [], action: [], camera: [], speech: [], sound: [], text: [] })

export function defaultProject(family: VideoPromptFamily = 'minimax_h3'): VideoProject {
  return {
    version: 1,
    title: 'Untitled video',
    family,
    width: family === 'ltx25' ? 1280 : 1344,
    height: family === 'ltx25' ? 704 : 768,
    style: 'Live-action, cinematic',
    speakers: [],
    segments: [{ id: newId(), duration: family === 'ltx25' ? 5 : 10, firstFrame: null, lastFrame: null, seed: -1, turbo: false, lanes: emptyLanes() }],
    soundscape: '',
    music: '',
    rawPrompt: null,
  }
}

const num = (v: unknown, min: number, max: number, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v * 1000) / 1000)) : fallback)
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').slice(0, max) : '')
const list = (v: unknown) => (Array.isArray(v) ? v.slice(0, PROJECT_LIMITS.itemsPerLane) : [])
const SOURCE_ID = /^[0-9a-f-]{36}$/

function keyframe(v: unknown): Keyframe | null {
  const k = object(v)
  if (typeof k.sourceId !== 'string' || !SOURCE_ID.test(k.sourceId)) return null
  return { sourceId: k.sourceId, name: str(k.name, 200) || 'picture', width: num(k.width, 1, 100_000, 0), height: num(k.height, 1, 100_000, 0), prepared: k.prepared === true }
}

/**
 * A project as stored or sent, cleaned: unknown fields dropped, texts and counts bounded, times
 * inside the segment. Never throws; what a render still needs is checked by compileProject.
 */
export function normalizeProject(raw: unknown): VideoProject {
  const p = object(raw)
  const family: VideoPromptFamily = p.family === 'ltx25' ? 'ltx25' : 'minimax_h3'
  const base = defaultProject(family)
  const rawSegments = Array.isArray(p.segments) && p.segments.length ? p.segments.slice(0, PROJECT_LIMITS.segments) : base.segments
  const segments = rawSegments.map((s0): Segment => {
    const s = object(s0)
    const duration = num(s.duration, 1, 15, base.segments[0].duration)
    const l = object(s.lanes)
    const at = (v: unknown) => num(v, 0, duration, 0)
    const end = (v: unknown, from: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(duration, Math.max(from, Math.round(v * 1000) / 1000)) : undefined)
    const timed = (o: Record<string, unknown>): Timed => {
      const a = at(o.at)
      const e = end(o.end, a)
      return { id: typeof o.id === 'string' && /^[\w-]{1,40}$/.test(o.id) ? o.id : newId(), at: a, ...(e !== undefined && e > a ? { end: e } : {}) }
    }
    const lanes: Lanes = {
      shots: list(l.shots).map((v) => object(v)).map((o) => ({ id: typeof o.id === 'string' && /^[\w-]{1,40}$/.test(o.id) ? o.id : newId(), start: at(o.start), framing: str(o.framing, VIDEO_PLAN_LIMITS.maxText), ...(SHOT_TRANSITIONS.includes(o.transition as ShotTransition) ? { transition: o.transition as ShotTransition } : {}) })),
      action: list(l.action).map((v) => object(v)).map((o) => ({ ...timed(o), text: str(o.text, VIDEO_PLAN_LIMITS.maxText) })),
      camera: list(l.camera).map((v) => object(v)).filter((o) => CAMERA_MOVES.includes(o.move as CameraMove)).map((o) => ({
        ...timed(o), move: o.move as CameraMove,
        ...(o.amplitude === 'small' || o.amplitude === 'large' ? { amplitude: o.amplitude } : {}),
        ...(o.speed === 'slow' || o.speed === 'fast' ? { speed: o.speed } : {}),
        ...(str(o.target, VIDEO_PLAN_LIMITS.maxShortText) ? { target: str(o.target, VIDEO_PLAN_LIMITS.maxShortText) } : {}),
      })),
      speech: list(l.speech).map((v) => object(v)).map((o) => ({
        ...timed(o), speaker: str(o.speaker, 8).toUpperCase(), language: str(o.language, 40) || 'English', line: str(o.line, VIDEO_PLAN_LIMITS.maxText),
        ...(str(o.delivery, VIDEO_PLAN_LIMITS.maxShortText) ? { delivery: str(o.delivery, VIDEO_PLAN_LIMITS.maxShortText) } : {}),
        ...(o.voiceover === true ? { voiceover: true } : {}),
      })),
      sound: list(l.sound).map((v) => object(v)).map((o) => ({ ...timed(o), text: str(o.text, VIDEO_PLAN_LIMITS.maxShortText) })),
      text: list(l.text).map((v) => object(v)).map((o) => ({ ...timed(o), content: str(o.content, VIDEO_PLAN_LIMITS.maxShortText), on: str(o.on, VIDEO_PLAN_LIMITS.maxShortText) })),
    }
    const seed = typeof s.seed === 'number' && Number.isSafeInteger(s.seed) && s.seed >= -1 ? s.seed : -1
    return { id: typeof s.id === 'string' && /^[\w-]{1,40}$/.test(s.id) ? s.id : newId(), duration, firstFrame: keyframe(s.firstFrame), lastFrame: family === 'ltx25' ? null : keyframe(s.lastFrame), seed, turbo: family === 'minimax_h3' && s.turbo === true, lanes }
  })
  const speakers = list(p.speakers).slice(0, VIDEO_PLAN_LIMITS.maxSpeakers).map((v, i) => {
    const o = object(v)
    const id = str(o.id, 8).toUpperCase()
    return { id: /^S\d+$/.test(id) ? id : `S${i + 1}`, who: str(o.who, VIDEO_PLAN_LIMITS.maxShortText), voice: str(o.voice, VIDEO_PLAN_LIMITS.maxShortText) }
  })
  const dims = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isInteger(v) && v >= 32 && v <= 16384 ? v : fallback)
  return {
    version: 1,
    title: str(p.title, PROJECT_LIMITS.title).trim() || base.title,
    family,
    width: dims(p.width, base.width),
    height: dims(p.height, base.height),
    style: str(p.style, VIDEO_PLAN_LIMITS.maxShortText) || base.style,
    speakers,
    segments,
    soundscape: str(p.soundscape, VIDEO_PLAN_LIMITS.maxText),
    music: str(p.music, VIDEO_PLAN_LIMITS.maxText),
    rawPrompt: typeof p.rawPrompt === 'string' ? p.rawPrompt.slice(0, PROJECT_LIMITS.rawPrompt) : null,
  }
}

/**
 * How much control an item gives, said plainly on it: Real (the model takes it as an input),
 * Timed (written with a timestamp the model follows), Ordered (only its order within the shot
 * reaches the model), Hint (prompt words the model may follow), Off (not used by this model).
 */
export type Badge = 'Real' | 'Timed' | 'Ordered' | 'Hint' | 'Off'
export const BADGE_NOTE: Record<Badge, string> = {
  Real: 'A real input: the model is conditioned on it',
  Timed: 'Written with its timestamp: the model cuts close to it',
  Ordered: 'Only its order within the shot reaches the model; its exact time does not',
  Hint: 'Prompt words: the model may follow them',
  Off: 'This model does not use it',
}
export function laneBadge(family: VideoPromptFamily, lane: LaneKind | 'keyframe' | 'lastFrame' | 'bed'): Badge {
  if (lane === 'keyframe') return 'Real'
  if (lane === 'lastFrame') return family === 'ltx25' ? 'Off' : 'Real'
  if (lane === 'shots') return family === 'ltx25' ? 'Ordered' : 'Timed'
  if (lane === 'text' || lane === 'bed') return 'Hint'
  return 'Ordered'
}

/** "no smoke", "don't show", "without people": naming a thing to a CFG-1 video model adds it. */
const NEGATIVE = /\b(no|not|don't|do not|never|without)\s+\w+/i

export type Compiled = {
  /** The plan the model gets, or null when the lanes cannot make one yet (see problems). */
  plan: VideoPromptPlan | null
  prompt: string
  /** What stops a render, phrased for the person (or an agent) to fix. */
  problems: string[]
  /** What renders, but not as the timeline suggests (an item crossing a cut, merged moments, negative phrasing). */
  warnings: string[]
  /** Per item id: the shot it lands in (index) and its badge. */
  items: Record<string, { shot: number; badge: Badge; note?: string }>
  /** The clip's real length in seconds (H3 rounds its frames up). */
  duration: number
}

/** The shots as they tile the segment: sorted starts, the first at 0, each ending where the next starts. */
export function tiledShots(lanes: Lanes, duration: number): { id: string; start: number; end: number; framing: string; transition?: ShotTransition }[] {
  const sorted = [...lanes.shots].filter((s) => s.start < duration).sort((a, b) => a.start - b.start)
  if (!sorted.length) return [{ id: 'shot-all', start: 0, end: duration, framing: '' }]
  sorted[0] = { ...sorted[0], start: 0 }
  return sorted.map((s, i) => ({ ...s, end: i + 1 < sorted.length ? sorted[i + 1].start : duration }))
}

/**
 * The lanes of one segment, as the plan and prompt the model gets. Items fall in the shot that
 * holds their start; inside a shot they are put in order and grouped into moments: each action
 * starts one, and camera, speech, sound and text join the action before them (a moment with no
 * action of its own gets "The scene continues"). Keyframes are anchored with their tokens. The
 * plan is then checked like an agent's (validateVideoPromptPlan), so both paths meet one rule set.
 */
export function compileProject(project: VideoProject, segmentIndex = 0): Compiled {
  const seg = project.segments[segmentIndex]
  const problems: string[] = [], warnings: string[] = []
  const items: Compiled['items'] = {}
  const duration = seg?.duration ?? 0
  if (!seg) return { plan: null, prompt: '', problems: ['The project has no segment.'], warnings, items, duration }
  const hasFirstFrame = !!seg.firstFrame
  const hasLastFrame = project.family === 'minimax_h3' && !!seg.lastFrame
  const lanes = seg.lanes
  let shots = tiledShots(lanes, duration)
  // Shots shorter than a second merge into the one before (the model needs a second per cut).
  const merged: typeof shots = []
  for (const s of shots) {
    const prev = merged.at(-1)
    if (prev && s.end - s.start < VIDEO_PLAN_LIMITS.minShotSeconds) {
      prev.end = s.end
      warnings.push(`A shot at ${s.start.toFixed(2)} s is shorter than a second: it merges into the shot before.`)
    } else merged.push({ ...s })
  }
  if (merged.length > 1 && merged[0].end - merged[0].start < VIDEO_PLAN_LIMITS.minShotSeconds) {
    merged[1] = { ...merged[1], start: 0 }
    merged.shift()
    warnings.push('The first shot is shorter than a second: it merges into the next.')
  }
  shots = merged.slice(0, VIDEO_PLAN_LIMITS.maxShots)
  if (merged.length > VIDEO_PLAN_LIMITS.maxShots) {
    shots[shots.length - 1].end = duration
    problems.push(`At most ${VIDEO_PLAN_LIMITS.maxShots} shots: remove ${merged.length - VIDEO_PLAN_LIMITS.maxShots}.`)
  }
  const shotAt = (t: number) => {
    let i = 0
    for (let k = 0; k < shots.length; k++) if (shots[k].start <= t + 1e-6) i = k
    return i
  }
  const shotBadge = laneBadge(project.family, 'shots')
  for (const s of lanes.shots) items[s.id] = { shot: shotAt(s.start), badge: shotBadge }

  type Entry = { kind: Exclude<LaneKind, 'shots'>; at: number; item: Timed & Record<string, unknown> }
  const order: Record<Entry['kind'], number> = { action: 0, camera: 1, speech: 2, sound: 3, text: 4 }
  const entries: Entry[] = []
  for (const kind of ['action', 'camera', 'speech', 'sound', 'text'] as const) {
    for (const item of lanes[kind] as (Timed & Record<string, unknown>)[]) {
      const shot = shotAt(item.at)
      const badge = laneBadge(project.family, kind)
      const crosses = item.end !== undefined && item.end > shots[shot].end + 0.05
      items[item.id] = { shot, badge, ...(crosses ? { note: 'Crosses a cut: it ends with its shot' } : {}) }
      if (crosses) warnings.push(`${LANE_LABEL[kind]} at ${item.at.toFixed(2)} s crosses the cut at ${shots[shot].end.toFixed(2)} s: it ends with its shot.`)
      entries.push({ kind, at: item.at, item })
    }
  }
  const speakerIds = new Set(project.speakers.map((s) => s.id))
  const planShots: VideoShot[] = shots.map((s, index) => {
    const mine = entries.filter((e) => shotAt(e.at) === index).sort((a, b) => a.at - b.at || order[a.kind] - order[b.kind])
    const moments: VideoMoment[] = []
    const fresh = () => (moments.push({ action: 'The scene continues' }), moments.at(-1)!)
    // Camera, speech, sound and text join the action before them; the ones before the shot's first
    // action join that action (a filler moment only when the shot has no action at all).
    const join = (kind: Entry['kind'], item: Entry['item']) => {
      let m = moments.at(-1) ?? fresh()
      if (kind === 'camera') {
        if (m.camera) m = fresh()
        const c = item as unknown as CameraItem
        m.camera = { move: c.move, ...(c.amplitude ? { amplitude: c.amplitude } : {}), ...(c.speed ? { speed: c.speed } : {}), ...(c.target ? { target: c.target } : {}) }
      } else if (kind === 'speech') {
        const d = item as unknown as SpeechItem
        if (!d.line.trim()) return
        if (!speakerIds.has(d.speaker)) problems.push(`A line at ${d.at.toFixed(2)} s is said by ${d.speaker || 'nobody'}: add that speaker, or pick one.`)
        if (m.dialogue) m = fresh()
        m.dialogue = { speaker: d.speaker, language: d.language || 'English', line: d.line.trim(), ...(d.delivery ? { delivery: d.delivery } : {}), ...(d.voiceover ? { voiceover: true } : {}) }
      } else if (kind === 'sound') {
        const text = String(item.text ?? '').trim()
        if (text) m.sound = m.sound ? `${m.sound.replace(/[.\s]+$/, '')}, then ${text}` : text
      } else if (kind === 'text') {
        const t = item as unknown as TextItem
        if (!t.content.trim() || !t.on.trim()) return
        if (m.text) m = fresh()
        m.text = { content: t.content.trim(), on: t.on.trim() }
      }
    }
    const before: Entry[] = []
    for (const e of mine) {
      if (e.kind !== 'action') {
        if (moments.length) join(e.kind, e.item)
        else before.push(e)
        continue
      }
      const text = String(e.item.text ?? '').trim()
      if (!text) continue
      if (NEGATIVE.test(text)) warnings.push(`"${text.slice(0, 40)}": naming something tells the model to show it. Describe what is there instead.`)
      moments.push({ action: text })
      if (moments.length === 1) for (const b of before.splice(0)) join(b.kind, b.item)
    }
    for (const b of before) join(b.kind, b.item)
    if (!moments.length) moments.push({ action: index === 0 ? 'The scene holds, with natural motion' : 'The scene continues' })
    while (moments.length > VIDEO_PLAN_LIMITS.maxMoments) {
      const extra = moments.pop()!
      const last = moments.at(-1)!
      last.action = `${last.action.replace(/[.\s]+$/, '')}, then ${extra.action.charAt(0).toLowerCase()}${extra.action.slice(1)}`
      warnings.push(`Shot ${index + 1} has more than ${VIDEO_PLAN_LIMITS.maxMoments} moments: the last ones merge.`)
    }
    const framing = s.framing.trim() || (index === 0 ? (hasFirstFrame ? `the scene shown in ${FIRST_FRAME_TOKEN}, preserving its subjects, their appearance and the setting` : 'the scene') : 'a new angle on the scene')
    return { start: s.start, end: s.end, ...(index > 0 ? { transition: s.transition ?? 'cut' } : {}), framing, moments }
  })
  const draft: VideoPromptPlan = { style: project.style.trim() || 'Live-action, cinematic', speakers: project.speakers.filter((s) => s.who && s.voice), shots: planShots, soundscape: project.soundscape.trim() || 'Natural ambient sound that matches the scene.', ...(project.music.trim() ? { music: project.music.trim() } : {}) }
  for (const s of project.speakers) if (!s.who || !s.voice) problems.push(`Speaker ${s.id} needs who it is and how the voice sounds.`)
  const anchored = planForFrames(draft, { hasFirstFrame, hasLastFrame })
  if (project.rawPrompt !== null) {
    const prompt = project.rawPrompt.trim()
    if (!prompt) problems.push('The prompt is empty: write it, or go back to the timeline.')
    return { plan: null, prompt, problems, warnings: ['The prompt is written by hand: the lanes are not used.', ...warnings], items, duration }
  }
  const checked = validateVideoPromptPlan(anchored, { duration, hasFirstFrame, hasLastFrame })
  if (!checked.ok) {
    problems.push(checked.error)
    return { plan: null, prompt: '', problems, warnings, items, duration }
  }
  const prompt = videoPromptFromPlan(checked.value, { family: project.family, duration, hasFirstFrame, hasLastFrame })
  return { plan: checked.value, prompt, problems, warnings: [...new Set(warnings)], items, duration }
}

/**
 * An agent's plan (validateVideoPromptPlan's shape) laid out on the lanes, so the Studio opens it
 * as an editable timeline: each shot's moments spread evenly over the shot.
 */
export function lanesFromPlan(plan: VideoPromptPlan): Lanes {
  const lanes = emptyLanes()
  for (const shot of plan.shots) {
    lanes.shots.push({ id: newId(), start: shot.start, framing: shot.framing, ...(shot.transition ? { transition: shot.transition } : {}) })
    const step = (shot.end - shot.start) / shot.moments.length
    shot.moments.forEach((m, i) => {
      const at = Math.round((shot.start + i * step) * 100) / 100
      lanes.action.push({ id: newId(), at, text: m.action })
      if (m.camera) lanes.camera.push({ id: newId(), at, ...m.camera })
      if (m.dialogue) lanes.speech.push({ id: newId(), at, ...m.dialogue })
      if (m.sound) lanes.sound.push({ id: newId(), at, text: m.sound })
      if (m.text) lanes.text.push({ id: newId(), at, ...m.text })
    })
  }
  return lanes
}
