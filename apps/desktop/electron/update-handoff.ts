import { spawn as spawnProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import type { DesktopLocale } from '../shared/desktop-locale'

import { atumUpdateHelperStep, UPDATE_HELPER_INITIAL_STATE } from './update-handoff-step'
import { restartEnvironment, restartPhases } from './update-timing'

/**
 * Restart-to-update continuity on macOS .
 *
 * Squirrel.Mac's ShipIt replaces the bundle only after every Atum process has exited, and it
 * aborts if one is still running, so the old window cannot stay up through the swap. The proven
 * pattern (Sparkle's installer progress window; the Hermes Tauri updater window in main.ts) is a
 * small separate progress window: it appears on Restart, stays while ShipIt works, and closes the
 * moment the new version's window is on screen. Here it is the system's own `osascript` running a
 * short JavaScript-for-Automation script, so there is no new binary to build, sign or notarize, and
 * it is not "a running instance" of the app ShipIt waits for.
 *
 * The record also carries the window's place, so the new version opens exactly where the old one
 * was, and lets the next launch say plainly when the update did not finish.
 */

export const UPDATE_HANDOFF_MAX_AGE_MS = 30 * 60_000

const RECORD = 'handoff.json'
const SCRIPT = 'progress.js'
const MARKERS = { shown: 'shown', cancelled: 'cancelled', failed: 'failed' } as const

export interface UpdateHandoffBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface UpdateHandoffResult {
  outcome: 'updated' | 'not_updated'
  fromVersion: string
  toVersion: string
  startedAt: number
  bounds: UpdateHandoffBounds | null
}

export interface UpdateHelperCopy {
  title: string
  slow: string
  failedTitle: string
  opening: string
}

const HELPER_COPY: Record<DesktopLocale, UpdateHelperCopy> = {
  en: { title: 'Updating Atum', slow: 'Taking longer than usual', failedTitle: 'Couldn’t finish the update', opening: 'Opening Atum…' },
  vi: { title: 'Đang cập nhật Atum', slow: 'Lâu hơn bình thường', failedTitle: 'Chưa cập nhật xong', opening: 'Đang mở Atum…' },
  ja: { title: 'Atum をアップデート中', slow: 'いつもより時間がかかっています', failedTitle: 'アップデートを完了できませんでした', opening: 'Atum を開いています…' },
  zh: { title: '正在更新 Atum', slow: '比平时要久一些', failedTitle: '未能完成更新', opening: '正在打开 Atum…' },
  'zh-hant': { title: '正在更新 Atum', slow: '比平常久一些', failedTitle: '未能完成更新', opening: '正在開啟 Atum…' }
}

export function updateHelperCopy(locale: string): UpdateHelperCopy {
  return HELPER_COPY[locale as DesktopLocale] ?? HELPER_COPY.en
}

function finiteBounds(value: unknown): UpdateHandoffBounds | null {
  if (!value || typeof value !== 'object') {return null}
  const { x, y, width, height } = value as Record<string, unknown>

  if (![x, y, width, height].every(each => typeof each === 'number' && Number.isFinite(each))) {return null}

  if ((width as number) < 200 || (height as number) < 200 || (width as number) > 20_000 || (height as number) > 20_000) {return null}

  return { x: Math.round(x as number), y: Math.round(y as number), width: Math.round(width as number), height: Math.round(height as number) }
}

/** The saved place, kept on the display it now matches and fully inside its work area. */
export function restoredUpdateBounds(bounds: UpdateHandoffBounds, workArea: UpdateHandoffBounds): UpdateHandoffBounds {
  const width = Math.min(bounds.width, workArea.width)
  const height = Math.min(bounds.height, workArea.height)

  return {
    width,
    height,
    x: Math.min(Math.max(bounds.x, workArea.x), workArea.x + workArea.width - width),
    y: Math.min(Math.max(bounds.y, workArea.y), workArea.y + workArea.height - height)
  }
}

/** The helper window: AppKit through the JavaScript-for-Automation bridge, around the shared step. */
export function updateHelperScript(): string {
  return `ObjC.import('Cocoa')
ObjC.import('signal')
var atumUpdateHelperStep = (${atumUpdateHelperStep.toString()})
function readText(file) {
  var value = $.NSString.stringWithContentsOfFileEncodingError(file, $.NSUTF8StringEncoding, null)
  return value.isNil() ? null : ObjC.unwrap(value)
}
function exists(file) { return $.NSFileManager.defaultManager.fileExistsAtPath(file) }
function clock(ms) { var seconds = Math.floor(ms / 1000); return Math.floor(seconds / 60) + ':' + ('0' + (seconds % 60)).slice(-2) }
function label(text, frame, size, secondary, bold) {
  var field = $.NSTextField.labelWithString(text)
  field.frame = frame
  field.font = bold ? $.NSFont.boldSystemFontOfSize(size) : $.NSFont.monospacedDigitSystemFontOfSizeWeight(size, 0)
  if (secondary) { field.textColor = $.NSColor.secondaryLabelColor }
  field.lineBreakMode = $.NSLineBreakByTruncatingTail
  return field
}
function run(argv) {
  var config = JSON.parse(readText(argv[0]))
  var copy = config.copy
  var app = $.NSApplication.sharedApplication
  app.setActivationPolicy($.NSApplicationActivationPolicyAccessory)
  var width = 360, height = 92
  var panel = $.NSPanel.alloc.initWithContentRectStyleMaskBackingDefer($.NSMakeRect(0, 0, width, height),
    $.NSWindowStyleMaskTitled | $.NSWindowStyleMaskFullSizeContentView | $.NSWindowStyleMaskNonactivatingPanel,
    $.NSBackingStoreBuffered, false)
  panel.titlebarAppearsTransparent = true
  panel.titleVisibility = $.NSWindowTitleHidden
  panel.title = copy.title
  panel.hidesOnDeactivate = false
  panel.level = $.NSFloatingWindowLevel
  panel.movableByWindowBackground = true
  var view = panel.contentView
  var icon = $.NSImageView.imageViewWithImage($.NSWorkspace.sharedWorkspace.iconForFile(config.bundlePath))
  icon.frame = $.NSMakeRect(20, 22, 48, 48)
  view.addSubview(icon)
  var title = label(copy.title, $.NSMakeRect(84, 50, 256, 20), 13, false, true)
  view.addSubview(title)
  var bar = $.NSProgressIndicator.alloc.initWithFrame($.NSMakeRect(84, 31, 210, 12))
  bar.style = $.NSProgressIndicatorStyleBar
  bar.indeterminate = false
  bar.minValue = 0
  bar.maxValue = 1
  view.addSubview(bar)
  var timer = label('0:00', $.NSMakeRect(296, 28, 44, 18), 11, true, false)
  timer.alignment = $.NSTextAlignmentRight
  view.addSubview(timer)
  var detail = label('', $.NSMakeRect(84, 10, 256, 16), 11, true, false)
  view.addSubview(detail)
  var bounds = config.bounds
  var screens = $.NSScreen.screens
  if (bounds && screens.count > 0) {
    var primary = screens.objectAtIndex(0).frame
    var centerX = bounds.x + bounds.width / 2
    var centerY = primary.size.height - (bounds.y + bounds.height / 2)
    panel.setFrameOrigin($.NSMakePoint(Math.round(centerX - width / 2), Math.round(centerY - height / 2)))
  } else {
    panel.center
  }
  panel.orderFrontRegardless
  var marker = function (name) { return exists(config.directory + '/' + name) }
  var logOffset = (readText(config.shipItLog) || '').length
  var stageOffset = config.stageProgress ? (readText(config.stageProgress) || '').length : 0
  var state = ${JSON.stringify(UPDATE_HELPER_INITIAL_STATE)}
  var raised = false
  while (true) {
    $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.5))
    var now = Date.now()
    var text = readText(config.shipItLog) || ''
    if (text.length < logOffset) { logOffset = 0 }
    var stageText = config.stageProgress ? (readText(config.stageProgress) || '') : ''
    if (stageText.length < stageOffset) { stageOffset = 0 }
    var combinedLog = text.slice(logOffset) + '\\n' + stageText.slice(stageOffset)
    stageOffset = stageText.length
    var appRunning = $.kill(config.pid, 0) === 0
    var step = atumUpdateHelperStep(state, {
      now: now, startedAt: config.startedAt, appRunning: appRunning, log: combinedLog,
      shown: marker('${MARKERS.shown}'), cancelled: marker('${MARKERS.cancelled}'), failed: marker('${MARKERS.failed}')
    })
    logOffset = text.length
    state = step.state
    if (step.exit) { break }
    if (!appRunning && !raised) { raised = true; panel.orderFrontRegardless }
    if (step.view.phase === 'failed') {
      title.stringValue = copy.failedTitle
      title.frame = $.NSMakeRect(84, 46, 256, 20)
      detail.stringValue = copy.opening
      detail.frame = $.NSMakeRect(84, 26, 256, 16)
      bar.hidden = true
      timer.hidden = true
    } else {
      bar.doubleValue = step.view.progress
      timer.stringValue = clock(step.view.elapsed)
      detail.stringValue = step.view.phase === 'slow' ? copy.slow : ''
    }
    if (step.open) {
      state.lastOpenAttempt = now
      if ($.NSWorkspace.sharedWorkspace.openURL($.NSURL.fileURLWithPath(config.bundlePath))) { state.openedAt = now }
    }
  }
  panel.close
  return ''
}
`
}

export interface UpdateHandoff {
  /** Restart accepted: record the place and show the progress window. Never throws. */
  begin(toVersion: string): void
  /** The quit was refused: take the progress window down. */
  cancel(): void
  /** The install handoff failed after teardown: the window reopens the installed version. */
  fail(): void
  /** Next launch, once: what the previous Restart left, if it is recent. */
  consume(): UpdateHandoffResult | null
  /** Next launch: the new window is on screen, so the progress window can close. */
  shown(): void
}

interface FileSystem {
  mkdirSync: typeof fs.mkdirSync
  readFileSync: typeof fs.readFileSync
  renameSync: typeof fs.renameSync
  rmSync: typeof fs.rmSync
  writeFileSync: typeof fs.writeFileSync
}

export function createUpdateHandoff(options: {
  directory: string
  currentVersion: string
  bundlePath: string
  shipItLog: string
  stageProgress?: string
  pid: number
  locale: () => string
  bounds: () => UpdateHandoffBounds | null
  log: (message: string) => void
  now?: () => number
  fs?: FileSystem
  spawn?: (command: string, args: readonly string[]) => void
}): UpdateHandoff {
  const files = options.fs ?? fs
  const now = options.now ?? Date.now

  const spawn = options.spawn ?? ((command, args) => {
    const child = spawnProcess(command, [...args], { detached: true, stdio: 'ignore' })
    child.on('error', error => options.log(`[updates] restart progress window unavailable: ${error.message}`))
    child.unref()
  })

  const file = (name: string) => path.join(options.directory, name)

  const writeAtomic = (name: string, contents: string) => {
    const temporary = file(`.${name}.${process.pid}.tmp`)
    files.writeFileSync(temporary, contents, { mode: 0o600 })
    files.renameSync(temporary, file(name))
  }

  const mark = (name: string) => {
    try {
      files.mkdirSync(options.directory, { recursive: true, mode: 0o700 })
      files.writeFileSync(file(name), '', { mode: 0o600 })
    } catch (error) {
      options.log(`[updates] restart progress ${name} marker not written: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  let consumed: UpdateHandoffResult | null = null

  return {
    begin(toVersion) {
      try {
        files.mkdirSync(options.directory, { recursive: true, mode: 0o700 })

        for (const name of Object.values(MARKERS)) {files.rmSync(file(name), { force: true })}

        void restartEnvironment(path.dirname(options.bundlePath)).then(value => options.log(`[updates] restart environment ${value}`)).catch(() => undefined)

        const record = {
          v: 1,
          fromVersion: options.currentVersion,
          toVersion,
          startedAt: now(),
          bounds: finiteBounds(options.bounds()),
          pid: options.pid,
          bundlePath: options.bundlePath,
          shipItLog: options.shipItLog,
          stageProgress: options.stageProgress,
          directory: options.directory,
          copy: updateHelperCopy(options.locale())
        }

        writeAtomic(SCRIPT, updateHelperScript())
        writeAtomic(RECORD, JSON.stringify(record))
        spawn('/usr/bin/osascript', ['-l', 'JavaScript', file(SCRIPT), file(RECORD)])
        options.log(`[updates] restart progress window started to=${toVersion}`)
      } catch (error) {
        // The window is reassurance only; Restart proceeds without it.
        options.log(`[updates] restart progress window not started: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
    cancel() {
      mark(MARKERS.cancelled)

      try {files.rmSync(file(RECORD), { force: true })} catch {/* The record expires on its own. */}
    },
    fail() {
      mark(MARKERS.failed)
    },
    consume() {
      let raw: string

      try {
        raw = files.readFileSync(file(RECORD), 'utf8') as string
      } catch {
        return null
      }

      try {files.rmSync(file(RECORD), { force: true })} catch {/* Read once per launch regardless. */}

      try {
        const record = JSON.parse(raw) as Record<string, unknown>
        const startedAt = record.startedAt

        if (
          record.v !== 1 || typeof record.fromVersion !== 'string' || typeof record.toVersion !== 'string' ||
          typeof startedAt !== 'number' || !Number.isFinite(startedAt) ||
          now() - startedAt < 0 || now() - startedAt > UPDATE_HANDOFF_MAX_AGE_MS
        ) {
          return null
        }

        consumed = {
          outcome: options.currentVersion === record.fromVersion ? 'not_updated' : 'updated',
          fromVersion: record.fromVersion,
          toVersion: record.toVersion,
          startedAt,
          bounds: finiteBounds(record.bounds)
        }

        return consumed
      } catch {
        return null
      }
    },
    shown() {
      if (!consumed) {return}
      const result = consumed
      consumed = null
      mark(MARKERS.shown)

      try {
        const phases = restartPhases(String(files.readFileSync(options.shipItLog, 'utf8')), result.startedAt, now())

        for (const [phase, ms] of Object.entries(phases)) {options.log(`[updates] restart phase=${phase} ms=${ms}`)}
      } catch { /* Logs may rotate or be unavailable; the total remains authoritative. */ }

      options.log(
        `[updates] restart finished outcome=${result.outcome} from=${result.fromVersion} to=${result.toVersion} ms=${Math.max(0, now() - result.startedAt)}`
      )
    }
  }
}
