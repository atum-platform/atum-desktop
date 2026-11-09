import { beforeEach, describe, expect, it } from 'vitest'

import { $appViewOverlayCount, $attachedAppViews, holdAppViewOverlay, markAppViewAttached, overlapsAppView, resetAppViewOverlayForTests, setAppViewRect } from './app-view-overlay'

describe('app-view overlay store', () => {
  beforeEach(() => resetAppViewOverlayForTests())

  it('counts holds and releases each one once', () => {
    const releaseA = holdAppViewOverlay()
    const releaseB = holdAppViewOverlay()

    expect($appViewOverlayCount.get()).toBe(2)
    releaseA()
    releaseA()
    expect($appViewOverlayCount.get()).toBe(1)
    releaseB()
    expect($appViewOverlayCount.get()).toBe(0)
  })

  it('tracks attached app views by id so floating surfaces can stay out of their rectangle', () => {
    markAppViewAttached('view-1', true)
    markAppViewAttached('view-1', true)
    markAppViewAttached('view-2', true)
    expect($attachedAppViews.get()).toBe(2)
    markAppViewAttached('view-1', false)
    expect($attachedAppViews.get()).toBe(1)
    markAppViewAttached('view-2', false)
    markAppViewAttached('view-2', false)
    expect($attachedAppViews.get()).toBe(0)
  })

  it('retains eligible geometry through an overlay detach until its owner hides or closes it', () => {
    const rect = { height: 600, width: 500, x: 50, y: 60 }
    setAppViewRect('view-1', rect)
    markAppViewAttached('view-1', true)
    markAppViewAttached('view-1', false)
    expect($attachedAppViews.get()).toBe(0)
    expect(overlapsAppView(rect)).toBe(true)
    setAppViewRect('view-1', null)
    expect(overlapsAppView(rect)).toBe(false)
  })
})
