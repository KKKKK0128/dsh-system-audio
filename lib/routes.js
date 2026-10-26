/**
 * dsh-system-audio — browser-facing HTTP routes.
 *
 * The host half owns both the WASAPI capture and the local speech model, so the
 * UI reaches them over same-origin JSON instead of a Typert Remote: exact routes
 * on the DSH web server, fetched by the client half. That keeps the plugin free
 * of generated descriptor tables while leaving every privileged step (spawn,
 * model, files) in the host process.
 *
 * Routes (all under /system-audio):
 *   GET  /ping              → liveness + default device
 *   GET  /devices           → playback devices + speech readiness
 *   POST /start             → {seconds?, device?, language?} → {id}
 *   GET  /status?id=…       → {state, elapsed, rms, db, levels}
 *   POST /stop?id=…         → stop, transcribe, {text, …}
 *   POST /cancel?id=…       → stop and discard
 */

import { randomUUID } from 'node:crypto'

import { captureWaveBytes, finishCapture, listDevices, startCaptureAuto } from './recorder.js'
import { DEFAULT_WAIT_MS, ensureReady, speechState, transcribeWav } from './speech.js'

export const WEB_PREFIX = '/system-audio'

const MAX_BODY_BYTES = 64 * 1024
const MAX_SESSIONS = 4
const DEFAULT_SECONDS = 60
const MAX_SECONDS = 300
const MIN_SECONDS = 0.5
const LEVEL_WINDOW = 24

/** Live UI captures, keyed by the opaque id handed to the browser. */
const sessions = new Map()

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function fail(res, status, message) {
  sendJson(res, status, { ok: false, error: message })
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return {}
  const parsed = JSON.parse(text)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('request body must be a JSON object')
  }
  return parsed
}

function pick(params, body, key) {
  const fromBody = body?.[key]
  if (fromBody !== undefined && fromBody !== null && fromBody !== '') return fromBody
  const fromQuery = params.get(key)
  return fromQuery === null || fromQuery === '' ? undefined : fromQuery
}

function seconds(options) {
  const raw = Number(options)
  if (!Number.isFinite(raw)) return DEFAULT_SECONDS
  return Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, raw))
}

function decibels(rms) {
  const value = Number.isFinite(rms) && rms > 0 ? rms : 0
  return value <= 0 ? -120 : 20 * Math.log10(value)
}

function levelSample(event) {
  return {
    t: typeof event?.t === 'number' ? event.t : 0,
    rms: typeof event?.rms === 'number' ? event.rms : 0,
    db: typeof event?.db === 'number' ? event.db : decibels(event?.rms),
  }
}

function newSession(entry) {
  const id = randomUUID()
  entry.id = id
  entry.createdAt = Date.now()
  entry.finished = false
  sessions.set(id, entry)
  void entry.session.settled.then(() => {
    entry.finished = true
  })
  return id
}

function takeSession(params, body) {
  const id = pick(params, body, 'id')
  if (typeof id !== 'string' || id === '') return { error: 'missing capture id' }
  const entry = sessions.get(id)
  if (entry === undefined) return { error: 'unknown capture id' }
  return { entry }
}

function speechFor(ctx) {
  const speech = ctx.get('speechToText')
  if (!speech) {
    throw new Error('no speech-to-text service in this composition (install the voice-input bundle)')
  }
  return speech
}

async function handlePing(ctx, _req, res) {
  let device = ''
  try {
    const devices = await listDevices()
    device = devices.default
  } catch {
    device = ''
  }
  sendJson(res, 200, { ok: true, prefix: WEB_PREFIX, default: device, sessions: sessions.size })
}

async function handleDevices(ctx, _req, res) {
  const devices = await listDevices()
  const speech = ctx.get('speechToText')
  const state = speech
    ? { available: true, ...speechState(speech) }
    : { available: false, providerId: '', phase: 'unavailable', language: '', languages: [] }
  sendJson(res, 200, { ok: true, default: devices.default, devices: devices.devices, speech: state })
}

async function handleStart(ctx, req, res, params, body) {
  if (sessions.size >= MAX_SESSIONS) {
    return fail(res, 429, 'too many captures are already running')
  }
  const wanted = seconds(pick(params, body, 'seconds'))
  const device = pick(params, body, 'device')
  const silenceMs = pick(params, body, 'silenceMs')
  const session = await startCaptureAuto({
    seconds: wanted,
    deviceId: typeof device === 'string' && device !== '' ? device : undefined,
    levels: true,
    // Optional auto-stop: end the capture after the given stretch of silence
    // (the recorder only arms this once it has heard something loud).
    silenceStopMs: typeof silenceMs === 'number' && Number.isFinite(silenceMs) && silenceMs >= 250
      ? Math.min(Math.round(silenceMs), 10000)
      : undefined,
  })
  const language = pick(params, body, 'language')
  const id = newSession({ session, language: typeof language === 'string' ? language : '' })
  sendJson(res, 200, {
    ok: true,
    id,
    seconds: wanted,
    transport: session.stdio,
    rate: 16000,
    channels: 1,
  })
}

async function handleStatus(ctx, req, res, params, body) {
  const found = takeSession(params, body)
  if (found.error !== undefined) return fail(res, 404, found.error)
  const { entry } = found
  const last = entry.session.lastLevel()
  const levels = entry.session.levels.slice(-LEVEL_WINDOW).map(levelSample)
  const elapsed = typeof last?.t === 'number' && last.t > 0
    ? last.t
    : (Date.now() - entry.createdAt) / 1000
  sendJson(res, 200, {
    ok: true,
    state: entry.finished ? 'stopped' : 'recording',
    elapsed,
    rms: typeof last?.rms === 'number' ? last.rms : 0,
    db: typeof last?.db === 'number' ? last.db : decibels(last?.rms),
    levels,
  })
}

async function handleCancel(ctx, req, res, params, body) {
  const found = takeSession(params, body)
  if (found.error !== undefined) return fail(res, 404, found.error)
  const { entry } = found
  sessions.delete(entry.id)
  try {
    await entry.session.stop()
    await finishCapture(entry.session, { keep: true })
  } catch {
    /* the capture was already failing; the caller only wants it gone */
  }
  sendJson(res, 200, { ok: true })
}

async function handleStop(ctx, req, res, params, body) {
  const found = takeSession(params, body)
  if (found.error !== undefined) return fail(res, 404, found.error)
  const { entry } = found
  sessions.delete(entry.id)
  try {
    await entry.session.stop()
    const capture = await finishCapture(entry.session, { keep: true })
    const audio = await captureWaveBytes(capture)
    const speech = speechFor(ctx)
    const ready = await ensureReady(speech, undefined, undefined, DEFAULT_WAIT_MS)
    const language = entry.language !== '' ? entry.language : ready.language
    const transcript = await transcribeWav(speech, audio, { language })
    sendJson(res, 200, {
      ok: true,
      text: transcript.text,
      language: transcript.language !== '' ? transcript.language : ready.language,
      providerId: ready.providerId,
      audioSeconds: transcript.audioSeconds > 0 ? transcript.audioSeconds : capture.seconds,
      inferenceSeconds: transcript.inferenceSeconds,
      rms: capture.rms,
      peak: capture.peak,
      db: decibels(capture.rms),
      seconds: capture.seconds,
      transport: capture.stream ? 'stdout' : 'file',
    })
  } catch (error) {
    fail(res, 500, error instanceof Error ? error.message : String(error))
  }
}

/**
 * Register the plugin's exact routes.
 *
 * @param {object} ctx host plugin context (for `speechToText`)
 * @param {object} webServer the `webServer` service
 * @returns {() => void} disposer removing every route and stopping live captures
 */
export function registerRoutes(ctx, webServer) {
  const routes = [
    ['/ping', handlePing],
    ['/devices', handleDevices],
    ['/start', handleStart],
    ['/status', handleStatus],
    ['/stop', handleStop],
    ['/cancel', handleCancel],
  ]
  const disposers = routes.map(([path, handler]) => webServer.register({
    kind: 'exact',
    path: WEB_PREFIX + path,
    handler: (req, res) => {
      void (async () => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const body = await readJson(req).catch(() => ({}))
        await handler(ctx, req, res, url.searchParams, body)
      })().catch((error) => {
        if (!res.headersSent) fail(res, 500, error instanceof Error ? error.message : String(error))
      })
    },
  }))
  return () => {
    for (const entry of sessions.values()) {
      try {
        entry.session.kill()
      } catch {
        /* already gone */
      }
    }
    sessions.clear()
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* already disposed */
      }
    }
  }
}
