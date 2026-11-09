import { act, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixSnapshot, MatrixUiBridge } from '../../shared/matrix'

import { PersonSearch } from './person-search'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('shared people search', () => {
  it('waits for two characters, debounces, and shows native directory people', async () => {
    vi.useFakeTimers()
    const search = vi.fn(async () => ({ ok: true as const, value: {
      limited: false, results: [{ userId: '@nguyen:test', name: 'Nguyễn' }]
    } }))
    window.atumMatrix = { people: { search, privacy: vi.fn(), setPrivacy: vi.fn() } } as unknown as MatrixUiBridge
    const snapshot = { identity: { userId: '@me:test', deviceId: 'DEVICE' }, rooms: [], agents: [] } as unknown as MatrixSnapshot

    function Harness() {
      const [query, setQuery] = useState('')
      return <PersonSearch label="Find people" offer={() => ({ note: 'Available' })}
        onQueryChange={setQuery} placeholder="Find people" query={query} snapshot={snapshot} />
    }
    render(<I18nProvider configClient={null} initialLocale="en"><Harness /></I18nProvider>)
    const field = screen.getByRole('textbox', { name: 'Find people' })
    fireEvent.change(field, { target: { value: 'n' } })
    await act(async () => { vi.advanceTimersByTime(300) })
    expect(search).not.toHaveBeenCalled()
    fireEvent.change(field, { target: { value: 'nguyen' } })
    await act(async () => { vi.advanceTimersByTime(249) })
    expect(search).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(search).toHaveBeenCalledWith({ query: 'nguyen', limit: 20 })
    expect(screen.getByText('Nguyễn')).toBeTruthy()
  })
})
