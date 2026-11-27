import type { Duplex } from 'node:stream'

import type { DesktopUpdateChannel, DesktopUpdateState } from '../../../vendor/t3-updates/packages/contracts/src/desktopUpdates'

export type WorkDesktopUpdateRequest =
  | { type: 'requestDesktopUpdate'; requestId: string; channel?: DesktopUpdateChannel; targetVersion?: string }
  | { type: 'commitDesktopUpdate' | 'cancelDesktopUpdate'; requestId: string }

export interface WorkDesktopUpdateReport {
  requestId?: string
  outcome?: 'ready-to-install' | 'up-to-date' | 'failed'
  preparedRequestId?: string
  reason?: string
  state: DesktopUpdateState
}

export type WorkDesktopUpdateHandler = (
  request: WorkDesktopUpdateRequest,
  connection: {
    signal: AbortSignal
    current(): boolean
    report(value: WorkDesktopUpdateReport): void
  }
) => void

export function bindWorkDesktopControl(options: {
  reports: Duplex
  controls: Duplex
  signal: AbortSignal
  exited: Promise<void>
  current(): boolean
  handler: WorkDesktopUpdateHandler
}) {
  const { reports, controls } = options
  const lifetime = new AbortController()
  const signal = AbortSignal.any([options.signal, lifetime.signal, AbortSignal.timeout(80_000)])
  const connectionSignal = AbortSignal.any([options.signal, lifetime.signal])
  let ready: () => void
  let buffer = ''
  const readyPromise = new Promise<void>((resolve, reject) => {
    ready = resolve
    const failed = () => reject(new Error('work_desktop_control_unavailable'))
    signal.addEventListener('abort', failed, { once: true })
  })
  void readyPromise.catch(() => undefined)
  const close = () => lifetime.abort()
  void options.exited.then(close)
  reports.on('error', close)
  controls.on('error', close)
  controls.on('end', close)
  const current = () => !connectionSignal.aborted && options.current()
  const send = (value: object) => {
    if (!connectionSignal.aborted && reports.writableLength < 512 * 1024) {
      reports.write(JSON.stringify({ version: 1, ...value }) + '\n')
    }
  }
  const connection = {
    signal: connectionSignal, current,
    report: (value: WorkDesktopUpdateReport) => send({ type: 'desktopUpdateStatus', ...value })
  }

  controls.setEncoding('utf8')
  controls.on('data', (chunk: string) => {
    if (connectionSignal.aborted) {return}
    buffer += chunk
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      if (line.length > 4096) {close(); return}
      let frame
      try {frame = JSON.parse(line)} catch {continue}
      if (frame?.version !== 1) {continue}
      if (frame.type === 'serverReady') {ready(); continue}
      if (typeof frame.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(frame.requestId) || !current()) {continue}
      const { type, requestId, channel, targetVersion } = frame
      if (type === 'cancelDesktopUpdate' || type === 'commitDesktopUpdate') {
        options.handler({ type, requestId }, connection)
      } else if (type === 'requestDesktopUpdate' &&
          (channel === undefined || channel === 'latest' || channel === 'nightly') &&
          (targetVersion === undefined || (typeof targetVersion === 'string' && targetVersion.length <= 128))) {
        options.handler({ type, requestId, channel, targetVersion }, connection)
      }
    }
    if (buffer.length > 4096) {close()}
  })
  send({ type: 'desktopTelemetryHello', electronPid: process.pid })

  return { ready: readyPromise }
}
