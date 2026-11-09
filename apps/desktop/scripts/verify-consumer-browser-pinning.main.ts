import { createServer } from 'node:http'
// Electron main process for scripts/verify-consumer-browser-pinning.mjs (bundled with esbuild, run by the
// real Electron binary). It drives the real consumer-browser controller against a real Chromium session.
//
// Model of the 2026-11-06 audit lead atum-consumer-browser-unpinned-dns-public-check, offline: the name
// `rebind.test` is what the controller's own lookup sees as PUBLIC (a rebinding server's first answer), while
// Chromium's own resolution of it is LOOPBACK (its second answer; a static host-resolver rule stands in for it).
//   mode=unpinned: no pinned proxy (the old behaviour). Chromium dials loopback, the page reads the marker.
//   mode=legit:    the same pinned egress, but the vetted address is a working site (the dial seam maps it to a
//                  loopback fixture): an http page, a fetch and a ws:// socket (tunnelled by CONNECT) must work.
//   mode=pinned:   the controller's real egress. Chromium never resolves; the proxy dials only the vetted
//                  public address (recorded, and sent to a closed port so nothing leaves this machine).
import { connect } from 'node:net'

import { app, BrowserWindow, session } from 'electron'
import { WebSocketServer } from 'ws'

import { createConsumerBrowserEgress } from '../electron/app-view/egress'
import { createConsumerBrowserController } from '../electron/consumer-browser/controller'

const mode = process.argv.includes('--mode=legit') ? 'legit' : process.argv.includes('--mode=pinned') ? 'pinned' : 'unpinned'
const PUBLIC = '93.184.216.34'
declare const require: (id: string) => any

// Both the controller filter and the egress call `lookup` from node:dns/promises at request time.
require('node:dns/promises').lookup = async () => [{ address: PUBLIC, family: 4 }]

// Chromium's own view of the name (what a rebinding server answers second).
app.commandLine.appendSwitch('host-resolver-rules', 'MAP rebind.test 127.0.0.1')

const result: Record<string, unknown> = { mode }

async function main(): Promise<void> {
  let markerHits = 0

  const marker = createServer((request, response) => {
    markerHits += 1
    response.setHeader('content-type', request.url === '/marker' ? 'text/plain' : 'text/html')
    response.end(request.url === '/marker' ? 'LOOPBACK-MARKER' : '<!doctype html><title>attacker page</title>')
  })

  const sockets = new WebSocketServer({ server: marker })
  sockets.on('connection', socket => socket.send('WS-HELLO'))
  await new Promise<void>(resolve => marker.listen(0, '127.0.0.1', resolve))
  const port = (marker.address() as { port: number }).port

  const dialed: Array<{ port: number; addresses: readonly string[]; hostname: string }> = []
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const sender = { mainFrame: {} }
  const owner = { isDestroyed: () => false, webContents: sender }
  const event = { sender, senderFrame: sender.mainFrame }
  const partition = 'atum-consumer-browser-pinning'

  createConsumerBrowserController({
    app: { on: () => undefined, removeListener: () => undefined } as never,
    browserWindowFromWebContents: () => owner as never,
    ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler), removeHandler: () => undefined } as never,
    knownAppIds: [],
    consumerOnly: true,
    sessionFromPartition: name => session.fromPartition(name),
    createEgress:
      mode !== 'unpinned'
        ? (browserSession, active) =>
            createConsumerBrowserEgress(browserSession, active, {
              dial: (dialPort, addresses, hostname) => {
                dialed.push({ port: dialPort, addresses, hostname })

                // Nothing leaves this machine: the "public" address is recorded, then either the fixture "site"
                // (legit) or a closed loopback port (pinned) answers.
                return connect({ host: '127.0.0.1', port: mode === 'legit' ? port : 1 })
              }
            })
        : () => ({ ready: Promise.resolve(), close: () => undefined })
  })

  const target = `http://rebind.test:${port}/`
  await handlers.get('atum:consumer-browser:prepare')!(event, { partition, url: target })

  const window = new BrowserWindow({ show: false, webPreferences: { session: session.fromPartition(partition), sandbox: true } })
  const loaded = await window.loadURL(target).then(() => 'loaded', (error: Error) => error.message)
  result.load = loaded
  result.pageTitle = loaded === 'loaded' ? window.webContents.getTitle() : null

  if (loaded === 'loaded') {
    result.fetch = await window.webContents.executeJavaScript(`fetch('/marker').then(r => r.text(), e => 'FETCH-FAILED:' + e.message)`)
    result.websocket = await window.webContents.executeJavaScript(
      `new Promise(resolve => { const socket = new WebSocket('ws://rebind.test:${port}/'); socket.onmessage = event => resolve(event.data); socket.onerror = () => resolve('WS-FAILED'); setTimeout(() => resolve('WS-TIMEOUT'), 8000) })`
    )
  }

  result.markerHits = markerHits
  result.dialed = dialed
  window.destroy()
  marker.close()
}

app.whenReady().then(main).catch(error => { result.error = String(error?.stack ?? error) }).finally(() => {
  process.stdout.write(`RESULT ${JSON.stringify(result)}\n`)
  app.exit(0)
})
