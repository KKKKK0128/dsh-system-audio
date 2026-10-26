/**
 * Live checks for the capture APIs used by the click-to-start / click-to-stop
 * UI:
 *   A. the session API (startCapture/stop) writes a complete WAV on disk
 *   B. audio that is actually playing shows up in the captured level, through
 *      captureBytes(), which prefers the streamed (file-free) transport
 *
 * Run with the tone player already running for check B (see .test/live.sh).
 *   node .test/plugin-live.mjs
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { captureBytes, startCapture } from '../lib/recorder.js'

const failures = []
async function check(label, fn) {
  try {
    await fn()
    console.log('  ok   ' + label)
  } catch (error) {
    failures.push(label + ': ' + error.message)
    console.log('  FAIL ' + label + ' — ' + error.message)
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function assertCanonicalWav(bytes, label) {
  // captureBytes() hands back a Uint8Array (what the speech service consumes),
  // whose toString() has no encoding argument — view it as a Buffer to assert.
  const view = Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  assert.ok(view.length > 44, label + ': only ' + view.length + ' bytes')
  assert.equal(view.subarray(0, 4).toString('ascii'), 'RIFF', label + ': not a RIFF file')
  assert.equal(view.subarray(8, 12).toString('ascii'), 'WAVE', label + ': not a WAVE file')
  assert.equal(view.readUInt16LE(22), 1, label + ': expected 1 channel')
  assert.equal(view.readUInt32LE(24), 16000, label + ': expected 16000 Hz')
  assert.equal(view.readUInt16LE(34), 16, label + ': expected 16-bit samples')
  assert.equal(view.readUInt32LE(40) + 44, view.length, label + ': data chunk does not cover the file')
  return view.length
}

console.log('dsh-system-audio live capture checks')

await check('graceful stop writes a complete WAV well before --seconds', async () => {
  const session = await startCapture({ seconds: 60, levels: true, stdout: false })
  assert.ok(session.stdio === 'files' || session.stdio === 'pipes', 'unexpected stdio mode ' + session.stdio)
  console.log('       stdio mode: ' + session.stdio)
  await sleep(1500)
  const done = await session.stop()
  assert.ok(done.done, 'no done event after stop()')
  assert.equal(done.done.silentStop, false, 'silentStop should be false')
  const seconds = done.done.seconds
  assert.ok(seconds > 1.2 && seconds < 6, 'expected ~1.5s of audio, got ' + seconds)
  const bytes = await readFile(session.out)
  assertCanonicalWav(bytes, 'file capture')
  console.log('       stopped after ' + seconds.toFixed(2) + 's, ' + bytes.length + ' B, ' +
    session.levels.length + ' level events')
})

await check('playing audio raises the captured level', async () => {
  const done = await captureBytes({ seconds: 5, levels: true })
  console.log('       transport: ' + (done.stream === true ? 'streamed (no child file)' : 'file fallback'))
  const size = assertCanonicalWav(done.wav, 'captureBytes')
  assert.ok(done.rms > 0.05, 'captured rms ' + done.rms.toFixed(6) + ' is too low — was the tone playing?')
  const peakLevel = done.levels.reduce((max, item) => Math.max(max, item.rms ?? 0), 0)
  assert.ok(peakLevel > 0.05, 'no loud level event (max ' + peakLevel.toFixed(6) + ')')
  console.log('       rms ' + done.rms.toFixed(4) + ', peak ' + done.peak.toFixed(4) +
    ', loudest 100ms window ' + peakLevel.toFixed(4) + ', ' + done.levels.length + ' windows, ' +
    size + ' B WAV')
})

console.log(failures.length === 0 ? '\nALL LIVE CHECKS PASSED' : '\n' + failures.length + ' LIVE CHECK(S) FAILED')
process.exit(failures.length === 0 ? 0 : 1)
