import { beforeEach, describe, expect, it } from 'vitest'

import { resetAppViewAttachmentForTests, trackAppViewAttachment } from './app-view-attachment'
import { $attachedAppViews, overlapsAppView, resetAppViewOverlayForTests, setAppViewRect } from './app-view-overlay'

function deferred() {
  let resolve: (value?: unknown) => void = () => {}

  let reject: (reason?: unknown) => void = () => {}
  const promise = new Promise<unknown>((res, rej) => { resolve = res; reject = rej })

  return { promise, reject, resolve }
}

describe('app-view attachment tracking', () => {
  beforeEach(() => {
    resetAppViewOverlayForTests()
    resetAppViewAttachmentForTests()
  })

  it('counts an attach at once and a detach only when main answers', async () => {
    const attach = deferred()
    const detach = deferred()

    void trackAppViewAttachment('v1', true, () => attach.promise)
    expect($attachedAppViews.get()).toBe(1)
    attach.resolve({ ok: true })

    const detaching = trackAppViewAttachment('v1', false, () => detach.promise)

    expect($attachedAppViews.get()).toBe(1)
    detach.resolve({ ok: true })
    await detaching
    expect($attachedAppViews.get()).toBe(0)
  })

  it('never lets a late answer to an older detach clear a newer attach', async () => {
    const detach = deferred()
    const attach = deferred()

    void trackAppViewAttachment('v1', true, async () => ({ ok: true }))
    const detaching = trackAppViewAttachment('v1', false, () => detach.promise)

    void trackAppViewAttachment('v1', true, () => attach.promise)
    expect($attachedAppViews.get()).toBe(1)
    detach.resolve({ ok: true })
    await detaching
    expect($attachedAppViews.get()).toBe(1)
    attach.resolve({ ok: true })
  })

  it('clears an attach that main answers with an error, but keeps one whose transport failed', async () => {
    const rect = { height: 600, width: 500, x: 50, y: 60 }
    setAppViewRect('v1', rect)
    await trackAppViewAttachment('v1', true, async () => ({ error: 'app_view_unknown' }))
    expect($attachedAppViews.get()).toBe(0)
    expect(overlapsAppView(rect)).toBe(false)
    await trackAppViewAttachment('v2', true, async () => { throw new Error('ipc_down') })
    expect($attachedAppViews.get()).toBe(1)
  })

  it('does not let an obsolete missing response clear a newer view placement', async () => {
    const old = deferred()
    const pending = trackAppViewAttachment('v1', true, () => old.promise)
    const rect = { height: 600, width: 500, x: 50, y: 60 }
    setAppViewRect('v1', rect)
    await trackAppViewAttachment('v1', true, async () => ({ ok: true }))
    old.resolve({ error: 'app_view_unknown' })
    await pending
    expect(overlapsAppView(rect)).toBe(true)
    expect($attachedAppViews.get()).toBe(1)
  })

  it('treats a failed or error-carrying answer to a detach as detached', async () => {
    void trackAppViewAttachment('v1', true, async () => ({ ok: true }))
    await trackAppViewAttachment('v1', false, async () => { throw new Error('view_unknown') })
    expect($attachedAppViews.get()).toBe(0)

    void trackAppViewAttachment('v2', true, async () => ({ ok: true }))
    await trackAppViewAttachment('v2', false, async () => ({ error: 'view_unknown' }))
    expect($attachedAppViews.get()).toBe(0)
  })
})
