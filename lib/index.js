/**
 * dsh-system-audio — host half.
 *
 * Captures what the computer is PLAYING (Windows WASAPI loopback on a render
 * endpoint) and turns it into voice input text through the DSH local
 * speech-to-text service, the same one the microphone button uses.
 *
 * Own registrations only; no @deepseek-ai value imports.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve as resolvePath } from 'node:path'

import {
  captureBytes,
  listDevices,
  recordingsDir,
  recorderPath,
} from './recorder.js'
import { DEFAULT_WAIT_MS, ensureReady, speechState, transcribeWav } from './speech.js'
import { registerRoutes } from './routes.js'

export const name = 'dsh-system-audio'

const MAX_SECONDS = 120
const DEFAULT_SECONDS = 10

// ------------------------------------------------------------------ schemas

const JSON_TEXT = { type: 'string' }

const DEVICE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'name', 'default'],
  properties: { id: JSON_TEXT, name: JSON_TEXT, default: { type: 'boolean' } },
}

const DEVICES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'default', 'devices', 'speech'],
  properties: {
    ok: { type: 'boolean' },
    default: JSON_TEXT,
    devices: { type: 'array', items: DEVICE_SCHEMA },
    speech: {
      type: 'object',
      additionalProperties: false,
      required: ['available', 'providerId', 'phase', 'language', 'languages'],
      properties: {
        available: { type: 'boolean' },
        providerId: JSON_TEXT,
        phase: JSON_TEXT,
        language: JSON_TEXT,
        languages: { type: 'array', items: JSON_TEXT },
      },
    },
  },
}

const CAPTURE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['path', 'seconds', 'frames', 'bytes', 'rate', 'channels', 'bits', 'rms', 'peak', 'silentStop', 'converted', 'device'],
  properties: {
    path: JSON_TEXT,
    seconds: { type: 'number' },
    frames: { type: 'integer' },
    bytes: { type: 'integer' },
    rate: { type: 'integer' },
    channels: { type: 'integer' },
    bits: { type: 'integer' },
    rms: { type: 'number' },
    peak: { type: 'number' },
    silentStop: { type: 'boolean' },
    converted: { type: 'boolean' },
    device: JSON_TEXT,
  },
}

const RECORD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'recorder', 'capture'],
  properties: {
    ok: { type: 'boolean' },
    recorder: JSON_TEXT,
    capture: CAPTURE_SCHEMA,
  },
}

const LISTEN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'text', 'language', 'providerId', 'audioSeconds', 'inferenceSeconds', 'level', 'capture'],
  properties: {
    ok: { type: 'boolean' },
    text: JSON_TEXT,
    language: JSON_TEXT,
    providerId: JSON_TEXT,
    audioSeconds: { type: 'number' },
    inferenceSeconds: { type: 'number' },
    level: JSON_TEXT,
    capture: {
      type: 'object',
      additionalProperties: false,
      required: ['seconds', 'rms', 'peak', 'device', 'silentStop', 'converted'],
      properties: {
        seconds: { type: 'number' },
        rms: { type: 'number' },
        peak: { type: 'number' },
        device: JSON_TEXT,
        silentStop: { type: 'boolean' },
        converted: { type: 'boolean' },
      },
    },
  },
}

// ----------------------------------------------------------------- rendering

function renderDevices(value) {
  const lines = ['Playback devices available for system-audio capture:']
  if (value.devices.length === 0) lines.push('  (none)')
  for (const device of value.devices) {
    lines.push('  ' + (device.default ? '* ' : '  ') + device.name + '  [' + device.id + ']')
  }
  const speech = value.speech
  lines.push(
    'Speech-to-text: ' + (speech.available ? 'available' : 'unavailable') +
    (speech.providerId === '' ? '' : ' (provider ' + speech.providerId + ', phase ' + speech.phase + ')') +
    (speech.language === '' ? '' : ', language ' + speech.language),
  )
  if (recorderPath() === '') lines.push('Recorder: missing')
  return lines.join('\n')
}

function levelLabel(rms) {
  if (!(rms > 0)) return 'silence'
  const db = 20 * Math.log10(rms)
  if (db < -45) return 'very quiet (' + db.toFixed(1) + ' dB)'
  if (db < -30) return 'quiet (' + db.toFixed(1) + ' dB)'
  if (db < -18) return 'audible (' + db.toFixed(1) + ' dB)'
  return 'loud (' + db.toFixed(1) + ' dB)'
}

function renderRecord(value) {
  const capture = value.capture
  return [
    'Captured ' + capture.seconds.toFixed(2) + 's of system audio from "' + capture.device + '"',
    '  file: ' + capture.path,
    '  format: ' + capture.rate + ' Hz, ' + capture.channels + 'ch, ' + capture.bits + '-bit PCM (' +
      capture.frames + ' frames, ' + capture.bytes + ' bytes)',
    '  level: rms ' + capture.rms.toFixed(6) + ' (' + levelLabel(capture.rms) + '), peak ' + capture.peak.toFixed(6),
  ].join('\n')
}

function renderListen(value) {
  const capture = value.capture
  const lines = []
  if (value.text.trim() === '') {
    lines.push('No speech recognized in ' + capture.seconds.toFixed(2) + 's of system audio from "' + capture.device + '".')
  } else {
    lines.push(value.text.trim())
  }
  lines.push(
    '[system audio: ' + capture.seconds.toFixed(2) + 's, rms ' + capture.rms.toFixed(6) + ' (' +
    levelLabel(capture.rms) + '), provider ' + value.providerId + ', language ' + value.language +
    ', ' + value.inferenceSeconds.toFixed(2) + 's inference]',
  )
  return lines.join('\n')
}

// --------------------------------------------------------------------- tools

function clampSeconds(value, fallback) {
  const number = value === undefined || value === null ? fallback : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(MAX_SECONDS, Math.max(1, Math.round(number * 10) / 10))
}

function makeDevicesTool(ctx) {
  return {
    name: 'system_audio_devices',
    description:
      'List the Windows playback (render) endpoints that can be recorded as system audio, plus the current speech-to-text readiness. Use it before system_audio_listen when the user wants a specific playback device. [rev-probe]',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: DEVICES_SCHEMA, render: (_args, value) => [{ type: 'text', text: renderDevices(value) }] },
    async execute() {
      const devices = await listDevices()
      const speech = ctx.get('speechToText')
      let state = { available: false, providerId: '', phase: 'unavailable', language: '', languages: [] }
      if (speech) {
        const current = speechState(speech)
        state = {
          available: true,
          providerId: current.providerId,
          phase: current.phase,
          language: current.language,
          languages: current.languages,
        }
      }
      return { ok: true, default: devices.default, devices: devices.devices, speech: state }
    },
  }
}

/** Capture into a WAV file on disk (the bytes are written here, not by the child). */
async function captureToFile(options) {
  const wanted = typeof options.out === 'string' && options.out.trim() !== '' ? options.out : undefined
  const capture = await captureBytes({ ...options, out: undefined })
  const target = wanted === undefined
    ? join(recordingsDir(), 'system-audio-' + new Date().toISOString().replace(/[:.]/g, '-') + '.wav')
    : resolvePath(wanted)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, capture.wav)
  const result = { ...capture, path: target }
  // `stream`/`buffer`/`wav`/`levels` describe how the bytes were transported,
  // not the capture itself, and the declared schema is strict.
  delete result.stream
  delete result.buffer
  delete result.wav
  delete result.levels
  return result
}

function makeRecordTool(ctx) {
  return {
    name: 'system_audio_record',
    description:
      'Record what the computer is currently playing (system output audio, not the microphone) to a WAV file. Returns the file path and level statistics. Use system_audio_listen instead when the goal is a transcript.',
    parameters: {
      type: 'object',
      properties: {
        seconds: { type: 'number', description: 'Capture length in seconds (1-120, default 10).' },
        device: { type: 'string', description: 'Optional playback device id from system_audio_devices; the default device is used when omitted.' },
        out: { type: 'string', description: 'Optional absolute WAV output path; a temp file is used when omitted.' },
      },
      additionalProperties: false,
    },
    output: { schema: RECORD_SCHEMA, render: (_args, value) => [{ type: 'text', text: renderRecord(value) }] },
    async execute(args, exec) {
      const options = args && typeof args === 'object' ? args : {}
      const capture = await captureToFile({
        seconds: clampSeconds(options.seconds, DEFAULT_SECONDS),
        deviceId: typeof options.device === 'string' ? options.device : undefined,
        out: typeof options.out === 'string' ? options.out : undefined,
        exe: undefined,
        signal: exec?.signal,
      })
      return { ok: true, recorder: recorderPath(), capture }
    },
  }
}

function makeListenTool(ctx) {
  return {
    name: 'system_audio_listen',
    description:
      'Listen to what the computer is playing right now and return it as text. Captures system output audio through WASAPI loopback and transcribes it with the same local speech-to-text model the microphone button uses. Start the audio (video, music, call, TTS) before calling it.',
    parameters: {
      type: 'object',
      properties: {
        seconds: { type: 'number', description: 'Capture length in seconds (1-120, default 10).' },
        device: { type: 'string', description: 'Optional playback device id from system_audio_devices.' },
        language: { type: 'string', description: 'Optional language hint; the configured speech language is used when omitted.' },
        wait_ready: { type: 'boolean', description: 'When the speech model still needs downloading, wait for it instead of failing (default true).' },
      },
      additionalProperties: false,
    },
    output: { schema: LISTEN_SCHEMA, render: (_args, value) => [{ type: 'text', text: renderListen(value) }] },
    async execute(args, exec) {
      const options = args && typeof args === 'object' ? args : {}
      const speech = ctx.get('speechToText')
      if (!speech) {
        throw new Error('system-audio: no speech-to-text service in this composition (install the voice-input bundle)')
      }
      const waitMs = options.wait_ready === false ? 0 : DEFAULT_WAIT_MS
      let state = await ensureReady(speech, undefined, exec?.signal, waitMs)

      // The capture is streamed out of the recorder child (which may be sandboxed
      // against file writes) and kept in memory for the transcription.
      const capture = await captureBytes({
        seconds: clampSeconds(options.seconds, DEFAULT_SECONDS),
        deviceId: typeof options.device === 'string' ? options.device : undefined,
        signal: exec?.signal,
      })

      const language = typeof options.language === 'string' && options.language.trim() !== ''
        ? options.language.trim()
        : (state.language === '' ? undefined : state.language)

      const signal = exec?.signal ?? new AbortController().signal
      const transcript = await transcribeWav(speech, capture.wav, { language, signal })
      const seconds = transcript.audioSeconds > 0 ? transcript.audioSeconds : capture.seconds
      const text = transcript.text
      const inference = transcript.inferenceSeconds
      return {
        ok: true,
        text,
        language: language ?? state.language,
        providerId: state.providerId,
        audioSeconds: seconds,
        inferenceSeconds: inference,
        level: levelLabel(capture.rms),
        capture: {
          seconds: capture.seconds,
          rms: capture.rms,
          peak: capture.peak,
          device: capture.device,
          silentStop: capture.silentStop,
          converted: capture.converted,
        },
      }
    },
  }
}

// -------------------------------------------------------------------- plugin

export function apply(root) {
  root.inject(['tools'], (ctx) => {
    ctx.effect(() => ctx.tools.register(makeDevicesTool(ctx)), 'system-audio:devices')
    ctx.effect(() => ctx.tools.register(makeRecordTool(ctx)), 'system-audio:record')
    ctx.effect(() => ctx.tools.register(makeListenTool(ctx)), 'system-audio:listen')
  })
  root.inject(['webServer'], (ctx) => {
    const webServer = ctx.webServer ?? ctx.get('webServer')
    if (webServer === undefined || typeof webServer.register !== 'function') return
    ctx.effect(() => registerRoutes(ctx, webServer), 'system-audio:routes')
  })
}
