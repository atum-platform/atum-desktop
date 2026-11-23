import { act, cleanup, render } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import { $teamSpaceDetailPane, detailPaneDisplaced, type TeamSpaceDetailPane, useTeamSpaceDetailPane } from './detail-pane'

afterEach(() => {
  cleanup()
  $teamSpaceDetailPane.set(null)
})

const setters: Partial<Record<TeamSpaceDetailPane, (open: boolean) => void>> = {}

function Owner({ kind }: { kind: TeamSpaceDetailPane }) {
  const [open, setOpen] = useState(false)
  setters[kind] = setOpen
  useTeamSpaceDetailPane(kind, open, () => setOpen(false))

  return open ? <p data-open={kind} /> : null
}

const openKinds = () => [...window.document.querySelectorAll('[data-open]')].map(node => node.getAttribute('data-open'))

describe('Team Space detail pane', () => {
  it('closes only an open owner of another kind', () => {
    expect(detailPaneDisplaced('thread', true, 'search')).toBe(true)
    expect(detailPaneDisplaced('thread', true, 'thread')).toBe(false)
    expect(detailPaneDisplaced('thread', false, 'search')).toBe(false)
    expect(detailPaneDisplaced('thread', true, null)).toBe(false)
  })

  it('keeps one pane open: opening another replaces it, closing releases it', () => {
    render(<><Owner kind="thread" /><Owner kind="search" /><Owner kind="task" /></>)

    act(() => setters.thread!(true))
    expect(openKinds()).toEqual(['thread'])
    expect($teamSpaceDetailPane.get()).toBe('thread')

    act(() => setters.search!(true))
    expect(openKinds()).toEqual(['search'])
    expect($teamSpaceDetailPane.get()).toBe('search')

    act(() => setters.task!(true))
    expect(openKinds()).toEqual(['task'])

    act(() => setters.task!(false))
    expect(openKinds()).toEqual([])
    expect($teamSpaceDetailPane.get()).toBeNull()
  })

  it('releases the pane when its owner unmounts (a removed role or a left company)', () => {
    const view = render(<Owner kind="info" />)

    act(() => setters.info!(true))
    expect($teamSpaceDetailPane.get()).toBe('info')

    view.unmount()
    expect($teamSpaceDetailPane.get()).toBeNull()
  })
})
