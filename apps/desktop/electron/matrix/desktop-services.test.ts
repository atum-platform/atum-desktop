import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { MATRIX_DESKTOP_SERVICES as channels } from '../../shared/matrix-desktop-services'

import { installMatrixDesktopServicesIpc, MatrixDesktopServices } from './desktop-services'
import { requireMatrixCaller } from './ipc-policy'

const temporary: string[] = []
afterEach(() => temporary.splice(0).forEach(directory => fs.rmSync(directory, { recursive: true, force: true })))

function harness() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-services-'))
  temporary.push(userData)
  const configPath = path.join(userData, 'services.json')
  fs.writeFileSync(configPath, JSON.stringify({
    schemaVersion: 1,
    observability: {
      posthogKey: 'phc_test00000000', posthogHost: 'https://us.i.posthog.com',
      sentryDsn: 'https://abc@o1.ingest.sentry.io/1', environment: 'test'
    },
    updateFeedUrl: 'https://updates.example.com/desktop/matrix/candidate/mac/arm64/'
  }))
  const sink = {
    event: vi.fn(), error: vi.fn(), feedback: vi.fn(async () => true), discard: vi.fn(), endSession: vi.fn()
  }
  const options = {
    configPath,
    userData,
    version: '1.0.0',
    revision: 'a'.repeat(40),
    packaged: false,
    supported: true,
    busy: vi.fn(() => false),
    resources: userData,
    currentChannel: 'latest' as const,
    changed: vi.fn(),
    native: { stage: { prepare: vi.fn(async () => {}) }, install: vi.fn(async () => {}) },
    admit: vi.fn(async () => null),
    log: vi.fn(),
    createSink: vi.fn(() => sink)
  }
  const services = new MatrixDesktopServices(options)

  return { options, services, sink }
}

describe('Matrix desktop services', () => {
  it('keeps missing or invalid optional configuration from breaking the app', async () => {
    const test = harness()

    for (const contents of [null, '{broken']) {
      if (contents === null) {fs.rmSync(test.options.configPath)} else {fs.writeFileSync(test.options.configPath, contents)}
      const services = new MatrixDesktopServices(test.options)
      expect(services.status().reporting.configured).toBe(false)
      expect(await services.start()).toBe(false)
      await expect(services.restart()).resolves.toBe(false)
    }
  })

  it('publishes busy while a local message is in flight', async () => {
    const test = harness()
    await test.services.start()
    let finish!: (value: string) => void
    const pending = test.services.message(() => new Promise<string>(resolve => {finish = resolve}))
    expect(test.services.status().busy).toBe(true)
    finish('sent')
    await expect(pending).resolves.toBe('sent')
    expect(test.services.status().busy).toBe(false)
  })

  it('accepts settings IPC only from the owned top frame', () => {
    const test = harness()
    const ui = { mainFrame: { url: 'atum-matrix://ui/matrix.html' } }
    const sdk = { mainFrame: { url: 'atum-matrix://sdk/matrix-sdk.html' } }
    const handles = new Map<string, (...args: any[]) => any>()
    installMatrixDesktopServicesIpc({
      services: test.services,
      ipc: {
        handle: (name, callback) => {handles.set(name, callback)},
        on: vi.fn()
      } as any,
      requireUi: event => requireMatrixCaller(event, ui, ui.mainFrame.url),
      requireDiagnostic: event => requireMatrixCaller(event, ui, ui.mainFrame.url)
    })
    expect(() => handles.get(channels.channel)!({ sender: sdk, senderFrame: sdk.mainFrame }, 'beta'))
      .toThrow('matrix_ipc_denied')
  })
})
