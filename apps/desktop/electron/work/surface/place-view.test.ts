import { describe, expect, it } from 'vitest'

import { placeOwnerView } from './place-view'

interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

function fixture() {
  const log: string[] = []

  const view = {
    setBorderRadius: (radius: number) => void log.push(`radius ${radius}`),
    setBounds: (bounds: Bounds) => void log.push(`bounds ${bounds.x},${bounds.y} ${bounds.width}x${bounds.height}`)
  }

  const window = (name: string, destroyed = false) => ({
    isDestroyed: () => destroyed,
    contentView: {
      addChildView: () => void log.push(`attach ${name}`),
      removeChildView: () => void log.push(`detach ${name}`)
    }
  })

  return { log, view, window }
}

describe('placeOwnerView', () => {
  it('gives the view its final bounds before it is attached, so it never paints at a stale rect', () => {
    const { log, view, window } = fixture()
    const main = window('main')

    const host = placeOwnerView({ view, host: null, window: main, rect: { x: 340, y: 0, width: 900, height: 700 }, zoom: 1, radius: 0 })

    expect(host).toBe(main)
    expect(log).toEqual(['radius 0', 'bounds 340,0 900x700', 'attach main'])
  })

  it('moves an attached view without re-attaching it, scaled by zoom', () => {
    const { log, view, window } = fixture()
    const main = window('main')

    placeOwnerView({ view, host: main, window: main, rect: { x: 100, y: 10, width: 500, height: 400 }, zoom: 1.5, radius: 4 })

    expect(log).toEqual(['radius 6', 'bounds 150,15 750x600'])
  })

  it('takes the view off its window when there is no rect or the window is gone', () => {
    const { log, view, window } = fixture()
    const main = window('main')

    expect(placeOwnerView({ view, host: main, window: main, rect: null, zoom: 1, radius: 0 })).toBeNull()
    expect(placeOwnerView({ view, host: main, window: window('gone', true), rect: { x: 0, y: 0, width: 1, height: 1 }, zoom: 1, radius: 0 })).toBeNull()
    expect(log).toEqual(['detach main', 'detach main'])
  })
})
