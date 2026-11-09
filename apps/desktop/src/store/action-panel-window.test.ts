import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
  delete (window as Partial<Window>).hermesDesktop
  localStorage.clear()
  vi.resetModules()
})

it('a peer window neither hydrates nor overwrites the main window queue or tabs', async () => {
  const queued = JSON.stringify({ same: [{ id: 'q', text: 'main only', attachments: [], queuedAt: 1 }] })
  const tabs = JSON.stringify([{ invalidButMustRemainUntouched: true }])
  localStorage.setItem('hermes.desktop.composerQueue.v1', queued)
  localStorage.setItem('hermes.desktop.workbenchTabs.v2', tabs)
  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: { actionPanelOwner: false } })
  vi.resetModules()
  const queue = await import('./composer-queue')
  const panel = await import('./workbench-tabs')
  expect(queue.$queuedPromptsBySession.get()).toEqual({})
  expect(await queue.enqueueQueuedPrompt('same', { text: 'peer', attachments: [] })).toBeNull()
  expect(queue.shouldAutoDrain({ isBusy: false, queueLength: 1 })).toBe(false)
  panel.openWorkbenchSingleton('files')
  expect(panel.$workbenchTabs.get()).toEqual([])
  expect(localStorage.getItem('hermes.desktop.composerQueue.v1')).toBe(queued)
  expect(localStorage.getItem('hermes.desktop.workbenchTabs.v2')).toBe(tabs)
})
