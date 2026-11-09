import fs from 'node:fs'
import path from 'node:path'

import { type MockBackendFixture, setupMockBackend } from './fixtures'
import { expect, test } from './test'

let fixture: MockBackendFixture
let directory: string

interface ContextTestBridge {
  actionPanelOwner: boolean
  consumerFiles: {
    roots: () => Promise<{ home: string }>
    open: (path: string) => Promise<{ kind: string; token: string }>
    capture: (token: string) => Promise<{ dataUrl: string; revision: string }>
    releaseView: (token: string) => Promise<boolean>
  }
  getConnection: () => Promise<{ wsUrl: string; connectionId?: string }>
}

test.beforeAll(async () => {
  fixture = await setupMockBackend({
    packaged: process.env.ATUM_E2E_PACKAGED === '1',
    productionFlags: process.platform === 'darwin',
    // Duplicate delivery is the boundary under test. Keep the unrelated
    // background title upgrade from making a second provider request with
    // the same opening user text.
    extraConfig: 'auxiliary:\n  title_generation:\n    model_upgrade_enabled: false',
  })
  await fixture.page.waitForSelector('[data-atum-roster]', { state: 'attached', timeout: 120_000 })

  const home = await fixture.page.evaluate(async () => {
    const bridge = (window as unknown as { hermesDesktop: ContextTestBridge }).hermesDesktop

    return (await bridge.consumerFiles.roots()).home
  })

  directory = fs.mkdtempSync(path.join(home, 'atum-context-check-'))
  // Base64 exceeds Uvicorn's default 16 MiB frame cap. This exercises the
  // actual wire limit, not only the small-payload happy path.
  fs.writeFileSync(path.join(directory, 'snapshot.xlsx'), Buffer.alloc(13 * 1024 * 1024, 42))
})

test.afterAll(async () => {
  await fixture?.cleanup()

  if (directory) {fs.rmSync(directory, { force: true, recursive: true })}
})

test('native file snapshot reaches a real gateway turn and duplicate delivery never repeats it', async () => {
  const result = await fixture.page.evaluate(async input => {
    const bridge = (window as unknown as { hermesDesktop: ContextTestBridge }).hermesDesktop
    const opened = await bridge.consumerFiles!.open(`${input}/snapshot.xlsx`)

    if (opened.kind !== 'card') {throw new Error('expected read-only file card')}
    const captured = await bridge.consumerFiles!.capture(opened.token)
    const connection = await bridge.getConnection()
    const socket = new WebSocket(connection.wsUrl)
    await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = () => reject(new Error('gateway socket unavailable')) })
    let sequence = 0

    const rpc = <T,>(method: string, params: Record<string, unknown>): Promise<T> => new Promise((resolve, reject) => {
      const id = ++sequence
      const timer = setTimeout(() => {socket.removeEventListener('message', listener); reject(new Error(`${method} timed out`))}, 45_000)

      const listener = (event: MessageEvent) => {
        const frame = JSON.parse(String(event.data))

        if (frame.id !== id) {return}
        clearTimeout(timer); socket.removeEventListener('message', listener)

        if (frame.error) {reject(new Error(`${method}: ${frame.error.message}`))} else {resolve(frame.result)}
      }

      socket.addEventListener('message', listener)
      socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })

    try {
      const session = await rpc<{session_id: string}>('session.create', { cwd: input, source: 'desktop' })
      const owner = await rpc<{backend_id: string; agent_id: string; conversation_id: string}>('context.capabilities', { session_id: session.session_id })

      const params = { session_id: session.session_id, submission_id: crypto.randomUUID(), text: 'E2E_FROZEN_SURFACE: acknowledge the attached snapshot.', surface_context: {
        version: 1, capture_id: crypto.randomUUID(), backend_id: owner.backend_id, agent_id: owner.agent_id, conversation_id: owner.conversation_id,
        kind: 'file', label: 'snapshot.xlsx', provenance: 'metadata-only', truncated: false, file_data_url: captured.dataUrl, source_revision: captured.revision
      } }

      await rpc('prompt.submit', params)
      let status = 'accepted'
      const deadline = Date.now() + 45_000

      while (status === 'accepted' && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 250))
        status = (await rpc<{status: string}>('prompt.submission_status', { session_id: session.session_id, submission_id: params.submission_id })).status
      }

      const duplicate = await rpc<{status: string; receipt: {status: string}}>('prompt.submit', params)
      await bridge.consumerFiles!.releaseView(opened.token)
      const revoked = await bridge.consumerFiles!.capture(opened.token).then(() => false, () => true)

      return { status, duplicate: duplicate.status, receipt: duplicate.receipt.status, revoked, connectionId: Boolean(connection.connectionId), owner: bridge.actionPanelOwner }
    } finally {socket.close()}
  }, directory)

  expect(result).toEqual({ status: 'complete', duplicate: 'duplicate', receipt: 'complete', revoked: true, connectionId: true, owner: true })
  const staged = path.join(directory, '.hermes', 'desktop-attachments')
  const files = fs.readdirSync(staged).filter(file => file.startsWith('context-'))
  expect(files).toHaveLength(1)
  expect(fs.readFileSync(path.join(staged, files[0]!)).equals(Buffer.alloc(13 * 1024 * 1024, 42))).toBe(true)
  expect(fixture.mock.receivedPrompts.filter(prompt => prompt.startsWith('E2E_FROZEN_SURFACE'))).toHaveLength(1)
})

test('a secondary renderer cannot read native action-panel files', async () => {
  const result = await fixture.app.evaluate(async ({ BrowserWindow, app }, input) => {
    const preload = input.packaged ? `${app.getAppPath()}/dist/electron-preload.js` : input.devPreload
    const main = BrowserWindow.getAllWindows()[0]!
    const peer = new BrowserWindow({ show: false, webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true } })

    try {
      await peer.loadURL(main.webContents.getURL())

      return await peer.webContents.executeJavaScript(`(async () => ({ owner: window.hermesDesktop.actionPanelOwner, refused: await window.hermesDesktop.consumerFiles.roots().then(() => false, () => true) }))()`)
    } finally {peer.destroy()}
  }, { devPreload: path.resolve('dist/electron-preload.js'), packaged: process.env.ATUM_E2E_PACKAGED === '1' })

  expect(result).toEqual({ owner: false, refused: true })
})
