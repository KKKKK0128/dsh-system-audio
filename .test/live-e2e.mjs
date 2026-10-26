// Live end-to-end acceptance for dsh-system-audio.
// Proves: real system output audio -> SenseVoice transcript, plus the silence auto-stop.
// Playback runs as a foreground child of THIS process with stdio:'inherit'
// (default piped stdio throws EPERM inside the DSH sandbox).
// Capture contract: POST /start -> {id}; GET /status?id=...; POST /stop {id}.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const BASE = 'http://127.0.0.1:19387/system-audio'
const EXPECT = '你好，这是一段测试语音。系统正在播放声音，插件需要把它录下来并识别成文字。'
const WAV = fileURLToPath(new URL('./speech-zh.wav', import.meta.url))

let fails = 0
const check = (label, ok, detail) => {
  if (ok) console.log(`ok   ${label} — ${detail}`)
  else { fails += 1; console.log(`FAIL ${label} — ${detail}`) }
}
const post = async (path, body) => (await fetch(`${BASE}/${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body ?? {}),
})).json()
const get = async (path) => (await fetch(`${BASE}/${path}`)).json()
// SenseVoice punctuation is not stable (a comma may be dropped), so compare content
// characters only: strip whitespace and CJK punctuation from both sides.
const norm = (s) => String(s ?? '').replace(/[\s，。、！？：；,.!?:;]/g, '')
const play = (wav) => spawnSync('powershell.exe', ['-NoProfile', '-Command', `(New-Object System.Media.SoundPlayer '${wav}').PlaySync()`], { stdio: 'inherit' })

console.log('=== 1. capture real system audio and transcribe ===')
const started = await post('start', { seconds: 30 })
const id = started.id
check('POST /start', started.ok === true && typeof id === 'string', JSON.stringify(started))

const played = play(WAV)
check('playback process exited', played.status === 0, `status=${played.status} signal=${played.signal}`)

await new Promise((resolve) => setTimeout(resolve, 900))
const status = await get(`status?id=${encodeURIComponent(id)}`)
const samples = Array.isArray(status.levels) ? status.levels.length : 0
check('GET /status during capture', samples > 0, `${samples} sample(s), state=${status.state}, elapsed=${status.elapsed}`)
// status.rms is the instantaneous level; by the time PlaySync returns the tail is silent,
// so audibility is judged on the loudest sample kept in the rolling levels window.
const peakRms = (status.levels ?? []).reduce((max, l) => Math.max(max, Number(l.rms) || 0), 0)
check('captured audible audio', peakRms > 0.01, `peak rms=${peakRms} (instant rms=${status.rms} db=${status.db})`)

const stopped = await post('stop', { id })
check('transcript matches the known sentence', norm(stopped.text) === norm(EXPECT), JSON.stringify(stopped))
console.log(`EXPECT: ${EXPECT}`)
console.log(`GOT   : ${stopped.text}`)

console.log('\n=== 2. silence auto-stop (Phase 3) ===')
const started2 = await post('start', { seconds: 30, silenceMs: 600 })
const id2 = started2.id
check('POST /start (silenceMs=600)', started2.ok === true && typeof id2 === 'string', JSON.stringify(started2))
await new Promise((resolve) => setTimeout(resolve, 4000))
const status2 = await get(`status?id=${encodeURIComponent(id2)}`)
check('session stopped itself on silence', status2.state === 'stopped', `state=${status2.state} ${JSON.stringify(status2)}`)
console.log('stop after auto-stop:', JSON.stringify(await post('stop', { id: id2 })))

console.log(`\n=== result: failed=${fails} ===`)
process.exit(fails > 0 ? 1 : 0)
