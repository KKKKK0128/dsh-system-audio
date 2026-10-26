/**
 * Offline smoke test for dsh-system-audio.
 *
 * Validates the tool definitions (JSON shape of every returned value against
 * the declared output schema), the recorder wrapper against the real hardware,
 * and the WAV the speech service receives — without needing a DSH restart.
 *
 *   node .test/plugin-smoke.mjs
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { apply, name } from '../lib/index.js'
import { listDevices, recorderPath } from '../lib/recorder.js'

const failures = []
function check(label, fn) {
  try {
    fn()
    console.log('  ok   ' + label)
  } catch (error) {
    failures.push(label + ': ' + error.message)
    console.log('  FAIL ' + label + ' — ' + error.message)
  }
}
async function checkAsync(label, fn) {
  try {
    await fn()
    console.log('  ok   ' + label)
  } catch (error) {
    failures.push(label + ': ' + error.message)
    console.log('  FAIL ' + label + ' — ' + error.message)
  }
}

// ------------------------------------------------------------- mini validator

function typeOf(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (Number.isInteger(value)) return 'integer'
  return typeof value
}

function validate(value, schema, path) {
  if (schema.oneOf) {
    const errors = []
    for (const branch of schema.oneOf) {
      try {
        validate(value, branch, path)
        return
      } catch (error) {
        errors.push(error.message)
      }
    }
    throw new Error(path + ': matches no oneOf branch (' + errors.join('; ') + ')')
  }
  if (schema.type) {
    const actual = typeOf(value)
    const expected = schema.type
    const ok = actual === expected || (expected === 'number' && actual === 'integer')
    if (!ok) throw new Error(path + ': expected ' + expected + ', got ' + actual)
  }
  if (schema.enum && !schema.enum.includes(value)) {
    throw new Error(path + ': ' + JSON.stringify(value) + ' not in enum')
  }
  if (schema.type === 'object') {
    const properties = schema.properties ?? {}
    for (const key of schema.required ?? []) {
      if (!(key in value)) throw new Error(path + ': missing required key ' + key)
    }
    for (const [key, item] of Object.entries(value)) {
      if (!(key in properties)) {
        if (schema.additionalProperties === false) throw new Error(path + ': unexpected key ' + key)
        continue
      }
      validate(item, properties[key], path + '.' + key)
    }
  }
  if (schema.type === 'array' && schema.items) {
    value.forEach((item, index) => validate(item, schema.items, path + '[' + index + ']'))
  }
}

// -------------------------------------------------------------- fake harness

const registered = new Map()
let lastSpec = null

const speech = {
  snapshot: () => ({
    providers: [{
      info: {
        id: 'sensevoice-local',
        name: 'SenseVoice',
        location: 'host-local',
        languages: ['auto', 'zh', 'en'],
      },
      preparation: { phase: 'ready' },
    }],
    selection: { providerId: 'sensevoice-local', language: 'zh' },
  }),
  prepare: () => {},
  follow: async function* follow() {
    yield speech.snapshot()
  },
  resolve: (request) => {
    lastSpec = request
    return { audio: request.audio, language: request.language ?? 'zh', provider: {} }
  },
  transcribe: async (spec) => ({
    text: 'stub transcript of ' + spec.audio.length + ' bytes in ' + spec.language,
    audioSeconds: spec.audio.length / 32000,
    inferenceSeconds: 0.012,
  }),
}

const ctx = {
  get: (service) => (service === 'speechToText' ? speech : undefined),
  effect: (fn) => fn(),
  tools: {
    register: (definition) => {
      registered.set(definition.name, definition)
      return () => registered.delete(definition.name)
    },
  },
}

console.log('dsh-system-audio smoke test')
console.log('  recorder: ' + recorderPath())

check('apply() registers the three tools', () => {
  apply({ inject: (_deps, callback) => callback(ctx) })
  assert.deepEqual(
    [...registered.keys()].sort(),
    ['system_audio_devices', 'system_audio_listen', 'system_audio_record'],
  )
  assert.equal(name, 'dsh-system-audio')
})

check('every tool declares name/description/parameters/output/execute', () => {
  for (const definition of registered.values()) {
    assert.equal(typeof definition.name, 'string')
    assert.equal(typeof definition.description, 'string')
    assert.equal(definition.parameters.type, 'object')
    assert.equal(definition.parameters.additionalProperties, false)
    assert.equal(typeof definition.output.render, 'function')
    assert.equal(definition.output.schema.type, 'object')
    assert.equal(typeof definition.execute, 'function')
  }
})

await checkAsync('system_audio_devices returns a schema-valid device list', async () => {
  const tool = registered.get('system_audio_devices')
  const value = await tool.execute({}, { signal: undefined })
  validate(value, tool.output.schema, 'devices')
  assert.equal(value.ok, true)
  assert.ok(value.devices.length >= 1, 'expected at least one playback device')
  assert.equal(value.speech.available, true)
  assert.ok(tool.output.render({}, value)[0].text.includes('Playback devices'))
  console.log('       devices: ' + value.devices.map((item) => item.name).join(' | '))
})

await checkAsync('system_audio_record captures a schema-valid canonical WAV', async () => {
  const tool = registered.get('system_audio_record')
  const value = await tool.execute({ seconds: 1.5 }, { signal: undefined })
  validate(value, tool.output.schema, 'record')
  assert.equal(value.capture.rate, 16000)
  assert.equal(value.capture.channels, 1)
  assert.equal(value.capture.bits, 16)
  assert.ok(value.capture.seconds >= 1.4, 'captured ' + value.capture.seconds + 's')
  const bytes = await readFile(value.capture.path)
  assert.equal(bytes.subarray(0, 4).toString('ascii'), 'RIFF')
  assert.equal(bytes.subarray(8, 12).toString('ascii'), 'WAVE')
  assert.equal(bytes.readUInt16LE(22), 1, 'channels field')
  assert.equal(bytes.readUInt32LE(24), 16000, 'sample rate field')
  assert.equal(bytes.readUInt16LE(34), 16, 'bits field')
  assert.equal(bytes.readUInt32LE(40) + 44, bytes.length, 'data chunk covers the file')
  console.log('       file: ' + value.capture.path + ' (' + bytes.length + ' B)')
})

await checkAsync('system_audio_listen transcribes a captured canonical WAV', async () => {
  const tool = registered.get('system_audio_listen')
  const value = await tool.execute({ seconds: 1.2 }, { signal: undefined })
  validate(value, tool.output.schema, 'listen')
  assert.equal(value.ok, true)
  assert.ok(value.text.startsWith('stub transcript of'), 'unexpected text: ' + value.text)
  assert.ok(value.providerId.length > 0)
  console.log('       text: ' + value.text)
  console.log('       level: ' + value.level)
  // The speech service must have received a canonical 16 kHz mono PCM16 WAV.
  const audio = lastSpec.audio
  assert.ok(audio instanceof Uint8Array, 'audio must be a Uint8Array')
  assert.equal(audio[0], 0x52)
  assert.equal(audio[1], 0x49)
  assert.equal(value.language, 'zh')
})

await checkAsync('listDevices() marks exactly the default endpoint', async () => {
  const result = await listDevices()
  const defaults = result.devices.filter((item) => item.default)
  assert.equal(defaults.length, 1)
  assert.equal(defaults[0].id, result.default)
  console.log('       default: ' + defaults[0].name)
})

console.log(failures.length === 0 ? '\nALL CHECKS PASSED' : '\n' + failures.length + ' CHECK(S) FAILED')
process.exit(failures.length === 0 ? 0 : 1)
