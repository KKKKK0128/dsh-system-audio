/**
 * dsh-system-audio — speech glue shared by the host tools and the browser routes.
 *
 * Everything that turns a captured WAV into text goes through here, so the agent
 * tools and the UI button always use the same composed local provider (the one
 * behind the microphone button) and the same readiness handling.
 */

/** How long to wait for a first-time model download before giving up. */
export const DEFAULT_WAIT_MS = 600000

/** Provider phases that can transcribe immediately. */
const READY_PHASES = new Set(['ready', 'standby'])

function infoOf(view) {
  const info = view?.info ?? view ?? {}
  return typeof info === 'object' && info !== null ? info : {}
}

function phaseOf(view) {
  const preparation = view?.preparation ?? view?.preparationState ?? view?.state
  if (typeof preparation === 'string') return preparation
  if (preparation && typeof preparation === 'object' && typeof preparation.phase === 'string') {
    return preparation.phase
  }
  return 'unknown'
}

function failureMessageOf(view) {
  const preparation = view?.preparation
  if (preparation && typeof preparation === 'object' && typeof preparation.message === 'string') {
    return preparation.message
  }
  return ''
}

/** Describe the selected provider and its readiness. */
export function speechState(speech) {
  const snapshot = speech.snapshot()
  const providers = Array.isArray(snapshot?.providers) ? snapshot.providers : []
  const selection = snapshot?.selection ?? {}
  const selected = typeof selection.providerId === 'string' ? selection.providerId : ''
  const view = providers.find((item) => infoOf(item).id === selected) ?? providers[0]
  const info = infoOf(view)
  return {
    providerId: typeof info.id === 'string' && info.id !== '' ? info.id : selected,
    phase: phaseOf(view),
    message: failureMessageOf(view),
    languages: Array.isArray(info.languages) ? info.languages.filter((item) => typeof item === 'string') : [],
    language: typeof selection.language === 'string' ? selection.language : '',
  }
}

/**
 * Make sure the composed speech provider can transcribe right now.
 * `waitMs <= 0` fails fast instead of waiting for a model download.
 */
export async function ensureReady(speech, providerId, signal, waitMs) {
  let state = speechState(speech)
  if (READY_PHASES.has(state.phase)) return state
  if (waitMs <= 0) {
    throw new Error(
      'speech-to-text provider "' + state.providerId + '" is not ready (phase: ' + state.phase + ')' +
      (state.message === '' ? '' : ' — ' + state.message) +
      '; run this tool again with wait_ready=true to download the model first',
    )
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), waitMs)
  const forward = () => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', forward, { once: true })
  }
  try {
    speech.prepare(state.providerId)
    for await (const snapshot of speech.follow(controller.signal)) {
      const providers = Array.isArray(snapshot?.providers) ? snapshot.providers : []
      const selection = snapshot?.selection ?? {}
      const id = typeof selection.providerId === 'string' ? selection.providerId : state.providerId
      const view = providers.find((item) => infoOf(item).id === id) ?? providers[0]
      state = {
        providerId: id,
        phase: phaseOf(view),
        message: failureMessageOf(view),
        languages: state.languages,
        language: typeof selection.language === 'string' ? selection.language : state.language,
      }
      if (READY_PHASES.has(state.phase)) return state
      if (state.phase === 'failed') {
        throw new Error('speech-to-text preparation failed: ' + (state.message === '' ? 'unknown reason' : state.message))
      }
      if (controller.signal.aborted) break
    }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', forward)
  }
  if (signal?.aborted) {
    const abort = new Error('system-audio: cancelled while preparing the speech model')
    abort.name = 'AbortError'
    throw abort
  }
  throw new Error(
    'timed out after ' + Math.round(waitMs / 1000) + 's waiting for the speech model to become ready (phase: ' +
    state.phase + ')',
  )
}

/**
 * Transcribe one canonical WAV through the composed provider.
 *
 * @param {object} speech the `speechToText` host service
 * @param {Uint8Array} audio canonical 16 kHz mono PCM16 WAV bytes
 * @param {{language?: string, signal?: AbortSignal}} [options]
 */
export async function transcribeWav(speech, audio, options = {}) {
  const language = typeof options.language === 'string' && options.language.trim() !== ''
    ? options.language.trim()
    : undefined
  const request = { audio }
  if (language !== undefined) request.language = language
  const spec = speech.resolve(request)
  const signal = options.signal ?? new AbortController().signal
  const transcript = await speech.transcribe(spec, signal)
  return {
    text: typeof transcript?.text === 'string' ? transcript.text : '',
    audioSeconds: typeof transcript?.audioSeconds === 'number' ? transcript.audioSeconds : 0,
    inferenceSeconds: typeof transcript?.inferenceSeconds === 'number' ? transcript.inferenceSeconds : 0,
    language: language ?? '',
  }
}
