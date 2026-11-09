import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('retired nested preview persistence', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.resetModules()
  })

  it('drops the retired file-tab key without restoring a nested selection path', async () => {
    window.localStorage.setItem('hermes.desktop.filePreviewTabs.v1', JSON.stringify([{ id: 'file:stale' }]))

    const workbench = await import('./workbench-tabs')

    expect(window.localStorage.getItem('hermes.desktop.filePreviewTabs.v1')).toBeNull()
    expect(workbench.$workbenchTabs.get()).toEqual([])
  })
})
