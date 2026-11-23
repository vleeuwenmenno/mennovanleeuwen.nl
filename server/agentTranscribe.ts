import type { IncomingMessage, ServerResponse } from 'node:http'
import type { User } from './auth.ts'
import { HttpError, json, readJson } from './http.ts'
import { openaiChatAccess as access } from './agentOpenAI.ts'
import { privateFetch as fetch } from './privateRequest.ts'

// Dictation for browsers without speech recognition of their own (Firefox): the page records the
// microphone and sends the recording here; OpenAI's transcription API writes it down with the
// account's own OpenAI API key (Settings → Agents → Images), which never leaves the server. Signed-in
// accounts only, one recording at a time per account, at most MAX_BYTES (about two minutes; the page
// stops recording there too, src/data/dictation.ts). OPENAI_URL points at a stand-in for tests.
//
//   GET  /api/agents/transcribe  { available }: whether this account can dictate this way
//   POST /api/agents/transcribe  { audio: base64, mime, language? } → { text }

const MAX_BYTES = 10 * 1024 * 1024
const MODEL = process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe'
/** The recordings browsers make, and the file name OpenAI wants to see for each. */
const TYPES: Record<string, string> = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'mp4', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav' }
const busy = new Set<number>()

export async function handleTranscribeApi(req: IncomingMessage, res: ServerResponse, method: string, user: User): Promise<boolean> {
  if (method === 'GET' || method === 'HEAD') return json(res, 200, { available: !!access.apiKey(user) }), true
  if (method !== 'POST') return false
  const key = access.apiKey(user)
  if (!key) throw new HttpError(409, 'Dictation here needs an OpenAI API key: add one in Settings → Agents → Images')
  if (busy.has(user.id)) throw new HttpError(429, 'Still writing down the last recording')
  busy.add(user.id)
  try {
    const body = await readJson<{ audio?: unknown; mime?: unknown; language?: unknown }>(req, Math.ceil((MAX_BYTES * 4) / 3) + 4096)
    if (typeof body.audio !== 'string' || !body.audio) throw new HttpError(400, 'No recording')
    const mime = typeof body.mime === 'string' ? body.mime.split(';')[0].trim().toLowerCase() : ''
    const ext = TYPES[mime]
    if (!ext) throw new HttpError(415, 'Unsupported recording type')
    const audio = Buffer.from(body.audio, 'base64')
    if (!audio.length) throw new HttpError(400, 'Empty recording')
    if (audio.length > MAX_BYTES) throw new HttpError(413, 'Recording too long')
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(audio)], { type: mime }), `dictation.${ext}`)
    form.append('model', MODEL)
    if (typeof body.language === 'string' && /^[a-z]{2}$/.test(body.language)) form.append('language', body.language)
    const answer = await fetch(`${access.openaiUrl()}/v1/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(90_000) }).catch(() => {
      throw new HttpError(502, 'OpenAI did not answer')
    })
    if (answer.status === 401 || answer.status === 403) throw new HttpError(409, 'OpenAI refused the API key: set it again in Settings → Agents → Images')
    if (!answer.ok) throw new HttpError(502, `OpenAI could not write it down (${answer.status})`)
    const out = (await answer.json().catch(() => null)) as { text?: unknown } | null
    return json(res, 200, { text: typeof out?.text === 'string' ? out.text.slice(0, 20_000) : '' }), true
  } finally {
    busy.delete(user.id)
  }
}
