import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { I18nProvider } from '@/i18n'

import { parseExecutionStatusSnapshot } from '../../shared/execution-policy'
import allDisabledFixture from '../../shared/execution-policy/fixtures/execution-policy/v1/fixtures/status-all-disabled.response.json'
import unavailableFixture from '../../shared/execution-policy/fixtures/execution-policy/v1/fixtures/status-unavailable.response.json'
import workingFixture from '../../shared/execution-policy/fixtures/execution-policy/v1/fixtures/status-working.response.json'

import { MatrixExecutionMachines } from './execution-machines'

const status = (value: unknown) => parseExecutionStatusSnapshot(value)!

const page = (value: unknown, locale: 'en' | 'vi' | 'ja' | 'zh' | 'zh-hant' = 'en') => (
  <I18nProvider configClient={null} initialLocale={locale}>
    <MatrixExecutionMachines status={status(value)} />
  </I18nProvider>
)

afterEach(cleanup)

describe('execution machine strip', () => {
  it('renders provider order, current work and enablement without exposing destination IDs', () => {
    const view = render(page(workingFixture))
    const marks = view.container.querySelectorAll<HTMLElement>('[data-destination-kind]')

    expect([...marks].map(mark => mark.dataset.destinationKind)).toEqual(['mac', 'cloud', 'mac'])
    expect([...marks].map(mark => mark.dataset.destinationState)).toEqual(['working', 'ready', 'disabled'])
    expect([...marks].map(mark => mark.dataset.enabled)).toEqual(['true', 'true', 'false'])
    expect(marks[0].dataset.current).toBe('true')
    expect(marks[0].dataset.desired).toBe('true')
    expect(screen.getByRole('img', { name: 'Mac 1: Working' })).toBeTruthy()
    expect(screen.getByRole('img', { name: 'Cloud: Ready' })).toBeTruthy()
    expect(screen.getByRole('img', { name: 'Mac 2: Turned off' })).toBeTruthy()
    expect(view.container.textContent).not.toMatch(/[0-9a-f]{8}-[0-9a-f-]{27}/u)
  })

  it('animates only the active worker and lets reduced-motion disable that animation', () => {
    const view = render(page(workingFixture))
    const pulse = view.container.querySelector<HTMLElement>('[data-execution-working]')

    expect(pulse).toBeTruthy()
    expect(pulse?.className).toContain('motion-safe:animate-pulse')
    expect(view.container.querySelectorAll('[data-execution-working]')).toHaveLength(1)
  })

  it('shows all-disabled as an explicit paused state with no fake worker', () => {
    const view = render(page(allDisabledFixture))

    expect(view.container.querySelector('[data-execution-machines]')?.getAttribute('data-execution-state')).toBe(
      'paused'
    )
    expect(view.container.querySelectorAll('[data-enabled="false"]')).toHaveLength(2)
    expect(view.container.querySelector('[data-execution-working]')).toBeNull()
    expect(screen.getByRole('img', { name: 'Cloud: Turned off' })).toBeTruthy()
  })

  it('keeps real failure reasons distinct from an owner pause', () => {
    render(page(unavailableFixture))
    expect(screen.getByRole('img', { name: 'Cloud: Server unavailable' })).toBeTruthy()
    expect(screen.getByRole('img', { name: 'Mac 1: Not online' })).toBeTruthy()
  })

  it.each(['en', 'vi', 'ja', 'zh', 'zh-hant'] as const)('provides private, localized labels in %s', locale => {
    const view = render(page(workingFixture, locale))
    const group = screen.getByRole('group')

    expect(group.getAttribute('aria-label')).toBeTruthy()
    expect(view.container.querySelectorAll('[role="img"]')).toHaveLength(3)
    expect(view.container.innerHTML).not.toContain('22222222-2222')
  })

  it('shows a Mac held for the owner’s plan as waiting for it, not as a fault', () => {
    const MAC_A = 'mac:00000000-0000-4000-8000-b454f82c5857'
    const MAC_B = 'mac:00000000-0000-4000-8000-f6222a1106ee'

    // 0238: the cloud is first and the owner’s access lapsed; the Macs are held for the remedy.
    const lapsed = {
      ...workingFixture,
      state: 'unavailable',
      current: null,
      desired: null,
      order: ['cloud', MAC_A, MAC_B],
      destinations: {
        cloud: { state: 'degraded', reason: 'entitlement_required', observedAt: 1791876998000 },
        [MAC_A]: { state: 'degraded', reason: 'entitlement_required', observedAt: 1791876999000 },
        [MAC_B]: { state: 'disabled', reason: 'owner_disabled', observedAt: 1791876997000 }
      }
    }

    const view = render(page(lapsed))
    const marks = view.container.querySelectorAll<HTMLElement>('[data-destination-kind]')

    expect(screen.getByRole('img', { name: 'Mac 1: Waiting for the plan' })).toBeTruthy()
    expect(screen.getByRole('img', { name: 'Cloud: Plan required' })).toBeTruthy()
    expect([...marks].map(mark => mark.dataset.destinationWaiting)).toEqual([undefined, 'true', undefined])
    expect(marks[1].className).not.toContain('atum-danger')
    expect(marks[0].className).toContain('atum-danger')
    cleanup()

    render(page(lapsed, 'vi'))
    expect(screen.getByRole('img', { name: 'Máy Mac 1: Đang chờ gói dịch vụ' })).toBeTruthy()
  })
})
