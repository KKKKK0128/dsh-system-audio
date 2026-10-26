#!/usr/bin/env node
// Live acceptance check for the installed dsh-system-audio plugin, run against
// the ACTIVE DSH Desktop host (default http://127.0.0.1:19387).
//
//   node .test/live-routes.mjs [--seconds 12] [--device <id>] [--base <url>]
//                              [--play <wav>] [--expect "<known text>"]
//
// Checks the host half in the running app:
//   1. GET  /system-audio/ping     -> { ok: true, ... }
//   2. GET  /system-audio/devices  -> playback devices + speech provider state
//   3. POST /system-audio/start    -> live level polling -> POST /stop -> transcript
//      (with --play it plays a WAV on the default output during the capture, so
//       --expect can compare the transcript of the recorded system audio)
// The client half lives in the browser bundle, which is auth-fenced to the
// desktop window: with an unauthenticated GET / those two checks are reported
// as skipped, and are meant to be verified in the app (⚙/mic row) or through
// cordis_inspect_query client/Slots.listSubTree.
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const argv = process.argv.slice(2)
function argValue(name, fallback) {
  const index = argv.indexOf(name)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}
const BASE = argValue('--base', process.env.DSH_BASE ?? 'http://127.0.0.1:19387').replace(/\/+$/, '')
const SECONDS = Number(argValue('--seconds', '12'))
const PLAY = argValue('--play', undefined)
const EXPECT = argValue('--expect', undefined)
const DEVICE = argValue('--device', undefined)

let passed = 0
let failed = 0
let skipped = 0
function check(label, ok, detail) {
  if (ok) {
    passed += 1
    console.log(`ok   ${label}${detail ? ` — ${detail}` : ''}`)
  } else {
    failed += 1
    console.log(`FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}
function skip(label, detail) {
  skipped += 1
  console.log(`skip ${label}${detail ? ` — ${detail}` : ''}`)
}

async function request(path, init) {
  const response = await fetch(BASE + path, { ...init, signal: AbortSignal.timeout(30000) })
  const text = await response.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { status: response.status, text, json, type: response.headers.get('content-type') ?? '' }
}

/** Play a WAV on the default output without pipes (a confined sandbox denies piped spawns). */
function playInBackground(file) {
  const script = `(New-Object System.Media.SoundPlayer '${file}').PlaySync()`
  const child = spawn('powershell.exe', ['-NoProfile', '-Command', script], { stdio: 'ignore', detached: true })
  child.unref()
  return child
}

function normalize(text) {
  return String(text ?? '').replace(/\s+/g, '')
}

async function main() {
  console.log(`target ${BASE}${PLAY ? `\nplaying ${PLAY}` : ''}\n`)

  const ping = await request('/system-audio/ping')
  check('GET /system-audio/ping', ping.status === 200 && ping.json?.ok === true, `${ping.status} ${ping.text.slice(0, 120)}`)

  const devices = await request('/system-audio/devices')
  const list = Array.isArray(devices.json?.devices) ? devices.json.devices : []
  check(
    'GET /system-audio/devices',
    devices.status === 200 && list.length > 0,
    `${list.length} device(s): ${list.map((d) => `${d.name}${d.default ? '*' : ''}`).join(', ')} | speech: ${devices.json?.speech?.phase ?? '?'}`,
  )

  const started = await request('/system-audio/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ seconds: SECONDS, device: DEVICE }),
  })
  const id = started.json?.id
  check(
    'POST /system-audio/start',
    started.status === 200 && started.json?.ok === true && typeof id === 'string',
    `${started.status} transport=${started.json?.transport} id=${id}`,
  )

  if (PLAY !== undefined) {
    playInBackground(PLAY)
    await sleep(500)
  }

  let samples = 0
  let peak = 0
  const deadline = Date.now() + SECONDS * 1000 + 4000
  while (id !== undefined && Date.now() < deadline) {
    await sleep(300)
    const status = await request(`/system-audio/status?id=${encodeURIComponent(id)}`)
    if (status.status === 200 && status.json?.ok === true) {
      const levels = Array.isArray(status.json.levels) ? status.json.levels.length : 0
      samples = Math.max(samples, levels)
      peak = Math.max(peak, Number(status.json.rms) || 0)
      if (status.json.state === 'stopped') break
    }
  }
  check('GET /system-audio/status (recording, live levels)', samples > 0, `${samples} level sample(s), peak rms ${peak.toFixed(4)}`)
  if (PLAY !== undefined) check('live level rose above silence', peak > 0.01, `peak rms ${peak.toFixed(4)}`)

  const stopped = await request('/system-audio/stop', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  })
  const text = typeof stopped.json?.text === 'string' ? stopped.json.text : undefined
  check(
    'POST /system-audio/stop -> transcript',
    stopped.status === 200 && stopped.json?.ok === true && text !== undefined,
    `${stopped.status} text=${JSON.stringify(text)} audioSeconds=${stopped.json?.audioSeconds} inferenceSeconds=${stopped.json?.inferenceSeconds}`,
  )
  if (text === '') console.log('     note: empty transcript — nothing audible was playing during the capture')
  if (EXPECT !== undefined && text !== undefined) {
    const got = normalize(text)
    const want = normalize(EXPECT)
    check('transcript matches the expected sentence', got === want, got === want ? 'exact match (ignoring whitespace)' : `got ${JSON.stringify(got)}`)
  }

  const index = await request('/')
  if (index.status === 401 || index.status === 403) {
    skip('client bundle (GET /)', `index ${index.status} — the browser bundle is auth-fenced; verify the button in the app`)
  } else {
    check('GET / contains the dsh-system-audio client entry', index.status === 200 && index.text.includes('dsh-system-audio'), `index ${index.status}, ${index.text.length} bytes`)
    const bundleUrls = [...new Set([...index.text.matchAll(/["'(](\/plugins\/[A-Za-z0-9._~%/-]+\.js)["')]/g)].map((m) => m[1]))]
    let served = false
    for (const url of bundleUrls) {
      const bundle = await request(url)
      if (bundle.status === 200 && bundle.text.includes('dsh-system-audio')) {
        served = true
        check('client bundle carries lib/client.js', true, `${url} (${bundle.text.length} bytes)`)
        break
      }
    }
    if (!served) check('client bundle carries lib/client.js', false, `${bundleUrls.length} bundle url(s) checked, none contained the marker`)
  }

  console.log(`\npassed ${passed}, failed ${failed}, skipped ${skipped}`)
  process.exitCode = failed === 0 ? 0 : 1
}

main().catch((error) => {
  console.error(`live check error: ${error?.cause?.message ?? error?.message ?? error}`)
  process.exitCode = 2
})
