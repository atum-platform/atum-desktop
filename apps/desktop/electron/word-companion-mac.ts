// Native Microsoft Word companion for macOS. This module deliberately keeps
// the automation program fixed: document paths and geometry are argv data to
// osascript, never interpolated into executable source.

import { execFile as nodeExecFile } from 'node:child_process'

export interface WordBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface WordWindowSnapshot {
  windowNumber: number
  windowId: number
  topInset: number
  bounds: WordBounds
  path: string
  saved: boolean
}

export type WordMacAdapterErrorCode =
  | 'WORD_NOT_INSTALLED'
  | 'WORD_AUTOMATION_DENIED'
  | 'WORD_DOCUMENT_UNAVAILABLE'
  | 'WORD_LAYOUT_FAILED'
  | 'WORD_AUTOMATION_TIMEOUT'
  | 'WORD_AUTOMATION_FAILED'

export class WordMacAdapterError extends Error {
  readonly code: WordMacAdapterErrorCode

  constructor(code: WordMacAdapterErrorCode) {
    super(code)
    this.name = 'WordMacAdapterError'
    this.code = code
  }
}

export interface WordMacAdapter {
  open(path: string): Promise<WordWindowSnapshot>
  /** Enumerates only already-open saved documents; never launches or activates Word. */
  listDocuments?(): Promise<Array<{ path: string; name: string; windowNumber: number }>>
  /** Proves an already-open document/window without changing Word's foreground state. */
  bind?(path: string, windowNumber?: number): Promise<WordWindowSnapshot>
  /** Explicit user action: activate the previously proven document/window, without moving it. */
  bringToFront?(snapshot: WordWindowSnapshot): Promise<void>
  arrange(snapshot: WordWindowSnapshot, bounds: WordBounds): Promise<void>
  inspect(snapshot: WordWindowSnapshot): Promise<{ saved: boolean }>
  restore(snapshot: WordWindowSnapshot): Promise<void>
}

type ExecFileCallback = (error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => void
type ExecFile = (
  file: string,
  args: readonly string[],
  options: { timeout: number; maxBuffer: number; windowsHide: boolean },
  callback: ExecFileCallback
) => unknown

export interface WordMacAdapterDependencies {
  execFile?: ExecFile
  log?: (message: string) => void
  /**
   * The packaged app must provide a native AEDeterminePermissionToAutomateTarget
   * preflight with askUserIfNeeded=false before document enumeration. JXA cannot
   * safely bridge AEDesc pointers, so the default deliberately denies listing
   * instead of probing Word with an Apple Event that could show a TCC prompt.
   */
  preflightAutomation?: () => Promise<boolean>
}

const AUTOMATION_TIMEOUT_MS = 15_000
const AUTOMATION_MAX_BUFFER = 1024 * 1024
const WORD_BUNDLE_ID = 'com.microsoft.Word'
const BOUNDS_TOLERANCE = 2

// `run(argv)` is osascript's argument entry point. It deliberately has no
// shell calls: `osascript` receives this source with `-e` and the data after
// `--` as separate argv entries.
export const WORD_AUTOMATION_SCRIPT = String.raw`
ObjC.import('AppKit')
ObjC.import('CoreGraphics')

const WORD_BUNDLE_ID = 'com.microsoft.Word'

function output(value) {
  return JSON.stringify(value)
}

function automationError(error) {
  const number = Number(error && error.errorNumber)
  const message = String((error && error.message) || error || '')

  if (number === -10814 || /application isn't found|application not found/i.test(message)) {
    return 'WORD_NOT_INSTALLED'
  }

  if (number === -1743 || /not authorized to send apple events|automation permission/i.test(message)) {
    return 'WORD_AUTOMATION_DENIED'
  }

  if (number === -43 || number === -600 || number === -609 || number === -1728) {
    return 'WORD_DOCUMENT_UNAVAILABLE'
  }

  return 'WORD_AUTOMATION_FAILED'
}

function wordIsRunning() {
  return Number($.NSRunningApplication.runningApplicationsWithBundleIdentifier(WORD_BUNDLE_ID).count) > 0
}

function wordIsInstalled() {
  const applicationUrl = $.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier(WORD_BUNDLE_ID)

  return applicationUrl !== null && applicationUrl !== undefined
}

function wordApplication() {
  return Application(WORD_BUNDLE_ID)
}

function normalizePath(value) {
  return String(value).normalize('NFC')
}

function documentPath(documentRef) {
  return normalizePath(documentRef.posixFullName())
}

function findDocument(word, targetPath) {
  // Keep indexed object specifiers. Evaluating a collection with () turns
  // Word's results into name-based references, which are ambiguous for twins.
  for (let index = 0; index < word.documents.length; index += 1) {
    const documentRef = word.documents[index]

    if (documentPath(documentRef) === targetPath) {
      return documentRef
    }
  }

  return null
}

function findWindow(word, targetPath, targetWindowNumber) {
  for (let index = 0; index < word.windows.length; index += 1) {
    const candidate = word.windows[index]

    try {
      if ((targetWindowNumber === undefined || Number(candidate.windowNumber()) === targetWindowNumber) && documentPath(candidate.document) === targetPath) {
        return candidate
      }
    } catch (_) {
      // Word can expose non-document windows in its top-level collection.
    }
  }

  return null
}

function findUniqueWindow(word, targetPath) {
  let match = null
  for (let index = 0; index < word.windows.length; index += 1) {
    const candidate = word.windows[index]

    try {
      if (documentPath(candidate.document) !== targetPath) { continue }
      // A path alone is not a window identity when Word exposes two views of
      // one document. The caller must select a numbered candidate in that case.
      if (match) { return null }
      match = candidate
    } catch (_) {
      // Word can expose non-document windows in its top-level collection.
    }
  }

  return match
}

function nativeWordWindows() {
  const applications = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(WORD_BUNDLE_ID)
  if (!Number(applications.count)) { return [] }
  const pid = Number(applications.objectAtIndex(0).processIdentifier)
  const raw = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll, $.kCGNullWindowID)
  const windows = ObjC.deepUnwrap(ObjC.castRefToObject(raw))

  // Only public window metadata: never names, images or screen capture. These
  // IDs and frames are available without Screen Recording or Accessibility.
  return windows.filter(value => value.kCGWindowOwnerPID === pid && value.kCGWindowLayer === 0).map(value => ({
    id: value.kCGWindowNumber,
    bounds: { x: value.kCGWindowBounds.X, y: value.kCGWindowBounds.Y,
      width: value.kCGWindowBounds.Width, height: value.kCGWindowBounds.Height }
  }))
}

function wordBounds(windowRef, topInset) {
  return { x: Number(windowRef.leftPosition()), y: Number(windowRef.top()) - topInset,
    width: Number(windowRef.width()), height: Number(windowRef.height()) }
}

function validBounds(bounds) {
  return bounds && [bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) && bounds.width > 0 && bounds.height > 0
}

function setBounds(windowRef, bounds, topInset) {
  if (!validBounds(bounds)) {
    const error = new Error('Invalid requested bounds')
    error.errorNumber = -50
    throw error
  }

  // Word's inherited Cocoa bounds/position properties can resolve a different
  // same-title window. Its own geometry properties retain document identity.
  windowRef.width = bounds.width
  windowRef.height = bounds.height
  windowRef.leftPosition = bounds.x
  windowRef.top = bounds.y + topInset
}

function sameBounds(actual, expected) {
  return Math.abs(actual.x - expected.x) <= 2 &&
    Math.abs(actual.y - expected.y) <= 2 &&
    Math.abs(actual.width - expected.width) <= 2 &&
    Math.abs(actual.height - expected.height) <= 2
}

function settledNativeBounds(windowId, expected) {
  let actual
  // Word acknowledges geometry setters before Window Server publishes the
  // new frame. Poll the readback only; never repeat the move or relax accuracy.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    actual = nativeWordWindows().find(value => value.id === windowId)?.bounds
    if (actual && sameBounds(actual, expected)) { return actual }
    $.NSThread.sleepForTimeInterval(0.05)
  }
  return actual
}

function snapshot(word, documentRef, windowRef, targetPath) {
  const identity = identitySnapshot(word, documentRef, windowRef, targetPath)
  // Opening is deliberately activation-dependent. The bind flow below uses
  // identitySnapshot directly so a picker never steals the foreground.
  if (documentPath(word.activeDocument) !== targetPath ||
    Number(word.activeWindow.windowNumber()) !== identity.windowNumber) {
    const error = new Error('Word window is not active')
    error.errorNumber = -1728
    throw error
  }
  return identity
}

function identitySnapshot(word, documentRef, windowRef, targetPath) {
  if (documentPath(documentRef) !== targetPath) {
    const error = new Error('Word opened a different document')
    error.errorNumber = -1728
    throw error
  }

  const windowNumber = Number(windowRef.windowNumber())
  const position = wordBounds(windowRef, 0)
  const candidates = nativeWordWindows().filter(value =>
    Math.abs(value.bounds.x - position.x) <= 2 &&
    Math.abs(value.bounds.width - position.width) <= 2 &&
    Math.abs(value.bounds.height - position.height) <= 2 &&
    position.y - value.bounds.y >= 0 && position.y - value.bounds.y <= 200)
  const native = candidates.length === 1 ? candidates[0] : null
  const topInset = native ? Number(windowRef.top()) - native.bounds.y : NaN
  // Prove the indexed document/view against independent Window Server geometry.
  // This deliberately makes no activeDocument or activeWindow query: bind must
  // work for a background document without changing focus. Refuse an ambiguous
  // match; never choose a window by title or list order.
  if (!native ||
    !Number.isFinite(topInset) || Math.abs(topInset) > 200 ||
    !sameBounds(wordBounds(windowRef, topInset), native.bounds)) {
    const error = new Error('Word window is not ready')
    error.errorNumber = -1728
    throw error
  }

  return {
    ok: true,
    windowNumber,
    windowId: native.id,
    topInset,
    bounds: native.bounds,
    path: targetPath,
    saved: Boolean(documentRef.saved())
  }
}

function unavailable() {
  return { ok: false, code: 'WORD_DOCUMENT_UNAVAILABLE' }
}

function openedSnapshot(word, targetPath) {
  // Word can return from open before its document window is ready. Resolve a
  // top-level window by exact document path. Word's own ID property is null;
  // pair its view number with the Window Server's stable ID instead.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const documentRef = findDocument(word, targetPath)
      const windowRef = findWindow(word, targetPath)

      if (documentRef && windowRef) {
        return snapshot(word, documentRef, windowRef, targetPath)
      }
    } catch (error) {
      if (automationError(error) !== 'WORD_DOCUMENT_UNAVAILABLE') { throw error }
    }

    $.NSThread.sleepForTimeInterval(0.1)
  }

  return unavailable()
}

function listedDocuments(word) {
  const documents = []
  // Iterate the native indexed window collection. A document can have multiple
  // Word views; keeping each view number prevents a same-title document from
  // becoming an authority token for a different window.
  for (let index = 0; index < word.windows.length; index += 1) {
    try {
      const windowRef = word.windows[index]
      const targetPath = documentPath(windowRef.document)
      const windowNumber = Number(windowRef.windowNumber())
      if (!targetPath || !Number.isInteger(windowNumber) || windowNumber < 1) { continue }
      const documentRef = findDocument(word, targetPath)
      if (!documentRef) { continue }
      identitySnapshot(word, documentRef, windowRef, targetPath)
      const slash = targetPath.lastIndexOf('/')
      documents.push({ path: targetPath, name: slash >= 0 ? targetPath.slice(slash + 1) : targetPath, windowNumber })
    } catch (_) {
      // A transient/non-document Word window is not a document candidate.
    }
  }
  return { ok: true, documents }
}

function automationResult(argv) {
  let stage = 'preflight'
  try {
    const operation = argv[0]

    // Exercise the real osascript argument boundary without any Apple Event.
    if (operation === 'verify-arguments') {
      return { ok: true, argv: argv.slice(1) }
    }

    if (operation === 'open') {
      const targetPath = normalizePath(argv[1] || '')

      if (!targetPath) {
        return unavailable()
      }

      // NSWorkspace checks the bundle without using an Apple Event or asking
      // JXA to resolve an application selector that does not exist.
      if (!wordIsInstalled()) {
        return { ok: false, code: 'WORD_NOT_INSTALLED' }
      }

      const word = wordApplication()
      stage = 'open'
      word.open(Path(targetPath), { revert: false })
      word.activate()

      stage = 'snapshot'
      return openedSnapshot(word, targetPath)
    }

    // This operation uses only NSWorkspace process metadata. It is safe before
    // automation authorization and cannot activate or launch Word.
    if (operation === 'status') {
      return { ok: true, running: wordIsRunning() }
    }

    if (operation === 'list') {
      // The caller must have completed the native no-prompt permission
      // preflight before reaching this Apple Event path.
      if (!wordIsRunning()) { return unavailable() }
      const word = wordApplication()
      stage = 'list'
      return listedDocuments(word)
    }

    if (operation === 'bind' || operation === 'inspect' || operation === 'arrange' || operation === 'restore' || operation === 'bring-to-front') {
      const targetPath = normalizePath(argv[1] || '')
      const binding = operation === 'bind'
      const requestedWindowNumber = Number(argv[2])
      const targetWindowNumber = binding && requestedWindowNumber === 0 ? undefined : requestedWindowNumber
      const targetWindowId = Number(argv[3])
      const topInset = Number(argv[4])

      // Inspect, arrange and restore must never revive a Word process after a
      // user quit it. This check uses NSWorkspace rather than Apple Events.
      if (!targetPath ||
        (binding ? (targetWindowNumber !== undefined && (!Number.isInteger(targetWindowNumber) || targetWindowNumber < 1)) :
          (!Number.isInteger(targetWindowNumber) || targetWindowNumber < 1 || !Number.isInteger(targetWindowId) || targetWindowId < 1 ||
            !Number.isFinite(topInset) || Math.abs(topInset) > 200))) {
        return operation === 'restore' ? { ok: true, restored: false } : unavailable()
      }

      if (!wordIsInstalled()) {
        return operation === 'restore' ? { ok: true, restored: false } : { ok: false, code: 'WORD_NOT_INSTALLED' }
      }

      if (!wordIsRunning()) {
        return operation === 'restore' ? { ok: true, restored: false } : unavailable()
      }

      const word = wordApplication()
      stage = 'find-document'
      const documentRef = findDocument(word, targetPath)
      stage = 'find-window'
      const windowRef = binding && targetWindowNumber === undefined ? findUniqueWindow(word, targetPath) :
        findWindow(word, targetPath, targetWindowNumber)
      const native = binding ? null : nativeWordWindows().find(value => value.id === targetWindowId)

      if (!documentRef || !windowRef || (!binding && (!native || !sameBounds(wordBounds(windowRef, topInset), native.bounds)))) {
        return operation === 'restore' ? { ok: true, restored: false } : unavailable()
      }

      if (binding) {
        stage = 'bind'
        return identitySnapshot(word, documentRef, windowRef, targetPath)
      }

      if (operation === 'inspect') {
        return { ok: true, saved: Boolean(documentRef.saved()) }
      }

      if (operation === 'bring-to-front') {
        // This is only reached from an explicit user action. Do not adjust any
        // geometry; prove the exact indexed view before and after activation.
        stage = 'activate'
        // Word documents open(revert:false) as activating an already-open
        // document without discarding its unsaved text. The exact document and
        // native view were proved above and are checked again below.
        word.open(Path(targetPath), { revert: false })
        word.activate()
        stage = 'verify-active'
        // Activation finishes asynchronously in Word. Re-resolve each indexed
        // view while waiting, and retain the same path/native-id/frame proof.
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const verifiedWindow = findWindow(word, targetPath, targetWindowNumber)
          const activeNative = nativeWordWindows().find(value => value.id === targetWindowId)
          if (!verifiedWindow || !activeNative || !sameBounds(activeNative.bounds, native.bounds) ||
            !sameBounds(wordBounds(verifiedWindow, topInset), activeNative.bounds)) { return unavailable() }
          if (documentPath(word.activeDocument) === targetPath && Number(word.activeWindow.windowNumber()) === targetWindowNumber) {
            return { ok: true }
          }
          $.NSThread.sleepForTimeInterval(0.1)
        }
        return unavailable()
      }

      const bounds = {
        x: Number(argv[5]),
        y: Number(argv[6]),
        width: Number(argv[7]),
        height: Number(argv[8])
      }

      try {
        stage = 'set-bounds'
        setBounds(windowRef, bounds, topInset)
        stage = 'read-bounds'
        const appliedBounds = settledNativeBounds(targetWindowId, bounds)

        if (!appliedBounds || !sameBounds(appliedBounds, bounds)) {
          return { ok: false, code: 'WORD_LAYOUT_FAILED', stage: 'verify-bounds', requested: bounds, actual: appliedBounds }
        }

        return { ok: true, restored: operation === 'restore', bounds: appliedBounds }
      } catch (error) {
        return { ok: false, code: 'WORD_LAYOUT_FAILED', stage, nativeErrorNumber: Number(error && error.errorNumber) }
      }
    }

    return { ok: false, code: 'WORD_AUTOMATION_FAILED' }
  } catch (error) {
    return { ok: false, code: automationError(error), stage, nativeErrorNumber: Number(error && error.errorNumber) }
  }
}

function run(argv) {
  return output(automationResult(argv))
}
`

function isErrorCode(value: unknown): value is WordMacAdapterErrorCode {
  return typeof value === 'string' && [
    'WORD_NOT_INSTALLED',
    'WORD_AUTOMATION_DENIED',
    'WORD_DOCUMENT_UNAVAILABLE',
    'WORD_LAYOUT_FAILED',
    'WORD_AUTOMATION_TIMEOUT',
    'WORD_AUTOMATION_FAILED'
  ].includes(value)
}

function errorCodeFromProcess(error: Error & { code?: unknown; killed?: unknown; signal?: unknown; stderr?: unknown }): WordMacAdapterErrorCode {
  const message = `${error.message || ''}\n${String(error.stderr || '')}`

  if (error.killed || error.signal === 'SIGTERM' || error.code === 'ETIMEDOUT') {
    return 'WORD_AUTOMATION_TIMEOUT'
  }

  if (/\b-10814\b|application isn't found|application not found/iu.test(message)) {
    return 'WORD_NOT_INSTALLED'
  }

  if (/\b-1743\b|not authorized to send apple events|automation permission/iu.test(message)) {
    return 'WORD_AUTOMATION_DENIED'
  }

  if (/\b-43\b|\b-600\b|\b-609\b|\b-1728\b/iu.test(message)) {
    return 'WORD_DOCUMENT_UNAVAILABLE'
  }

  return 'WORD_AUTOMATION_FAILED'
}

function requireBounds(value: unknown): asserts value is WordBounds {
  const bounds = value as WordBounds

  if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0) {
    throw new WordMacAdapterError('WORD_LAYOUT_FAILED')
  }
}

function normalizeWordPath(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/')) {
    throw new WordMacAdapterError('WORD_DOCUMENT_UNAVAILABLE')
  }

  return value.normalize('NFC')
}

function boundsApproximatelyEqual(actual: WordBounds, expected: WordBounds): boolean {
  return [
    Math.abs(actual.x - expected.x),
    Math.abs(actual.y - expected.y),
    Math.abs(actual.width - expected.width),
    Math.abs(actual.height - expected.height)
  ].every(delta => delta <= BOUNDS_TOLERANCE)
}

function parseJson(stdout: string | Buffer): Record<string, unknown> {
  try {
    const response = JSON.parse(String(stdout || ''))

    if (!response || typeof response !== 'object' || Array.isArray(response)) {
      throw new Error('Not an object')
    }

    return response as Record<string, unknown>
  } catch {
    throw new WordMacAdapterError('WORD_AUTOMATION_FAILED')
  }
}

function snapshotFromResponse(response: Record<string, unknown>): WordWindowSnapshot {
  const bounds = response.bounds as WordBounds

  if (
    typeof response.windowNumber !== 'number' ||
    !Number.isInteger(response.windowNumber) || response.windowNumber < 1 ||
    typeof response.windowId !== 'number' || !Number.isInteger(response.windowId) || response.windowId < 1 ||
    typeof response.topInset !== 'number' || !Number.isFinite(response.topInset) || Math.abs(response.topInset) > 200 ||
    typeof response.path !== 'string' ||
    typeof response.saved !== 'boolean'
  ) {
    throw new WordMacAdapterError('WORD_AUTOMATION_FAILED')
  }

  requireBounds(bounds)

  return { windowNumber: response.windowNumber, windowId: response.windowId, topInset: response.topInset,
    bounds, path: response.path, saved: response.saved }
}

/**
 * Creates the narrowly scoped macOS Word companion adapter. The optional
 * dependency is test-only plumbing; production calls /usr/bin/osascript.
 */
export function createWordMacAdapter(dependencies: WordMacAdapterDependencies = {}): WordMacAdapter {
  const execFile = dependencies.execFile ?? (nodeExecFile as unknown as ExecFile)

  const execute = async (operation: string, input: readonly string[]): Promise<Record<string, unknown>> => {
    const stdout = await new Promise<string | Buffer>((resolve, reject) => {
      execFile(
        '/usr/bin/osascript',
        ['-l', 'JavaScript', '-e', WORD_AUTOMATION_SCRIPT, '--', operation, ...input],
        { timeout: AUTOMATION_TIMEOUT_MS, maxBuffer: AUTOMATION_MAX_BUFFER, windowsHide: true },
        (error, result, stderr) => {
          if (error) {
            ;(error as Error & { stderr?: string | Buffer }).stderr = stderr
            reject(error)

            return
          }

          resolve(result)
        }
      )
    }).catch(error => {
      throw new WordMacAdapterError(errorCodeFromProcess(error as Error & { code?: unknown; killed?: unknown; signal?: unknown; stderr?: unknown }))
    })

    const response = parseJson(stdout)

    if (response.ok !== true) {
      // Only bounded operation/geometry diagnostics; never log document paths,
      // Word's raw exception text, or document contents.
      const geometry = (value: unknown) => {
        try {
          requireBounds(value)

          return { x: value.x, y: value.y, width: value.width, height: value.height }
        } catch {return undefined}
      }

      dependencies.log?.(`[word-companion] Native operation failed ${JSON.stringify({
        operation,
        code: isErrorCode(response.code) ? response.code : 'WORD_AUTOMATION_FAILED',
        stage: ['preflight', 'open', 'find-document', 'snapshot', 'find-window', 'set-bounds', 'read-bounds', 'verify-bounds'].includes(String(response.stage)) ? response.stage : undefined,
        nativeErrorNumber: typeof response.nativeErrorNumber === 'number' ? response.nativeErrorNumber : undefined,
        requested: geometry(response.requested),
        actual: geometry(response.actual)
      })}`)
      throw new WordMacAdapterError(isErrorCode(response.code) ? response.code : 'WORD_AUTOMATION_FAILED')
    }

    return response
  }

  return {
    async open(path) {
      const targetPath = normalizeWordPath(path)
      const response = await execute('open', [targetPath])
      const snapshot = snapshotFromResponse(response)

      if (normalizeWordPath(snapshot.path) !== targetPath) {
        throw new WordMacAdapterError('WORD_DOCUMENT_UNAVAILABLE')
      }

      return { ...snapshot, path: targetPath }
    },

    async listDocuments() {
      // Avoid creating an Application() selector until both process state and
      // a native askUserIfNeeded=false preflight prove enumeration is safe.
      const status = await execute('status', [])

      if (status.running !== true) {return []}

      const permitted = await (dependencies.preflightAutomation?.() ?? Promise.resolve(false))

      if (!permitted) {throw new WordMacAdapterError('WORD_AUTOMATION_DENIED')}

      const response = await execute('list', [])

      if (!Array.isArray(response.documents)) {throw new WordMacAdapterError('WORD_AUTOMATION_FAILED')}

      const seen = new Set<string>()
      const documents: Array<{ path: string; name: string; windowNumber: number }> = []

      for (const value of response.documents) {
        if (!value || typeof value !== 'object') {throw new WordMacAdapterError('WORD_AUTOMATION_FAILED')}
        const candidate = value as Record<string, unknown>
        const path = normalizeWordPath(candidate.path)
        const name = candidate.name
        const windowNumber = candidate.windowNumber

        if (typeof name !== 'string' || !name || typeof windowNumber !== 'number' || !Number.isInteger(windowNumber) || windowNumber < 1) {
          throw new WordMacAdapterError('WORD_AUTOMATION_FAILED')
        }

        const key = `${path}\u0000${windowNumber}`

        if (!seen.has(key)) {
          seen.add(key)
          documents.push({ path, name, windowNumber })
        }
      }

      return documents
    },

    async bind(path, windowNumber) {
      const targetPath = normalizeWordPath(path)

      if (windowNumber !== undefined && (!Number.isInteger(windowNumber) || windowNumber < 1)) {
        throw new WordMacAdapterError('WORD_DOCUMENT_UNAVAILABLE')
      }

      const response = await execute('bind', [targetPath, String(windowNumber ?? 0)])
      const snapshot = snapshotFromResponse(response)

      if (normalizeWordPath(snapshot.path) !== targetPath ||
        (windowNumber !== undefined && snapshot.windowNumber !== windowNumber)) {
        throw new WordMacAdapterError('WORD_DOCUMENT_UNAVAILABLE')
      }

      return { ...snapshot, path: targetPath }
    },

    async bringToFront(snapshot) {
      await execute('bring-to-front', [normalizeWordPath(snapshot.path), String(snapshot.windowNumber),
        String(snapshot.windowId), String(snapshot.topInset)])
    },

    async arrange(snapshot, bounds) {
      requireBounds(bounds)

      const response = await execute('arrange', [
        normalizeWordPath(snapshot.path),
        String(snapshot.windowNumber),
        String(snapshot.windowId),
        String(snapshot.topInset),
        String(bounds.x),
        String(bounds.y),
        String(bounds.width),
        String(bounds.height)
      ])

      const appliedBounds = response.bounds as WordBounds

      try {
        requireBounds(appliedBounds)
      } catch {
        throw new WordMacAdapterError('WORD_LAYOUT_FAILED')
      }

      if (!boundsApproximatelyEqual(appliedBounds, bounds)) {
        throw new WordMacAdapterError('WORD_LAYOUT_FAILED')
      }
    },

    async inspect(snapshot) {
      const response = await execute('inspect', [normalizeWordPath(snapshot.path), String(snapshot.windowNumber),
        String(snapshot.windowId), String(snapshot.topInset)])

      if (typeof response.saved !== 'boolean') {
        throw new WordMacAdapterError('WORD_AUTOMATION_FAILED')
      }

      return { saved: response.saved }
    },

    async restore(snapshot) {
      requireBounds(snapshot.bounds)
      await execute('restore', [
        normalizeWordPath(snapshot.path),
        String(snapshot.windowNumber),
        String(snapshot.windowId),
        String(snapshot.topInset),
        String(snapshot.bounds.x),
        String(snapshot.bounds.y),
        String(snapshot.bounds.width),
        String(snapshot.bounds.height)
      ])
    }
  }
}
