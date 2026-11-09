import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { runInNewContext } from 'node:vm'

import { test } from 'vitest'

import {
  createWordMacAdapter,
  WORD_AUTOMATION_SCRIPT,
  type WordMacAdapterDependencies,
  type WordWindowSnapshot
} from './word-companion-mac'

const SNAPSHOT: WordWindowSnapshot = {
  windowNumber: 731,
  windowId: 42,
  topInset: 40,
  bounds: { x: 4, y: 28, width: 900, height: 700 },
  path: '/home/example/Documents/Proposal.docx',
  saved: false
}

function harness(response: unknown = { ok: true, ...SNAPSHOT }, preflightAutomation?: () => Promise<boolean>) {
  const calls: Array<{ file: string; args: readonly string[]; options: unknown }> = []

  const dependencies: WordMacAdapterDependencies = {
    preflightAutomation,
    execFile(file, args, options, callback) {
      calls.push({ file, args, options })
      callback(null, JSON.stringify(typeof response === 'function' ? response(args) : response), '')
    }
  }

  return { adapter: createWordMacAdapter(dependencies), calls }
}

test('enumeration is process-gated and preflight-gated before it can issue a Word Apple Event', async () => {
  let preflightCalls = 0

  const allowPreflight = async () => {
    preflightCalls += 1

    return true
  }

  const { adapter, calls } = harness((args: readonly string[]) => args.at(5) === 'status' ? { ok: true, running: true } : {
    ok: true,
    documents: [
      { path: SNAPSHOT.path, name: 'Proposal.docx', windowNumber: SNAPSHOT.windowNumber },
      { path: '/home/example/Documents/other/Proposal.docx', name: 'Proposal.docx', windowNumber: 732 }
    ]
  }, allowPreflight)

  assert.deepEqual(await adapter.listDocuments!(), [
    { path: SNAPSHOT.path, name: 'Proposal.docx', windowNumber: SNAPSHOT.windowNumber },
    { path: '/home/example/Documents/other/Proposal.docx', name: 'Proposal.docx', windowNumber: 732 }
  ])
  assert.equal(preflightCalls, 1)
  assert.deepEqual(calls.map(call => call.args.at(5)), ['status', 'list'])

  const denied = harness({ ok: true, running: true }).adapter
  await assert.rejects(denied.listDocuments!(), /WORD_AUTOMATION_DENIED/u)
})

test('bind preserves the exact requested Word view and bring-to-front never carries geometry', async () => {
  const { adapter, calls } = harness((args: readonly string[]) => {
    const operation = args.at(5)

    return operation === 'bind' ? { ok: true, ...SNAPSHOT } : { ok: true }
  })

  assert.deepEqual(await adapter.bind!(SNAPSHOT.path, SNAPSHOT.windowNumber), SNAPSHOT)
  assert.deepEqual(calls[0].args.slice(4), ['--', 'bind', SNAPSHOT.path, '731'])

  await adapter.bringToFront!(SNAPSHOT)
  assert.deepEqual(calls[1].args.slice(4), ['--', 'bring-to-front', SNAPSHOT.path, '731', '42', '40'])
})

test('opens an exact path using argv data, captures its Word window, and keeps source static', async () => {
  const path = '/home/example/Documents/quote "$(open /Applications/Calculator.app)"\nProposal.docx'
  const { adapter, calls } = harness({ ok: true, ...SNAPSHOT, path })
  const result = await adapter.open(path)

  assert.deepEqual(result, { ...SNAPSHOT, path })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].file, '/usr/bin/osascript')
  assert.deepEqual(calls[0].args.slice(0, 4), ['-l', 'JavaScript', '-e', WORD_AUTOMATION_SCRIPT])
  assert.deepEqual(calls[0].args.slice(4), ['--', 'open', path])
  assert.equal(WORD_AUTOMATION_SCRIPT.includes(path), false)
  assert.deepEqual(calls[0].options, { timeout: 15_000, maxBuffer: 1024 * 1024, windowsHide: true })
})

test('arrange, inspect, and restore carry the exact snapshot identity and only requested bounds', async () => {
  const target = { x: 950, y: 28, width: 850, height: 700 }
  const { adapter, calls } = harness({ ok: true, saved: true, bounds: target })

  await adapter.arrange(SNAPSHOT, target)
  assert.deepEqual(calls[0].args.slice(4), ['--', 'arrange', SNAPSHOT.path, '731', '42', '40', '950', '28', '850', '700'])

  assert.deepEqual(await adapter.inspect(SNAPSHOT), { saved: true })
  assert.deepEqual(calls[1].args.slice(4), ['--', 'inspect', SNAPSHOT.path, '731', '42', '40'])

  await adapter.restore(SNAPSHOT)
  assert.deepEqual(calls[2].args.slice(4), ['--', 'restore', SNAPSHOT.path, '731', '42', '40', '4', '28', '900', '700'])
})

test('maps scripted and process-level automation failures to stable recoverable codes', async () => {
  const denied = harness({ ok: false, code: 'WORD_AUTOMATION_DENIED' }).adapter
  await assert.rejects(denied.open(SNAPSHOT.path), error => error instanceof Error && error.message === 'WORD_AUTOMATION_DENIED')

  const calls: unknown[] = []

  const adapter = createWordMacAdapter({
    execFile(_file, _args, _options, callback) {
      calls.push(true)
      const error = Object.assign(new Error('execution error: Not authorized to send Apple events. (-1743)'), { code: 1 })
      callback(error, '', 'execution error: Not authorized to send Apple events. (-1743)')
    }
  })

  await assert.rejects(adapter.inspect(SNAPSHOT), error => error instanceof Error && error.message === 'WORD_AUTOMATION_DENIED')
  assert.equal(calls.length, 1)
})

test('rejects malformed output and invalid layout locally', async () => {
  const malformed = harness('not json').adapter
  await assert.rejects(malformed.open(SNAPSHOT.path), /WORD_AUTOMATION_FAILED/u)

  const { adapter, calls } = harness()
  await assert.rejects(adapter.arrange(SNAPSHOT, { x: 0, y: 0, width: 0, height: 10 }), /WORD_LAYOUT_FAILED/u)
  assert.equal(calls.length, 0)
})

test('rejects a Word bounds response when the requested arrangement was not applied', async () => {
  const adapter = harness({ ok: true, bounds: { x: 4, y: 28, width: 900, height: 700 } }).adapter

  await assert.rejects(adapter.arrange(SNAPSHOT, { x: 950, y: 28, width: 850, height: 700 }), /WORD_LAYOUT_FAILED/u)
})

test('normalizes Unicode only for full POSIX identity matching', async () => {
  const nfdPath = '/home/example/Documents/Cafe\u0301.docx'
  const nfcPath = '/home/example/Documents/Café.docx'
  const { adapter, calls } = harness({ ok: true, ...SNAPSHOT, path: nfcPath })

  const result = await adapter.open(nfdPath)

  assert.equal(calls[0].args.at(-1), nfcPath)
  assert.equal(result.path, nfcPath)
})

test('the bundled JXA program parses without contacting Microsoft Word', () => {
  assert.doesNotThrow(() => new Function(WORD_AUTOMATION_SCRIPT))
  assert.match(WORD_AUTOMATION_SCRIPT, /word\.open\(Path\(targetPath\), \{ revert: false \}\)/u)
  assert.match(WORD_AUTOMATION_SCRIPT, /URLForApplicationWithBundleIdentifier/u)
  assert.equal(WORD_AUTOMATION_SCRIPT.includes('Array.isArray(bounds)'), false)
  assert.equal(/\.save\s*\(/u.test(WORD_AUTOMATION_SCRIPT), false)
  assert.equal(/\.close\s*\(/u.test(WORD_AUTOMATION_SCRIPT), false)

  if (process.platform === 'darwin') {
    const args = ['/home/example/Documents/Cafe\u0301 中文 "quoted"\nreport.docx', '-1920', '25']

    const output = execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', WORD_AUTOMATION_SCRIPT, '--', 'verify-arguments', ...args], {
      encoding: 'utf8',
      timeout: 2_000,
      windowsHide: true
    })

    assert.deepEqual(JSON.parse(output), { ok: true, argv: args })
  }
})

test('native program keeps indexed references and uses Word view numbers when standard IDs are null', () => {
  let sleeps = 0
  let openOptions: unknown

  const document = {
    posixFullName: () => SNAPSHOT.path,
    saved: () => false,
    activeWindow: () => {throw Object.assign(new Error('No nested window'), { errorNumber: -1728 })}
  }

  const unrelated = { id: () => null, windowNumber: () => SNAPSHOT.windowNumber, document: { posixFullName: () => '/elsewhere/Proposal.docx' } }

  const target = { id: () => null, windowNumber: () => SNAPSHOT.windowNumber, document,
    leftPosition: () => SNAPSHOT.bounds.x, top: () => SNAPSHOT.bounds.y + SNAPSHOT.topInset,
    width: () => SNAPSHOT.bounds.width, height: () => SNAPSHOT.bounds.height }

  const word = {
    open: (_path: unknown, options: unknown) => {openOptions = options},
    activate: () => undefined,
    activeDocument: document,
    activeWindow: target,
    documents: [document],
    get windows() {return sleeps < 2 ? [unrelated] : [unrelated, target]}
  }

  const context = {
    ObjC: { import: () => undefined },
    $: { NSWorkspace: { sharedWorkspace: { URLForApplicationWithBundleIdentifier: () => ({}) } },
      NSThread: { sleepForTimeInterval: () => {sleeps += 1} } },
    Application: () => word,
    Path: (value: string) => value,
    nativeFrames: [{ id: SNAPSHOT.windowId, bounds: SNAPSHOT.bounds }],
    argv: ['open', SNAPSHOT.path]
  }

  const result = JSON.parse(runInNewContext(`${WORD_AUTOMATION_SCRIPT}\nfunction nativeWordWindows() { return nativeFrames }\nrun(argv)`, context))

  assert.deepEqual(result, { ok: true, ...SNAPSHOT })
  assert.equal(sleeps, 2)
  assert.deepEqual(JSON.parse(JSON.stringify(openOptions)), { revert: false })
})

test('native list and bind prove a background indexed document without reading activeDocument or activating Word', () => {
  const secondPath = '/home/example/Documents/elsewhere/Proposal.docx'
  let activations = 0
  const document = { posixFullName: () => SNAPSHOT.path, saved: () => false }
  const secondDocument = { posixFullName: () => secondPath, saved: () => true }

  const target = {
    document,
    windowNumber: () => SNAPSHOT.windowNumber,
    leftPosition: () => SNAPSHOT.bounds.x,
    top: () => SNAPSHOT.bounds.y + SNAPSHOT.topInset,
    width: () => SNAPSHOT.bounds.width,
    height: () => SNAPSHOT.bounds.height,
    activate: () => {activations += 1}
  }

  const second = {
    document: secondDocument,
    windowNumber: () => 732,
    leftPosition: () => 1000,
    top: () => 68,
    width: () => 500,
    height: () => 400,
    activate: () => {activations += 1}
  }

  const word = Object.defineProperties({
    documents: [document, secondDocument],
    windows: [target, second],
    activate: () => {activations += 1}
  }, {
    activeDocument: { get: () => {throw new Error('background probes must not read activeDocument')} },
    activeWindow: { get: () => {throw new Error('background probes must not read activeWindow')} }
  })

  const context = {
    ObjC: { import: () => undefined },
    $: {
      NSWorkspace: { sharedWorkspace: { URLForApplicationWithBundleIdentifier: () => ({}) } },
      NSRunningApplication: { runningApplicationsWithBundleIdentifier: () => ({ count: 1 }) }
    },
    Application: () => word,
    nativeFrames: [
      { id: SNAPSHOT.windowId, bounds: SNAPSHOT.bounds },
      { id: 43, bounds: { x: 1000, y: 28, width: 500, height: 400 } }
    ]
  }

  const run = (argv: string[]) => JSON.parse(runInNewContext(
    `${WORD_AUTOMATION_SCRIPT}\nfunction nativeWordWindows() { return nativeFrames }\nrun(argv)`, { ...context, argv }))

  assert.deepEqual(run(['list']), {
    ok: true,
    documents: [
      { path: SNAPSHOT.path, name: 'Proposal.docx', windowNumber: SNAPSHOT.windowNumber },
      { path: secondPath, name: 'Proposal.docx', windowNumber: 732 }
    ]
  })
  assert.deepEqual(run(['bind', SNAPSHOT.path, String(SNAPSHOT.windowNumber)]), { ok: true, ...SNAPSHOT })

  // A caller that omitted a view number cannot bind the first of two views.
  // It must reselect the precise indexed Word window.
  word.windows.push({
    document,
    windowNumber: () => 733,
    leftPosition: () => 400,
    top: () => 68,
    width: () => 500,
    height: () => 400,
    activate: () => {activations += 1}
  })
  context.nativeFrames.push({ id: 44, bounds: { x: 400, y: 28, width: 500, height: 400 } })
  assert.deepEqual(run(['bind', SNAPSHOT.path, '0']), { ok: false, code: 'WORD_DOCUMENT_UNAVAILABLE' })
  assert.equal(activations, 0)
})

test('native bring-to-front activates only the full verified document/window identity and leaves bounds alone', () => {
  let activated: string[] = []
  const frame = { ...SNAPSHOT.bounds }
  const document = { posixFullName: () => SNAPSHOT.path, saved: () => false, activate: () => {activated.push('document')} }

  const window = {
    document,
    windowNumber: () => SNAPSHOT.windowNumber,
    leftPosition: () => frame.x,
    top: () => frame.y + SNAPSHOT.topInset,
    width: () => frame.width,
    height: () => frame.height,
    activate: () => {activated.push('window')}
  }

  const word = {
    documents: [document], windows: [window], open: (target: string, options: { revert: boolean }) => {assert.equal(target, SNAPSHOT.path); assert.equal(options.revert, false); activated.push('existing-document')}, activate: () => {activated.push('word')},
    activeDocument: document, activeWindow: window
  }

  const result = JSON.parse(runInNewContext(
    `${WORD_AUTOMATION_SCRIPT}\nfunction nativeWordWindows() { return nativeFrames }\nrun(argv)`, {
      ObjC: { import: () => undefined },
      $: { NSWorkspace: { sharedWorkspace: { URLForApplicationWithBundleIdentifier: () => ({}) } },
        NSRunningApplication: { runningApplicationsWithBundleIdentifier: () => ({ count: 1 }) } },
      Path: (value: string) => value,
      Application: () => word,
      nativeFrames: [{ id: SNAPSHOT.windowId, bounds: frame }],
      argv: ['bring-to-front', SNAPSHOT.path, String(SNAPSHOT.windowNumber), String(SNAPSHOT.windowId), String(SNAPSHOT.topInset)]
    }))

  assert.deepEqual(result, { ok: true })
  assert.deepEqual(activated, ['existing-document', 'word'])
  assert.deepEqual(frame, SNAPSHOT.bounds)
})

test('native failure diagnostics exclude file paths and raw exception text', async () => {
  const messages: string[] = []

  const adapter = createWordMacAdapter({
    log: message => messages.push(message),
    execFile(_file, _args, _options, callback) {
      callback(null, JSON.stringify({ ok: false, code: 'WORD_LAYOUT_FAILED', stage: 'verify-bounds',
        requested: { ...SNAPSHOT.bounds, path: SNAPSHOT.path }, actual: SNAPSHOT.bounds,
        message: 'private document contents', path: SNAPSHOT.path }), '')
    }
  })

  await assert.rejects(adapter.arrange(SNAPSHOT, SNAPSHOT.bounds), /WORD_LAYOUT_FAILED/u)
  assert.equal(messages.length, 1)
  assert.match(messages[0], /verify-bounds/u)
  assert.equal(messages[0].includes(SNAPSHOT.path), false)
  assert.equal(messages[0].includes('private document contents'), false)
})

test('native arrangement changes only the exact Word view and verifies its independent OS window', () => {
  const frame = { ...SNAPSHOT.bounds }
  const reportedFrame = { ...frame }
  const otherFrame = { ...SNAPSHOT.bounds, x: 1000 }
  const document = { posixFullName: () => SNAPSHOT.path, saved: () => true }
  const otherDocument = { posixFullName: () => '/other/Proposal.docx', saved: () => true }

  const makeWindow = (doc: typeof document, bounds: typeof frame) => Object.defineProperties({
    document: doc, windowNumber: () => SNAPSHOT.windowNumber,
    bounds: () => {throw new Error('Inherited Cocoa bounds must not be used')}
  }, {
    leftPosition: { get: () => () => bounds.x, set: (value: number) => {bounds.x = value} },
    top: { get: () => () => bounds.y + SNAPSHOT.topInset, set: (value: number) => {bounds.y = value - SNAPSHOT.topInset} },
    width: { get: () => () => bounds.width, set: (value: number) => {bounds.width = value} },
    height: { get: () => () => bounds.height, set: (value: number) => {bounds.height = value} }
  })

  const word = { documents: [otherDocument, document], windows: [makeWindow(otherDocument, otherFrame), makeWindow(document, frame)] }
  const nativeFrames = [{ id: 99, bounds: otherFrame }, { id: SNAPSHOT.windowId, bounds: reportedFrame }]
  let delays = 0
  let pendingReads = 0

  const readFrames = () => {
    if (JSON.stringify(reportedFrame) !== JSON.stringify(frame) && ++pendingReads === 3) {
      Object.assign(reportedFrame, frame)
      pendingReads = 0
    }

    return nativeFrames
  }

  const run = (operation: string, id: number, target = frame) => JSON.parse(runInNewContext(
    `${WORD_AUTOMATION_SCRIPT}\nfunction nativeWordWindows() { return readFrames() }\nrun(argv)`, {
      ObjC: { import: () => undefined },
      $: { NSWorkspace: { sharedWorkspace: { URLForApplicationWithBundleIdentifier: () => ({}) } },
        NSRunningApplication: { runningApplicationsWithBundleIdentifier: () => ({ count: 1 }) },
        NSThread: { sleepForTimeInterval: () => {delays += 1} } },
      Application: () => word, readFrames,
      argv: [operation, SNAPSHOT.path, String(SNAPSHOT.windowNumber), String(id), String(SNAPSHOT.topInset),
        String(target.x), String(target.y), String(target.width), String(target.height)]
    }))

  const requested = { x: 800, y: -900, width: 750, height: 820 }

  assert.deepEqual(run('arrange', SNAPSHOT.windowId, requested), { ok: true, restored: false, bounds: requested })
  assert.deepEqual(frame, requested)
  assert.deepEqual(otherFrame, { ...SNAPSHOT.bounds, x: 1000 })
  // Word can reuse a view number after close/reopen; the old OS ID must not
  // address either the new view or an unrelated same-name window.
  assert.deepEqual(run('inspect', 100), { ok: false, code: 'WORD_DOCUMENT_UNAVAILABLE' })
  assert.deepEqual(run('restore', 99, SNAPSHOT.bounds), { ok: true, restored: false })
  assert.deepEqual(frame, requested)
  assert.deepEqual(otherFrame, { ...SNAPSHOT.bounds, x: 1000 })
  assert.deepEqual(run('restore', SNAPSHOT.windowId, SNAPSHOT.bounds), { ok: true, restored: true, bounds: SNAPSHOT.bounds })
  assert.equal(delays, 4)
})
