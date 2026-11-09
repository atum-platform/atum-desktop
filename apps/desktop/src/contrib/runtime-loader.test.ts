import { afterEach, expect, test, vi } from 'vitest'

vi.mock('@/hermes', () => ({ getStatus: vi.fn() }))
vi.mock('@/sdk/runtime', () => ({ installPluginSdk: vi.fn(), sdkImportMap: vi.fn(() => ({})) }))
vi.mock('@/store/notifications', () => ({ notifyError: vi.fn() }))

import { discoverRuntimePlugins, mayDiscoverRuntimePlugins, watchRuntimePlugins } from './runtime-loader'

const originalDesktop = window.hermesDesktop

afterEach(() => {
  window.hermesDesktop = originalDesktop
})

test('managed opaque filesystem authority never starts the legacy raw-path plugin poll', async () => {
  const readDir = vi.fn()
  const onPreviewFileChanged = vi.fn()

  window.hermesDesktop = {
    filesystemCapability: { managedAuthority: true },
    onPreviewFileChanged,
    readDir
  } as unknown as Window['hermesDesktop']

  expect(mayDiscoverRuntimePlugins()).toBe(false)

  watchRuntimePlugins()
  await discoverRuntimePlugins()

  expect(onPreviewFileChanged).not.toHaveBeenCalled()
  expect(readDir).not.toHaveBeenCalled()
})

test('ordinary Hermes renderers retain the runtime plugin door', () => {
  window.hermesDesktop = { readDir: vi.fn() } as unknown as Window['hermesDesktop']

  expect(mayDiscoverRuntimePlugins()).toBe(true)
})
