import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { I18nProvider } from '@/i18n'

import { MembershipLineView, type MembershipLineViewProps } from './membership-line'

afterEach(cleanup)

const line = (props: Partial<MembershipLineViewProps> = {}, locale: 'en' | 'vi' = 'en') =>
  render(
    <I18nProvider configClient={null} initialLocale={locale}>
      <MembershipLineView kind="joined" name="Linh" timestamp={Date.UTC(2026, 9, 24, 8, 30)} you={false} {...props} />
    </I18nProvider>
  )

describe("a Team Space channel's join and departure lines", () => {
  it('say who joined, and "You" when it is the viewer', () => {
    line()
    expect(screen.getByText('Linh joined the channel')).toBeTruthy()
    cleanup()

    line({ you: true, name: '' })
    expect(screen.getByText('You joined the channel')).toBeTruthy()
  })

  it('say who is no longer in the channel, without saying whether they left or were removed', () => {
    line({ kind: 'departed' })
    expect(screen.getByText('Linh is no longer in this channel')).toBeTruthy()
    cleanup()

    line({ kind: 'departed', you: true, name: '' })
    expect(screen.getByText('You are no longer in this channel')).toBeTruthy()
  })

  it('are worded in the window language', () => {
    line({ kind: 'departed' }, 'vi')
    expect(screen.getByText('Linh không còn trong kênh này')).toBeTruthy()
  })

  it('keep the time in a tooltip and mark which kind of line they are', () => {
    line()

    const element = screen.getByText('Linh joined the channel')
    expect(element.getAttribute('data-matrix-membership-line')).toBe('joined')
    expect(element.getAttribute('title')).toMatch(/2026/u)
  })

  it('draw without a tooltip rather than fail on a time that is not one', () => {
    line({ timestamp: Number.NaN })

    expect(screen.getByText('Linh joined the channel').getAttribute('title')).toBeNull()
  })
})
