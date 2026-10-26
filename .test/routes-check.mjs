// Route-level checks: drive the real plugin over a real HTTP server with a stub
// speech service, so the browser-facing contract is verified without the GUI.
import { createServer } from 'node:http'

import { apply } from '../lib/index.js'

const checks = []
function check(label, run) {
  checks.push({ label, run })
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const routes = []
function register(route) {
  if (routes.some((item) => item.kind === route.kind && item.path === route.path)) {
    throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
  }
  routes.push(route)
  return () => {
    const index = routes.indexOf(route)
    if (index >= 0) routes.splice(index, 1)
  }
}

const transcripts = []
const speech = {
  snapshot: () => ({
    providers: [{
      info: { id: 'stub-local', name: 'Stub local', languages: ['zh', 'en'] },
      preparation: { phase: 'standby' },
    }],
    selection: { providerId: 'stub-local', language: 'zh' },
  }),
  prepare: () => {},
  async *follow() {},
  resolve: (request) => ({ request }),
  transcribe: async (spec) => {
    transcripts.push(spec.request)
    return { text: 'captured speech', audioSeconds: 1.5, inferenceSeconds: 0.2 }
  },
}

const registered = new Map()
const webServer = { register }
const ctx = {
  webServer,
  get: (name) => (name === 'speechToText' ? speech : name === 'webServer' ? webServer : undefined),
  effect: (fn) => fn(),
  tools: { register: (definition) => { registered.set(definition.name, definition); return () => registered.delete(definition.name) } },
}
apply({ inject: (_deps, callback) => callback(ctx) })

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const route = routes.find((item) => item.kind === 'exact' && item.path === url.pathname)
  if (route === undefined) {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
    return
  }
  route.handler(req, res)
})
await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise))
const base = `http://127.0.0.1:${server.address().port}`

async function get(path) {
  const response = await fetch(base + path, { headers: { accept: 'application/json' } })
  return { status: response.status, body: await response.json() }
}

async function post(path, payload) {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  })
  return { status: response.status, body: await response.json() }
}

const wait = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))

function assertCanonicalWav(bytes, label) {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  assert(buffer.length > 44, `${label}: expected audio payload, got ${buffer.length} bytes`)
  assert(buffer.toString('latin1', 0, 4) === 'RIFF', `${label}: missing RIFF tag`)
  assert(buffer.toString('latin1', 8, 12) === 'WAVE', `${label}: missing WAVE tag`)
  assert(buffer.readUInt16LE(22) === 1, `${label}: expected mono`)
  assert(buffer.readUInt32LE(24) === 16000, `${label}: expected 16 kHz`)
  assert(buffer.readUInt16LE(34) === 16, `${label}: expected 16-bit samples`)
  assert(buffer.readUInt32LE(40) === buffer.length - 44, `${label}: data size mismatch`)
}

check('registers the six routes under /system-audio', () => {
  const paths = routes.map((route) => route.path).sort()
  const expected = ['/system-audio/cancel', '/system-audio/devices', '/system-audio/ping',
    '/system-audio/start', '/system-audio/status', '/system-audio/stop']
  assert(paths.join(',') === expected.join(','), `unexpected routes: ${paths.join(',')}`)
})

check('GET /ping answers', async () => {
  const { status, body } = await get('/system-audio/ping')
  assert(status === 200 && body.ok === true, `ping failed: ${status} ${JSON.stringify(body)}`)
  assert(body.prefix === '/system-audio', 'ping prefix mismatch')
})

check('GET /devices lists capture sources and speech state', async () => {
  const { status, body } = await get('/system-audio/devices')
  assert(status === 200 && body.ok === true, `devices failed: ${status} ${JSON.stringify(body)}`)
  assert(Array.isArray(body.devices) && body.devices.length >= 1, 'expected at least one playback device')
  assert(body.speech.available === true && body.speech.phase === 'standby', 'speech state mismatch')
})

check('POST /start then /status reports a live capture', async () => {
  const started = await post('/system-audio/start', { seconds: 3 })
  assert(started.status === 200 && typeof started.body.id === 'string', `start failed: ${JSON.stringify(started.body)}`)
  await wait(700)
  const status = await get(`/system-audio/status?id=${started.body.id}`)
  assert(status.status === 200 && status.body.ok === true, `status failed: ${JSON.stringify(status.body)}`)
  assert(status.body.state === 'recording', `expected recording, got ${status.body.state}`)
  assert(Array.isArray(status.body.levels), 'levels must be an array')
  assert(typeof status.body.elapsed === 'number' && status.body.elapsed > 0, 'elapsed must advance')
  const stopped = await post('/system-audio/stop', { id: started.body.id })
  assert(stopped.status === 200 && stopped.body.ok === true, `stop failed: ${JSON.stringify(stopped.body)}`)
  assert(stopped.body.text === 'captured speech', `unexpected transcript: ${stopped.body.text}`)
  assert(stopped.body.language === 'zh', `unexpected language: ${stopped.body.language}`)
  assert(typeof stopped.body.seconds === 'number' && stopped.body.seconds > 0, 'capture seconds missing')
})

check('the transcript request carried a canonical WAV', () => {
  assert(transcripts.length === 1, `expected one transcription, got ${transcripts.length}`)
  assertCanonicalWav(transcripts[0].audio, 'routes transcribe payload')
})

check('a capture that reaches its own limit reports state stopped', async () => {
  const started = await post('/system-audio/start', { seconds: 1 })
  assert(started.status === 200, `start failed: ${JSON.stringify(started.body)}`)
  let state = ''
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const status = await get(`/system-audio/status?id=${started.body.id}`)
    state = status.body.state
    if (state === 'stopped') break
    await wait(250)
  }
  assert(state === 'stopped', `capture never reported stopped (last: ${state})`)
  const stopped = await post('/system-audio/stop', { id: started.body.id })
  assert(stopped.status === 200 && stopped.body.ok === true, `stop failed: ${JSON.stringify(stopped.body)}`)
  assert(transcripts.length === 2, 'the second capture must be transcribed too')
})

check('POST /cancel discards a capture', async () => {
  const started = await post('/system-audio/start', { seconds: 30 })
  assert(started.status === 200, `start failed: ${JSON.stringify(started.body)}`)
  await wait(400)
  const cancelled = await post('/system-audio/cancel', { id: started.body.id })
  assert(cancelled.status === 200 && cancelled.body.ok === true, `cancel failed: ${JSON.stringify(cancelled.body)}`)
  const status = await get(`/system-audio/status?id=${started.body.id}`)
  assert(status.status === 404, `a cancelled capture must be gone, got ${status.status}`)
  assert(transcripts.length === 2, 'cancel must not transcribe')
})

check('unknown ids and parse errors are rejected as JSON', async () => {
  const missing = await post('/system-audio/stop', { id: 'nope' })
  assert(missing.status === 404 && missing.body.ok === false, `unknown id must 404, got ${missing.status}`)
  const noId = await get('/system-audio/status')
  assert(noId.status === 404 && noId.body.ok === false, `missing id must 404, got ${noId.status}`)
})

let failed = 0
for (const item of checks) {
  try {
    await item.run()
    console.log('  ok  ', item.label)
  } catch (error) {
    failed += 1
    console.log('  FAIL', item.label, '→', error instanceof Error ? error.message : String(error))
  }
}

server.close()
await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
console.log(failed === 0 ? '\nALL ROUTE CHECKS PASSED' : `\n${failed} ROUTE CHECK(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)
