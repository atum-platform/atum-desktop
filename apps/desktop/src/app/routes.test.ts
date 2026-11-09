import { describe, expect, it } from 'vitest'

import { appViewForPath, ATUM_AUTH_ROUTE, dmRoute, isOverlayView, PETS_ROUTE, routeDmConversationId, routeSessionId } from './routes'

describe('Atum direct-message routes', () => {
  it('round-trips an opaque conversation id through the explicit DM prefix', () => {
    expect(dmRoute('room / một')).toBe('/dm/room%20%2F%20m%E1%BB%99t')
    expect(routeDmConversationId('/dm/room%20%2F%20m%E1%BB%99t')).toBe('room / một')
  })

  it('never treats a DM as a Hermes assistant session', () => {
    expect(routeSessionId('/dm/conversation-1')).toBeNull()
    expect(appViewForPath('/dm/conversation-1')).toBe('dm')
  })

  it('rejects missing and nested DM identifiers', () => {
    expect(routeDmConversationId('/dm/')).toBeNull()
    expect(routeDmConversationId('/dm/one/two')).toBeNull()
  })
})

describe('Atum auth route', () => {
  it('keeps the internal path conventional English', () => {
    expect(ATUM_AUTH_ROUTE).toBe('/sign-in')
  })

  it('is reserved, so the session parser never mistakes it for a session id', () => {
    expect(routeSessionId(ATUM_AUTH_ROUTE)).toBeNull()
    expect(appViewForPath(ATUM_AUTH_ROUTE)).toBe('atum-auth')
  })

  it('is a full-window surface, not an overlay card floating over the shell', () => {
    expect(isOverlayView('atum-auth')).toBe(false)
  })
})


describe('Pet Store deep link', () => {
  it('keeps /pets a reserved path, so the session parser never mistakes it for a chat', () => {
    expect(routeSessionId(PETS_ROUTE)).toBeNull()
    expect(appViewForPath(PETS_ROUTE)).toBe('pets')
  })

  it('is a page view, not an overlay — which is what makes the storefront opener navigate away from it', () => {
    // The one-shot deep link (`app-view.tsx`) and `useOpenStorefront` both
    // depend on this: overlays and pages leave the address bar; chat and DMs
    // stay put.
    expect(isOverlayView('pets')).toBe(false)
    expect(appViewForPath(PETS_ROUTE)).not.toBe('chat')
    expect(appViewForPath(PETS_ROUTE)).not.toBe('dm')
  })
})
