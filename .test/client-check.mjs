// Client-half checks. lib/client.js is loaded exactly like the browser module
// loader does, then rendered through a minimal hook runtime so the real click →
// start → poll → stop → insert-into-draft flow is exercised without a browser.
const checks = []
function check(label, run) {
  checks.push({ label, run })
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

// --- browser stubs ---------------------------------------------------------
const loads = []
globalThis.window = { __ModuleLoader__: { load: (entry) => loads.push(entry) } }

const styleNodes = []
const keyListeners = []
globalThis.document = {
  createElement: (tag) => ({ tag, textContent: '', setAttribute() {}, remove() {} }),
  head: { appendChild: (node) => styleNodes.push(node) },
  addEventListener: (type, listener) => { if (type === 'keydown') keyListeners.push(listener) },
  removeEventListener: (type, listener) => {
    if (type !== 'keydown') return
    const index = keyListeners.indexOf(listener)
    if (index >= 0) keyListeners.splice(index, 1)
  },
}

const copied = []
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { clipboard: { writeText: async (value) => { copied.push(value) } } },
})

const fetchLog = []
let statusPlan = []
globalThis.fetch = async (url, options = {}) => {
  const target = String(url)
  fetchLog.push({ url: target, options })
  const reply = (payload, status = 200) => ({
    status,
    ok: status < 400,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  })
  if (target.includes('/devices')) {
    return reply({
      ok: true,
      default: 'dev-default',
      devices: [
        { id: 'dev-default', name: '扬声器 (Senary Audio)', default: true },
        { id: 'dev-hdmi', name: 'HDMI Output', default: false },
      ],
      speech: { available: true, phase: 'standby' },
    })
  }
  if (target.includes('/start')) {
    return reply({ ok: true, id: 'capture-1', seconds: 120, transport: 'pipes', rate: 16000, channels: 1 })
  }
  if (target.includes('/status')) {
    return reply(statusPlan.shift() ?? { ok: true, state: 'recording', elapsed: 9, levels: [{ rms: 0.3 }] })
  }
  if (target.includes('/stop')) {
    return reply({ ok: true, text: 'captured speech', language: 'zh', rms: 0.28, peak: 0.4, seconds: 2.5 })
  }
  if (target.includes('/cancel')) return reply({ ok: true })
  return reply({ ok: true })
}

// --- minimal hook runtime --------------------------------------------------
// A React facade whose hook calls land in whichever component is rendering.
let currentRuntime = null

const ReactFacade = {
  Fragment: Symbol('Fragment'),
  createElement: (type, elementProps, ...children) => {
    const merged = { ...(elementProps ?? {}) }
    if (children.length === 1) merged.children = children[0]
    else if (children.length > 1) merged.children = children
    return { type, props: merged }
  },
  useState: (...args) => currentRuntime.useState(...args),
  useRef: (...args) => currentRuntime.useRef(...args),
  useCallback: (...args) => currentRuntime.useCallback(...args),
  useMemo: (...args) => currentRuntime.useMemo(...args),
  useEffect: (...args) => currentRuntime.useEffect(...args),
}

function sameDeps(previous, next) {
  if (previous === undefined || next === undefined) return false
  if (previous.length !== next.length) return false
  return previous.every((value, index) => Object.is(value, next[index]))
}

function createRuntime(Component, props) {
  const hooks = []
  let cursor = 0
  let scheduled = false
  let tree = null

  const schedule = () => {
    if (scheduled) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      render()
    })
  }

  const impl = {
    useState(initial) {
      const index = cursor++
      if (hooks[index] === undefined) {
        hooks[index] = { kind: 'state', value: typeof initial === 'function' ? initial() : initial }
      }
      const slot = hooks[index]
      return [slot.value, (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next
        if (Object.is(value, slot.value)) return
        slot.value = value
        schedule()
      }]
    },
    useRef(initial) {
      const index = cursor++
      if (hooks[index] === undefined) hooks[index] = { kind: 'ref', value: { current: initial } }
      return hooks[index].value
    },
    useCallback(fn, deps) {
      const index = cursor++
      const slot = hooks[index]
      if (slot === undefined || !sameDeps(slot.deps, deps)) hooks[index] = { kind: 'cb', deps, value: fn }
      return hooks[index].value
    },
    useMemo(fn, deps) {
      const index = cursor++
      const slot = hooks[index]
      if (slot === undefined || !sameDeps(slot.deps, deps)) hooks[index] = { kind: 'memo', deps, value: fn() }
      return hooks[index].value
    },
    useEffect(fn, deps) {
      const index = cursor++
      const slot = hooks[index]
      if (slot === undefined) hooks[index] = { kind: 'effect', deps, fn, dirty: true }
      else if (!sameDeps(slot.deps, deps)) {
        slot.deps = deps
        slot.fn = fn
        slot.dirty = true
      }
    },
  }

  function render() {
    currentRuntime = impl
    cursor = 0
    tree = Component(props)
    for (const slot of hooks) {
      if (slot?.kind !== 'effect' || slot.dirty !== true) continue
      slot.dirty = false
      if (typeof slot.cleanup === 'function') {
        try { slot.cleanup() } catch { /* ignore */ }
      }
      const cleanup = slot.fn()
      slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined
    }
    return tree
  }

  render()
  return {
    get tree() { return tree },
    render,
    unmount() {
      for (const slot of hooks) {
        if (slot?.kind === 'effect' && typeof slot.cleanup === 'function') {
          try { slot.cleanup() } catch { /* ignore */ }
          slot.cleanup = undefined
        }
      }
    },
  }
}

function walk(node, visit) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach((child) => walk(child, visit)); return }
  visit(node)
  walk(node.props?.children, visit)
}

function find(node, predicate) {
  let found = null
  walk(node, (candidate) => {
    if (found !== null) return
    if (predicate(candidate) === true) found = candidate
  })
  return found
}

function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.props?.children)
}

/** The row's main toggle: the first button that is neither the gear nor refresh. */
function mainButton(tree) {
  return find(tree, (node) => node.type === 'button'
    && typeof node.props?.onClick === 'function'
    && textOf(node) !== '⚙'
    && textOf(node) !== 'Refresh devices')
}

const tick = (ms = 30) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms))

// --- load the client half --------------------------------------------------
let clientModule = null
let slotRegistration = null
let localeRegistration = null

function makeProps(overrides = {}) {
  return {
    sessionId: 'session-1',
    inputActions: { captureInsertion: () => undefined, insertText: () => true },
    locked: false,
    onActiveChange: () => {},
    ...overrides,
  }
}

check('lib/client.js registers a module factory', async () => {
  await import(new URL('../lib/client.js', import.meta.url).href)
  assert(loads.length === 1, `expected one __ModuleLoader__.load call, got ${loads.length}`)
  assert(loads[0].id === 'dsh-system-audio', `unexpected client id: ${loads[0].id}`)
  assert(typeof loads[0].factory === 'function', 'factory must be a function')
  clientModule = loads[0].factory((specifier) => {
    if (specifier === 'react') return ReactFacade
    throw new Error(`unexpected require("${specifier}")`)
  })
  assert(typeof clientModule.apply === 'function', 'client module must export apply')
  assert(typeof clientModule.inject !== 'undefined', 'client module must export inject')
})

check('apply() registers the locale table and the CSS, and no longer registers any slot', () => {
  const registrations = []
  const ctx = {
    effect: (fn) => fn(),
    locale: { register: (ns, table) => { localeRegistration = { ns, table } } },
    slots: {
      inject: (_name, callback) => callback(),
      register: (spec, Component) => { registrations.push({ spec, Component }) },
    },
  }
  clientModule.apply(ctx)
  assert(localeRegistration !== null && localeRegistration.ns === 'dsh-system-audio', 'locale namespace mismatch')
  assert(typeof localeRegistration.table.zh === 'object' && typeof localeRegistration.table.en === 'object', 'expected zh and en strings')
  assert(styleNodes.length >= 1 && /dsh-system-audio/.test(styleNodes[0].textContent), 'expected injected CSS')
  // 录音按钮已按用户要求从输入框迁到「模拟面试模式」的侧边栏面板，因此这里必须一个槽位都不注册；
  // slotRegistration 保持 null，下面依赖它的用例会自动 skip（面板里的录一段并识别由
  // dsh-interview-mode 的 .test/client-check.mjs 覆盖）。
  assert(registrations.length === 0, `apply() must not register slots any more, got ${registrations.map((entry) => entry.spec.name).join(', ')}`)
  assert(slotRegistration === null, 'slotRegistration must stay null')
})

check('the toggle button renders no text, only its icon', () => {
  if (slotRegistration === null) return 'skip'
  const runtime = createRuntime(slotRegistration.Component, makeProps())
  const button = mainButton(runtime.tree)
  assert(button !== null, 'no toggle button in the rendered tree')
  assert(textOf(button).trim() === '🔊', `the toggle must render only its icon, got ${JSON.stringify(textOf(button))}`)
  const aria = button.props['aria-label']
  assert(typeof aria === 'string' && aria !== '', 'an icon-only toggle still needs an aria label')
  assert(button.props.title === aria, 'the tooltip and the aria label must agree')
  runtime.unmount()
})

check('click starts a capture, the poll stops it, the text lands in the draft', async () => {
  if (slotRegistration === null) return 'skip'
  fetchLog.length = 0
  const inserted = []
  const runtime = createRuntime(slotRegistration.Component, makeProps({
    inputActions: {
      captureInsertion: () => ({ from: 4, to: 4 }),
      insertText: (text, span) => { inserted.push({ text, span }); return true },
    },
  }))
  // First two polls: still recording. Third poll: the recorder already stopped.
  statusPlan = [
    { ok: true, state: 'recording', elapsed: 0.4, levels: [{ rms: 0.01 }] },
    { ok: true, state: 'recording', elapsed: 0.8, levels: [{ rms: 0.2 }, { rms: 0.4 }] },
    { ok: true, state: 'stopped', elapsed: 1.2, levels: [{ rms: 0.4 }] },
  ]

  const button = mainButton(runtime.tree)
  assert(button !== null, 'no start button in the rendered tree')
  await button.props.onClick()
  await tick(30)

  const started = fetchLog.find((entry) => entry.url.includes('/system-audio/start'))
  assert(started !== undefined, `no /start request (${fetchLog.map((entry) => entry.url).join(', ')})`)
  assert(started.options.method === 'POST', '/start must be a POST')
  const payload = JSON.parse(started.options.body)
  assert(payload.seconds === 120, `unexpected seconds: ${payload.seconds}`)
  assert(payload.device === undefined, 'no device must be sent by default')

  await tick(500)
  assert(fetchLog.some((entry) => entry.url.includes('/system-audio/status')), 'the client never polled the capture')
  assert(fetchLog.some((entry) => entry.url.includes('/system-audio/stop')), 'the poll never stopped the capture')
  assert(inserted.length === 1 && inserted[0].text === 'captured speech', `draft insert failed: ${JSON.stringify(inserted)}`)
  assert(inserted[0].span.from === 4, 'the insertion span must come from captureInsertion()')
  runtime.unmount()
})

check('the options panel lists devices, picks one and enables silence auto-stop', async () => {
  if (slotRegistration === null) return 'skip'
  fetchLog.length = 0
  statusPlan = []
  const runtime = createRuntime(slotRegistration.Component, makeProps())

  const gear = find(runtime.tree, (node) => node.type === 'button' && textOf(node) === '⚙')
  assert(gear !== null, 'no options button')
  await gear.props.onClick()
  await tick(60)

  assert(fetchLog.some((entry) => entry.url.includes('/system-audio/devices')), 'opening the options must load the device list')

  const select = find(runtime.tree, (node) => node.type === 'select')
  assert(select !== null, 'the options panel must render a device select')
  const options = Array.isArray(select.props.children) ? select.props.children : [select.props.children]
  assert(options.length === 3, `expected a default option plus two devices, got ${options.length}`)
  assert(String(textOf(options[1])).startsWith('★'), 'the default device must be marked')

  select.props.onChange({ target: { value: 'dev-hdmi' } })
  const checkbox = find(runtime.tree, (node) => node.type === 'input' && node.props?.type === 'checkbox')
  assert(checkbox !== null, 'no silence checkbox in the options panel')
  checkbox.props.onChange({ target: { checked: true } })
  await tick(60)

  const button = mainButton(runtime.tree)
  assert(button !== null, 'no start button after opening the options')
  await button.props.onClick()
  await tick(30)
  const started = fetchLog.find((entry) => entry.url.includes('/system-audio/start'))
  assert(started !== undefined, 'start was never requested')
  const payload = JSON.parse(started.options.body)
  assert(payload.device === 'dev-hdmi', `selected device was not sent: ${JSON.stringify(payload)}`)
  assert(payload.silenceMs === 1500, `silence auto-stop was not sent: ${JSON.stringify(payload)}`)
  runtime.unmount()
})

check('the in-app hotkey toggles a capture and unmounting cancels it', async () => {
  if (slotRegistration === null) return 'skip'
  fetchLog.length = 0
  statusPlan = []
  const runtime = createRuntime(slotRegistration.Component, makeProps())
  assert(keyListeners.length >= 1, 'the component must install a keydown listener')

  const press = (overrides) => {
    let prevented = false
    for (const listener of [...keyListeners]) {
      listener({
        key: 'y', ctrlKey: true, shiftKey: true, altKey: false, metaKey: false,
        defaultPrevented: false,
        preventDefault: () => { prevented = true },
        ...overrides,
      })
    }
    return prevented
  }

  press({ key: 'q' })
  await tick(20)
  assert(fetchLog.every((entry) => !entry.url.includes('/start')), 'a non-hotkey key must not start a capture')
  assert(press({}) === true, 'the hotkey must call preventDefault')
  await tick(30)
  assert(fetchLog.some((entry) => entry.url.includes('/system-audio/start')), 'the hotkey did not start a capture')

  runtime.unmount()
  await tick(30)
  assert(fetchLog.some((entry) => entry.url.includes('/system-audio/cancel')), 'unmount must cancel a live capture')
})

check('a failed insert falls back to the copy panel', async () => {
  if (slotRegistration === null) return 'skip'
  fetchLog.length = 0
  statusPlan = [{ ok: true, state: 'stopped', elapsed: 0.2, levels: [] }]
  copied.length = 0
  const runtime = createRuntime(slotRegistration.Component, makeProps({
    inputActions: { captureInsertion: () => undefined, insertText: () => false },
  }))
  await mainButton(runtime.tree).props.onClick()
  await tick(400)

  const textarea = find(runtime.tree, (node) => node.type === 'textarea')
  assert(textarea !== null, 'the manual panel must appear when the draft insert fails')
  assert(textarea.props.value === 'captured speech', `unexpected panel text: ${textarea.props.value}`)
  const copyButton = find(runtime.tree, (node) => node.type === 'button' && textOf(node) === 'Copy text')
  assert(copyButton !== null, 'no copy button in the manual panel')
  await copyButton.props.onClick()
  await tick(20)
  assert(copied.length === 1 && copied[0] === 'captured speech', `clipboard write failed: ${JSON.stringify(copied)}`)
  runtime.unmount()
})

let failed = 0
for (const item of checks) {
  try {
    const result = await item.run()
    if (result === 'skip') {
      console.log('  skip', item.label)
      continue
    }
    console.log('  ok  ', item.label)
  } catch (error) {
    failed += 1
    console.log('  FAIL', item.label, '→', error instanceof Error ? error.message : String(error))
  }
}

console.log(failed === 0 ? '\nALL CLIENT CHECKS PASSED' : `\n${failed} CLIENT CHECK(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)
