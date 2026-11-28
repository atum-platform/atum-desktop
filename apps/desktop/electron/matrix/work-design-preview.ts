import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { BrowserWindow, type NativeImage, session } from 'electron'

import { Serial } from '../work/session/serial'

import type { WorkDesignRenderer } from './drive-import-native'

const exec = promisify(execFile)
const serial = new Serial()

async function captureHtml(file: string, width: number, height: number, signal: AbortSignal): Promise<Buffer | null> {
  const isolated = session.fromPartition('work-design-preview', { cache: false })
  const url = pathToFileURL(file).href
  const window = new BrowserWindow({
    show: false,
    useContentSize: true,
    width,
    height,
    webPreferences: {
      session: isolated, offscreen: { deviceScaleFactor: 1 }, javascript: false, sandbox: true,
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false
    }
  })
  const contents = window.webContents
  const abort = () => { if (!window.isDestroyed()) {window.destroy()} }
  signal.addEventListener('abort', abort, { once: true })
  let blocked = false

  try {
    signal.throwIfAborted()
    isolated.webRequest.onBeforeRequest((details, reply) => {
      const allowed = details.resourceType === 'mainFrame' && details.url === url && details.webContentsId === contents.id

      blocked ||= !allowed
      reply({ cancel: !allowed })
    })
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', event => event.preventDefault())
    await contents.loadURL(url)
    contents.debugger.attach()
    const { cssContentSize } = await contents.debugger.sendCommand('Page.getLayoutMetrics')

    if (!cssContentSize || cssContentSize.width > width || cssContentSize.height > height) {return null}
    let image: NativeImage
    do {
      const paint = once(contents, 'paint', { signal })
      contents.invalidate()
      const [, , painted] = await paint as [unknown, unknown, NativeImage]
      // Electron can reject the compositor copy after a valid offscreen paint.
      const captured = await contents.capturePage({ x: 0, y: 0, width, height }, { stayHidden: true }).catch(() => painted)
      signal.throwIfAborted()
      image = captured.isEmpty() ? painted : captured
      if (image.isEmpty()) {await delay(16, undefined, { signal })}
    } while (image.isEmpty())

    return blocked ? null : image.resize({ width, height }).toPNG()
  } finally {
    signal.removeEventListener('abort', abort)
    abort()
    isolated.webRequest.onBeforeRequest(null)
  }
}

/** Renders only the host-validated immutable snapshot from the placement helper. */
export function workDesignRenderer(resvg: string): WorkDesignRenderer {
  return (source, format, width, height, signal) => serial.run(async () => {
    const deadline = AbortSignal.timeout(10_000)
    const lifetime = signal ? AbortSignal.any([signal, deadline]) : deadline
    lifetime.throwIfAborted()
    const directory = await mkdtemp(path.join(tmpdir(), 'atum-work-design-'))
    const input = path.join(directory, 'design.' + format)

    try {
      await writeFile(input, source, { mode: 0o600 })

      if (format === 'html') {return await captureHtml(input, width, height, lifetime)}
      const png = path.join(directory, 'preview.png')
      await exec(resvg, ['--quiet', '-w', String(width), input, png], {
        signal: lifetime, killSignal: 'SIGKILL', cwd: directory, env: { PATH: '/usr/bin:/bin' }
      })

      return await readFile(png)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
}
