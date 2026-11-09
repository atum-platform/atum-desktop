import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { closeActiveTab } from './close-tab'

describe('closeActiveTab', () => {
  beforeEach(() => vi.stubGlobal('document', { activeElement: null }))
  afterEach(() => vi.unstubAllGlobals())

  it('lets a focused local tab strip own the native-menu close request', () => {
    vi.unstubAllGlobals()
    const scope = document.createElement('div')
    const tab = document.createElement('button')
    scope.append(tab)
    document.body.append(scope)
    tab.focus()
    scope.addEventListener('hermes:close-focused-local-tab', event => event.preventDefault())

    expect(closeActiveTab()).toBe(true)

    scope.remove()
  })
})
