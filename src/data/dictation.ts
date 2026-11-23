import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../os/account'
import { notify } from '../os/notify'

// Speaking into the Agents message box. Where the browser recognises speech itself (Chrome, Edge,
// Safari: the Web Speech API), words appear in the box as they are heard, in the browser's
// language. Where it doesn't (Firefox), and the account has an OpenAI API key for Agents, the
// microphone is recorded and the server has OpenAI write it down (server/agentTranscribe.ts): the
// key never reaches the page. With neither, there is no microphone button.

/** The browser's speech recognition, as far as it is used here (not in every lib.dom). */
type Recognition = {
  lang: string
  continuous: boolean
  interimResults: boolean
  start: () => void
  stop: () => void
  abort: () => void
  onresult: ((e: { results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
}
type RecognitionCtor = new () => Recognition

/** The browser's own speech recognition, if it has one. */
export function speechRecognition(): RecognitionCtor | null {
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

/** The longest recording sent to the server, and its size: the server refuses more (agentTranscribe.ts). */
export const MAX_SECONDS = 120
export const MAX_BYTES = 10 * 1024 * 1024

const canRecord = () => typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia

/** Whether the server can write down a recording for this account (an OpenAI API key), asked once a page. */
let serverAnswer: Promise<boolean> | null = null
function serverDictation(): Promise<boolean> {
  serverAnswer ??= api<{ available: boolean }>('/api/agents/transcribe').then(
    (r) => !!r.available,
    () => ((serverAnswer = null), false),
  )
  return serverAnswer
}

/** Which way dictation works here: the browser's, the server's, or not at all (null while asking). */
export type Dictation = 'browser' | 'server' | 'none'
function useDictationKind(): Dictation | null {
  const [kind, setKind] = useState<Dictation | null>(() => (speechRecognition() ? 'browser' : canRecord() ? null : 'none'))
  useEffect(() => {
    if (kind !== null) return
    let alive = true
    void serverDictation().then((ok) => alive && setKind(ok ? 'server' : 'none'))
    return () => {
      alive = false
    }
  }, [kind])
  return kind
}

const blocked = () =>
  notify({ title: 'Microphone blocked', body: 'Allow this site to use the microphone in the browser (the icon in the address bar), then try again.', transient: true })

const toBase64 = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''))
    r.onerror = () => reject(r.error ?? new Error('Could not read the recording'))
    r.readAsDataURL(blob)
  })

/**
 * Dictation for a message box. `onText(text)` gets everything heard so far in this go (interim
 * words included while the browser listens), to put after what the box held when it started.
 */
export function useDictation(onText: (text: string, final: boolean) => void) {
  const kind = useDictationKind()
  const [state, setState] = useState<'idle' | 'listening' | 'transcribing'>('idle')
  const latest = useRef(onText)
  latest.current = onText
  const stopRef = useRef<(() => void) | null>(null)

  useEffect(() => () => stopRef.current?.(), [])

  const startBrowser = useCallback(() => {
    const Ctor = speechRecognition()
    if (!Ctor) return
    const rec = new Ctor()
    rec.lang = navigator.language || 'en-US'
    rec.continuous = true
    rec.interimResults = true
    let finalText = ''
    rec.onresult = (e) => {
      let done = ''
      let interim = ''
      for (let i = 0; i < e.results.length; i++) {
        const r = e.results[i]
        if (r.isFinal) done += r[0].transcript
        else interim += r[0].transcript
      }
      finalText = done
      latest.current(`${done}${interim}`.trim(), false)
    }
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') blocked()
      else if (e.error === 'network') notify({ title: 'Dictation needs a connection', body: 'The browser could not reach its speech service. Try again when online.', transient: true })
      else if (e.error !== 'no-speech' && e.error !== 'aborted') notify({ title: 'Dictation stopped', body: e.error, transient: true })
    }
    rec.onend = () => {
      stopRef.current = null
      setState('idle')
      latest.current(finalText.trim(), true)
    }
    stopRef.current = () => rec.stop()
    try {
      rec.start()
      setState('listening')
    } catch {
      stopRef.current = null
    }
  }, [])

  const startServer = useCallback(async () => {
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (e) {
      if ((e as Error).name === 'NotAllowedError' || (e as Error).name === 'SecurityError') blocked()
      else notify({ title: 'No microphone', body: 'No microphone was found to record from.', transient: true })
      return
    }
    const chunks: Blob[] = []
    let size = 0
    const rec = new MediaRecorder(stream)
    const timer = setTimeout(() => rec.state === 'recording' && rec.stop(), MAX_SECONDS * 1000)
    rec.ondataavailable = (e) => {
      if (!e.data.size) return
      chunks.push(e.data)
      size += e.data.size
      if (size > MAX_BYTES && rec.state === 'recording') rec.stop()
    }
    rec.onstop = async () => {
      clearTimeout(timer)
      stream.getTracks().forEach((t) => t.stop())
      stopRef.current = null
      const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' })
      if (!blob.size) return setState('idle')
      if (blob.size > MAX_BYTES) {
        notify({ title: 'Recording too long', body: `Dictation takes up to ${MAX_SECONDS / 60} minutes at a time.`, transient: true })
        return setState('idle')
      }
      setState('transcribing')
      try {
        const r = await api<{ text: string }>('/api/agents/transcribe', { method: 'POST', json: { audio: await toBase64(blob), mime: blob.type, language: (navigator.language || '').slice(0, 2).toLowerCase() } })
        latest.current((r.text ?? '').trim(), true)
      } catch (e) {
        notify({ title: 'Could not write it down', body: (e as Error).message, transient: true })
      } finally {
        setState('idle')
      }
    }
    stopRef.current = () => rec.state === 'recording' && rec.stop()
    rec.start(1000)
    setState('listening')
  }, [])

  const toggle = useCallback(() => {
    if (state === 'transcribing') return
    if (state === 'listening') return stopRef.current?.()
    if (kind === 'browser') startBrowser()
    else if (kind === 'server') void startServer()
  }, [state, kind, startBrowser, startServer])

  return { available: kind === 'browser' || kind === 'server', kind, state, toggle }
}
