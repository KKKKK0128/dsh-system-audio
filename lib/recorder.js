/**
 * dsh-system-audio / recorder.js
 *
 * Process wrapper around the bundled Windows WASAPI loopback recorder
 * (`native/LoopbackRecorder.exe`, source `native/LoopbackRecorder.cs`).
 *
 * Plain Node only: this module deliberately imports nothing from @deepseek-ai
 * so the plugin stays a self-contained bundle mount.
 *
 * Recorder contract (line-delimited JSON on stdout, UTF-8):
 *   {"event":"devices","default":"<id>","devices":[{"id","name","default"}]}
 *   {"event":"start","device","deviceId","rate","channels","bits","converted","file"}
 *   {"event":"level","t","rms","db"}                      (only with --levels, every 100 ms)
 *   {"event":"done","file","seconds","frames","bytes","rate","channels","bits",
 *    "rms","peak","silentStop","converted","device"}
 *   {"event":"error","message"}                            (exit code 1)
 *
 * Stream mode (`--out -`, used by captureBytes): the complete WAV is written to
 * the process stdout as raw bytes and these JSON events move to stderr, so the
 * spawned child never creates a file. That matters because a confined Windows
 * sandbox (the DSH `workspace-write` file policy) denies a child process any
 * file write, even inside %TEMP%, while the parent Node process stays free to
 * persist the bytes itself.
 */

import { spawn } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
} from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'

/** Package root (the directory holding package.json). */
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Canonical speech format: the only WAV shape the DSH /wave helper accepts. */
export const DEFAULT_RATE = 16000
export const DEFAULT_CHANNELS = 1
export const DEFAULT_BITS = 16

/** Absolute path of the bundled recorder, overridable for development. */
export function recorderPath() {
  const override = process.env.DSH_SYSTEM_AUDIO_RECORDER
  if (typeof override === 'string' && override.trim() !== '') return resolve(override.trim())
  return join(PACKAGE_ROOT, 'native', 'LoopbackRecorder.exe')
}

/** Directory holding capture scratch files. */
export function recordingsDir() {
  return join(tmpdir(), 'dsh-system-audio')
}

function requireRecorder(exe) {
  if (!existsSync(exe)) {
    throw new Error(
      'system-audio: the loopback recorder is missing at ' + exe +
      ' (rebuild it with: native/build.cmd)',
    )
  }
}

function clamp(value, min, max, fallback) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

function normalizeStdioMode(value) {
  return value === 'files' || value === 'pipes' ? value : 'auto'
}

async function resolveOutPath(explicit) {
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    const target = isAbsolute(explicit) ? explicit : resolve(process.cwd(), explicit)
    await mkdir(dirname(target), { recursive: true })
    return target
  }
  const dir = recordingsDir()
  await mkdir(dir, { recursive: true })
  return join(dir, 'system-audio-' + uniqueStamp() + '.wav')
}

function uniqueStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-') + '-' + Math.random().toString(36).slice(2, 8)
}

/**
 * Spawn the recorder and stream its JSON events.
 *
 * Stdio mode: `auto` (default) starts with pipes and transparently retries with
 * file-backed stdio when the environment forbids creating named pipes — which
 * is what a confined Windows sandbox does, and the retry is the only way to
 * keep working there. Set DSH_SYSTEM_AUDIO_STDIO=pipes|files to force a mode.
 *
 * @param {string[]} args
 * @param {{exe?: string, onEvent?: (event: object) => void, stdio?: string,
 *   binaryStdout?: boolean, stdinPipe?: boolean}} [options] `binaryStdout` collects
 *   stdout as the WAV payload and reads the JSON events from stderr instead;
 *   `stdinPipe` keeps the child's stdin open so `endStdin()` can ask it to stop.
 */
export function launchRecorder(args, options = {}) {
  const exe = options.exe ?? recorderPath()
  requireRecorder(exe)
  const requested = normalizeStdioMode(options.stdio ?? process.env.DSH_SYSTEM_AUDIO_STDIO)
  const binary = options.binaryStdout === true
  const stdinPipe = options.stdinPipe === true

  const events = []
  const levels = []
  const chunks = []
  let pendingBytes = 0
  let done = null
  let failure = null
  let spawnError = null
  let stderr = ''
  let carry = ''
  let child = null
  let stdioMode = requested === 'files' ? 'files' : 'pipes'
  let fileState = null
  let settledResult = null
  let resolveSettled = null
  const settled = new Promise((resolvePromise) => {
    resolveSettled = resolvePromise
  })

  const handleLine = (line) => {
    const text = line.trim()
    if (text === '') return
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      return // tolerate any non-JSON chatter on stdout
    }
    if (parsed === null || typeof parsed !== 'object') return
    if (parsed.event === 'done') done = parsed
    if (parsed.event === 'level') {
      levels.push(parsed)
      if (levels.length > 400) levels.splice(0, levels.length - 400)
    }
    if (parsed.event === 'error') {
      failure = new Error(typeof parsed.message === 'string' ? parsed.message : 'loopback capture failed')
    }
    events.push(parsed)
    options.onEvent?.(parsed)
  }

  const handleText = (text) => {
    carry += text
    let index = carry.indexOf('\n')
    while (index >= 0) {
      handleLine(carry.slice(0, index))
      carry = carry.slice(index + 1)
      index = carry.indexOf('\n')
    }
  }

  const drainFile = () => {
    const state = fileState
    if (state === null) return
    const buffer = Buffer.alloc(65536)
    for (;;) {
      let read = 0
      try {
        read = readSync(state.readFd, buffer, 0, buffer.length, state.offset)
      } catch {
        return
      }
      if (read <= 0) return
      state.offset += read
      handleText(state.decoder.write(buffer.subarray(0, read)))
    }
  }

  const releaseFiles = () => {
    const state = fileState
    if (state === null) return
    fileState = null
    if (state.timer !== null) clearInterval(state.timer)
    for (const fd of [state.readFd, state.outFd, state.errFd]) {
      try {
        if (fd !== null && fd !== undefined) closeSync(fd)
      } catch {
        /* already closed */
      }
    }
    try {
      rmSync(state.outPath, { force: true })
      rmSync(state.errPath, { force: true })
    } catch {
      /* best effort */
    }
  }

  const settle = (payload) => {
    if (settledResult !== null) return
    settledResult = payload
    releaseFiles()
    resolveSettled(payload)
  }

  const finalize = (code, signal) => {
    drainFile()
    if (fileState !== null) {
      try {
        stderr += readFileSync(fileState.errPath, 'utf8')
      } catch {
        /* no stderr file */
      }
    }
    if (carry.trim() !== '') handleLine(carry)
    carry = ''
    const tail = stderr.trim()
    settle({
      code,
      signal,
      done,
      error: failure ?? spawnError,
      stderr: tail.length > 4000 ? tail.slice(tail.length - 4000) : tail,
      events,
      levels,
    })
  }

  const startWithFiles = () => {
    stdioMode = 'files'
    const dir = recordingsDir()
    mkdirSync(dir, { recursive: true })
    const stamp = uniqueStamp()
    const outPath = join(dir, 'events-' + stamp + '.log')
    const errPath = outPath + '.err'
    const outFd = openSync(outPath, 'w')
    const errFd = openSync(errPath, 'w')
    const proc = spawn(exe, args, { windowsHide: true, stdio: ['ignore', outFd, errFd] })
    child = proc
    fileState = {
      outPath,
      errPath,
      outFd,
      errFd,
      readFd: openSync(outPath, 'r'),
      offset: 0,
      decoder: new StringDecoder('utf8'),
      timer: null,
    }
    const state = fileState
    state.timer = setInterval(() => {
      if (fileState === state) drainFile()
    }, 60)
    proc.once('error', (error) => {
      spawnError = error
    })
    proc.once('close', (code, signal) => finalize(code, signal))
  }

  const startWithPipes = () => {
    const proc = spawn(exe, args, { windowsHide: true, stdio: [stdinPipe ? 'pipe' : 'ignore', 'pipe', 'pipe'] })
    child = proc
    if (binary) {
      // stdout is the WAV payload; stderr carries the line-delimited events.
      proc.stdout.on('data', (chunk) => {
        chunks.push(chunk)
        pendingBytes += chunk.length
      })
      proc.stderr.setEncoding('utf8')
      proc.stderr.on('data', (chunk) => handleText(chunk))
      proc.once('error', (error) => {
        spawnError = error
      })
      proc.once('close', (code, signal) => finalize(code, signal))
      return
    }
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk) => handleText(chunk))
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk) => {
      if (stderr.length < 8192) stderr += chunk
    })
    proc.once('error', (error) => {
      // A confined sandbox cannot create the named pipes stdio needs; retry
      // through file-backed stdio, which only needs a writable file.
      if (error?.code === 'EPERM' && requested !== 'pipes' && proc.pid === undefined) {
        proc.removeAllListeners('close')
        startWithFiles()
        return
      }
      spawnError = error
    })
    proc.once('close', (code, signal) => finalize(code, signal))
  }

  if (binary) {
    // Stream mode always needs a pipe: there is no file-backed fallback because
    // the whole point is that the child process writes nothing. A sandbox that
    // forbids pipes fails here (synchronously with EPERM) and the caller retries
    // the capture with a real output file instead.
    startWithPipes()
  } else if (requested === 'files') {
    startWithFiles()
  } else {
    try {
      startWithPipes()
    } catch (error) {
      // On Windows a confined process fails `spawn` SYNCHRONOUSLY with EPERM
      // when stdio needs a named pipe. Retry through file-backed stdio before
      // giving up, unless the caller explicitly demanded pipes.
      if (requested === 'pipes') throw error
      startWithFiles()
    }
  }

  return {
    exe,
    args,
    get pid() {
      return child?.pid
    },
    get child() {
      return child
    },
    get stdio() {
      return stdioMode
    },
    /** True when stdout carries the WAV payload (that is, `--out -`). */
    binaryStdout: binary,
    /** The captured WAV collected from stdout (empty in file mode). */
    outputBuffer: () => Buffer.concat(chunks, pendingBytes),
    events,
    levels,
    settled,
    lastLevel: () => (levels.length === 0 ? null : levels[levels.length - 1]),
    /** True when the child has a stdin pipe we can close to ask it to stop. */
    get hasStdin() {
      return child?.stdin !== null && child?.stdin !== undefined
    },
    /**
     * Close the child's stdin. With `--stop-on-stdin` the recorder treats that
     * as its stop signal and still finishes the WAV header, which is the only
     * stop channel available when the child cannot read a shared stop file.
     */
    endStdin: () => {
      try {
        child?.stdin?.end()
      } catch {
        /* no stdin pipe */
      }
    },
    kill: () => {
      try {
        child?.kill()
      } catch {
        /* already gone */
      }
    },
  }
}

/**
 * Ask a running recorder to stop and still write a complete WAV.
 * Gracious stop channels, in order: the stop file (`--stop-file`) when the
 * caller named one, else closing the child's stdin (`--stop-on-stdin`). A hard
 * kill follows after the grace period if neither worked.
 */
export async function requestStop(session, stopFile, graceMs = 2500) {
  if (typeof stopFile === 'string' && stopFile !== '') {
    try {
      await writeFile(stopFile, 'stop', 'utf8')
    } catch {
      /* fall through to the stdin/kill path */
    }
  }
  // No shared file to poll (or writing it failed): closing stdin is the stop
  // signal. It is a no-op when the child was spawned without a stdin pipe.
  if (typeof stopFile !== 'string' || stopFile === '') session.endStdin?.()
  const timer = setTimeout(() => session.kill(), graceMs)
  try {
    await session.settled
  } finally {
    clearTimeout(timer)
    if (typeof stopFile === 'string' && stopFile !== '') await rm(stopFile, { force: true })
  }
}

/** List render (playback) endpoints usable as capture sources. */
export async function listDevices(options = {}) {
  const session = launchRecorder(['--list-devices'], options)
  const result = await session.settled
  const event = result.events.find((item) => item?.event === 'devices')
  if (!event) {
    if (result.error) throw result.error
    throw new Error('system-audio: could not enumerate playback devices' +
      (result.stderr === '' ? '' : ' — ' + result.stderr))
  }
  const devices = Array.isArray(event.devices) ? event.devices : []
  return {
    default: typeof event.default === 'string' ? event.default : '',
    devices: devices.map((device) => ({
      id: typeof device?.id === 'string' ? device.id : '',
      name: typeof device?.name === 'string' ? device.name : '',
      default: device?.default === true,
    })),
  }
}

/**
 * Start a loopback capture. Returns a live session; the WAV is complete once
 * `settled` resolves (via --seconds, --silence-stop, or stop()).
 *
 * @param {{seconds?: number, deviceId?: string, rate?: number, channels?: number,
 *   bits?: number, levels?: boolean, silenceStopMs?: number, silenceThreshold?: number,
 *   out?: string, stopFile?: string, exe?: string, signal?: AbortSignal}} [options]
 */
export async function startCapture(options = {}) {
  const seconds = clamp(options.seconds, 0.5, 600, 30)
  const rate = Math.round(clamp(options.rate, 8000, 192000, DEFAULT_RATE))
  const channels = Math.round(clamp(options.channels, 1, 2, DEFAULT_CHANNELS))
  const bits = Math.round(clamp(options.bits, 8, 32, DEFAULT_BITS))
  const explicitOut = typeof options.out === 'string' && options.out.trim() !== ''
  // Stream mode is the default whenever the caller did not name an output file:
  // the recorder hands the WAV over stdout, so no child-process file write is
  // needed (a confined sandbox denies those). Pass stdout:false or an explicit
  // `out` path to use the file-backed path instead.
  const stream = options.stdout === true || (options.stdout !== false && !explicitOut)
  const explicitPath = explicitOut ? await resolveOutPath(options.out) : null
  // Without an explicit `out` the CHILD resolves the file itself, inside its own
  // temp directory: a confined sandbox grants a spawned process its private temp
  // root while the real user Temp stays denied, so only the child knows a
  // writable path. The absolute result is reported back in `start`/`done`.
  const outTemp = stream || explicitOut ? null : 'system-audio-' + uniqueStamp() + '.wav'
  // Stream mode stops by closing stdin, so it needs no shareable stop file. The
  // file path keeps the stop flag it always had.
  const stopFile = typeof options.stopFile === 'string' && options.stopFile.trim() !== ''
    ? resolve(options.stopFile)
    : (stream ? null : join(recordingsDir(), 'stop-' + uniqueStamp() + '.flag'))

  const args = [
    '--capture',
    '--seconds', String(seconds),
    '--rate', String(rate),
    '--channels', String(channels),
    '--bits', String(bits),
  ]
  if (stream) args.push('--out', '-')
  else if (explicitPath !== null) args.push('--out', explicitPath)
  else args.push('--out-temp', outTemp)
  if (stream) args.push('--stop-on-stdin')
  if (typeof options.deviceId === 'string' && options.deviceId.trim() !== '') {
    args.push('--device', options.deviceId.trim())
  }
  if (options.levels === true) args.push('--levels')
  if (Number.isFinite(options.silenceStopMs) && options.silenceStopMs > 0) {
    args.push('--silence-stop', String(Math.round(options.silenceStopMs)))
  }
  if (Number.isFinite(options.silenceThreshold) && options.silenceThreshold > 0) {
    args.push('--silence-threshold', String(options.silenceThreshold))
  }
  if (stopFile !== null) args.push('--stop-file', stopFile)

  const session = launchRecorder(args, {
    exe: options.exe,
    binaryStdout: stream,
    stdinPipe: stream,
    stdio: stream ? 'pipes' : undefined,
  })
  let aborted = false
  const onAbort = () => {
    aborted = true
    void requestStop(session, stopFile)
  }
  if (options.signal) {
    if (options.signal.aborted) onAbort()
    else options.signal.addEventListener('abort', onAbort, { once: true })
  }

  // In file mode the child picked its own output path; read it from the event
  // stream once it has started.
  const resolveOut = () => {
    if (stream) return null
    if (explicitPath !== null) return explicitPath
    const started = session.events.find((event) => event?.event === 'start')
    const reported = typeof started?.file === 'string' && started.file !== '' ? started.file : null
    return reported ?? outTemp
  }

  return {
    get out() {
      return resolveOut()
    },
    stream,
    stopFile,
    args,
    pid: session.pid,
    get stdio() {
      return session.stdio
    },
    outputBuffer: session.outputBuffer,
    events: session.events,
    levels: session.levels,
    lastLevel: session.lastLevel,
    settled: session.settled,
    kill: session.kill,
    wasAborted: () => aborted,
    async stop() {
      await requestStop(session, stopFile)
      return session.settled
    },
  }
}

/** Drop the stop flag of a finished capture. */
async function cleanupStopFile(session) {
  if (session !== null && typeof session?.stopFile === 'string' && session.stopFile !== '') {
    await rm(session.stopFile, { force: true })
  }
}

/** Remove the capture output, unless it was streamed instead of written. */
async function discardOut(session) {
  if (session?.stream === true) return
  await rm(session.out, { force: true })
}

/** Read a finished capture and describe it in a stable shape. */
export async function finishCapture(session, options = {}) {
  const result = await session.settled
  await cleanupStopFile(session)
  if (options.signal?.aborted || session.wasAborted?.() === true) {
    if (options.keep !== true) await discardOut(session)
    const abort = new Error('system-audio: capture aborted')
    abort.name = 'AbortError'
    throw abort
  }
  if (result.error) {
    if (options.keep !== true) await discardOut(session)
    throw result.error
  }
  if (!result.done) {
    if (options.keep !== true) await discardOut(session)
    throw new Error('system-audio: the recorder exited without a result (code ' +
      String(result.code) + ')' + (result.stderr === '' ? '' : ' — ' + result.stderr))
  }
  const done = result.done
  const streamed = session.stream === true
  const buffer = streamed ? session.outputBuffer() : null
  if (streamed && (buffer === null || buffer.length < 44)) {
    throw new Error('system-audio: the recorder streamed no audio (code ' +
      String(result.code) + ')' + (result.stderr === '' ? '' : ' — ' + result.stderr))
  }
  // The recorder patches the RIFF/data sizes when it stops on its own. A hard
  // kill leaves the placeholder zeros behind, so recompute them from the bytes
  // we actually received before handing the WAV to a decoder.
  if (streamed) repairWaveHeader(buffer)
  return {
    path: streamed ? null : session.out,
    stream: streamed,
    buffer,
    /** Every 100 ms `--levels` sample seen during the capture. */
    levels: session.levels.slice(),
    seconds: typeof done.seconds === 'number' ? done.seconds : 0,
    frames: typeof done.frames === 'number' ? done.frames : 0,
    bytes: typeof done.bytes === 'number' ? done.bytes : 0,
    rate: typeof done.rate === 'number' ? done.rate : DEFAULT_RATE,
    channels: typeof done.channels === 'number' ? done.channels : DEFAULT_CHANNELS,
    bits: typeof done.bits === 'number' ? done.bits : DEFAULT_BITS,
    rms: typeof done.rms === 'number' ? done.rms : 0,
    peak: typeof done.peak === 'number' ? done.peak : 0,
    silentStop: done.silentStop === true,
    converted: done.converted === true,
    device: typeof done.device === 'string' ? done.device : '',
  }
}

/** Capture one WAV file and return its description (path + stats). */
export async function captureOnce(options = {}) {
  const session = await startCapture(options)
  try {
    return await finishCapture(session, options)
  } catch (error) {
    if (options.keep !== true) await discardOut(session)
    throw error
  }
}

/** True when the failure is the sandbox refusing to create the child's pipes. */
function isPipeBlocked(error) {
  if (error === null || typeof error !== 'object') return false
  if (error.code === 'EPERM') return true
  return /EPERM|spawn EPERM/.test(String(error.message ?? ''))
}

/**
 * Start a capture, retrying file-backed when the environment forbids pipes.
 * Stream mode is preferred (the child writes nothing); a confined sandbox that
 * rejects the pipe spawn with EPERM falls back to a file inside the child's own
 * writable temp root. Callers that hold a live session should use this so the
 * long-running path degrades the same way `captureBytes` does.
 */
export async function startCaptureAuto(options = {}) {
  try {
    return await startCapture(options)
  } catch (error) {
    if (options.stdout === false || !isPipeBlocked(error)) throw error
    return await startCapture({ ...options, stdout: false })
  }
}

/**
 * The WAV bytes of a finished capture, whichever transport produced them, and
 * the temporary file removed afterwards.
 */
export async function captureWaveBytes(result, options = {}) {
  if (result?.stream === true) {
    const buffer = result.buffer ?? Buffer.alloc(0)
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  }
  if (typeof result?.path !== 'string' || result.path === '') {
    throw new Error('system-audio: the capture produced no WAV payload')
  }
  const bytes = await readCaptureBytes(result.path)
  if (options.keep !== true) await discardCapture(result.path)
  return bytes
}

/**
 * Capture one WAV and return it as bytes under `wav` (the numeric `bytes` field
 * of the capture stays the payload size), preferring stream mode so the child
 * process never writes a file. When the environment forbids the pipe (a
 * confined sandbox rejects the spawn with EPERM), the capture is retried
 * file-backed and the temporary file is deleted again unless `keep` is set.
 */
export async function captureBytes(options = {}) {
  const explicitOut = typeof options.out === 'string' && options.out.trim() !== ''
  if (options.stdout === false || explicitOut) {
    const done = await captureOnce(options)
    const wav = await readCaptureBytes(done.path)
    if (options.keep !== true) await discardCapture(done.path)
    return { ...done, wav }
  }
  try {
    const done = await captureOnce({ ...options, stdout: true, out: undefined })
    const buffer = done.buffer ?? Buffer.alloc(0)
    return { ...done, wav: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength) }
  } catch (error) {
    if (!isPipeBlocked(error)) throw error
    const done = await captureOnce({ ...options, stdout: false, out: undefined })
    const wav = await readCaptureBytes(done.path)
    if (options.keep !== true) await discardCapture(done.path)
    return { ...done, wav }
  }
}

/** Read a capture as the bytes the speech service consumes. */
export async function readCaptureBytes(path) {
  const buffer = await readFile(path)
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
}

/**
 * Recompute a canonical WAV's RIFF and `data` sizes from its real length, so a
 * capture that was killed before the recorder patched its header still decodes.
 * Returns the same buffer, patched in place.
 */
export function repairWaveHeader(buffer) {
  if (buffer === null || buffer === undefined || buffer.length < 44) return buffer
  const payload = buffer.length - 44
  if (buffer.readUInt32LE(40) === payload) return buffer
  buffer.writeUInt32LE(36 + payload, 4)
  buffer.writeUInt32LE(payload, 40)
  return buffer
}

/** Delete a capture file, ignoring a missing file. */
export async function discardCapture(path) {
  await rm(path, { force: true })
}
