import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'

import { Button } from '@/components/ui/button'
import { I18nProvider } from '@/i18n'

import moonFixture from '../../../shared/__fixtures__/look-pack-v1/fixtures/moon.published.json'
import { ACME, botApp } from '../../../shared/app-catalog.test-support'
import { decodeLookPack } from '../../../shared/look-pack'

import { AppStartDialog } from './start-dialog'

const styles = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8')

afterEach(cleanup)

it('keeps the dialog material, ink and controls in the root appearance scope', async () => {
  const app = { ...botApp(ACME), look: decodeLookPack(moonFixture) }
  const view = render(
    <I18nProvider configClient={null} initialLocale="en">
      <main className="atum-shell">
        <section data-atum-chat data-atum-look="pack" data-testid="chat">
          <AppStartDialog app={app} line="Chat with Acme right here in Atum.">
            <Button type="button">Connect app</Button>
          </AppStartDialog>
        </section>
      </main>
    </I18nProvider>
  )

  const dialog = await screen.findByRole('dialog', { name: 'Acme' })
  const chat = view.getByTestId('chat')

  // The portal moves the dialog into the themed chat column instead of body.
  // The floating surface then resets every contrast token to the root/system
  // appearance rather than inheriting the conversation backdrop's white ink.
  expect(dialog.closest('[data-atum-chat]')).toBe(chat)
  expect(chat.getAttribute('data-atum-look')).toBe('pack')
  expect(dialog.className).toContain('atum-sheet')
  const band = dialog.querySelector<HTMLElement>('[data-app-start-band]')!
  expect(band.style.getPropertyValue('--look-base')).toBe('#0E1D60')
  expect(band.style.getPropertyValue('--look-l1-opacity')).toBe('0.45')
  expect(screen.getByRole('button', { name: 'Connect app' }).getAttribute('data-variant')).toBe('default')

  // Pin the shared CSS contract: every affected in-chat surface resets both
  // sides of the contrast pair from the root scope, never from an app slug.
  const scopedRule = styles.match(/\[data-atum-chat\]\s+:is\(([^)]*)\)\s*\{([^}]*)\}/u)

  expect(scopedRule?.[1]).toContain('.atum-sheet')
  expect(scopedRule?.[1]).toContain('.atum-glass-card')
  expect(scopedRule?.[1]).toContain('.notice-band')
  expect(scopedRule?.[2]).toContain('--atum-glass-strong: var(--atum-root-glass-strong)')
  expect(scopedRule?.[2]).toContain('--atum-ink: var(--atum-root-ink)')
  expect(scopedRule?.[2]).toContain('--atum-on-accent: var(--atum-root-on-accent)')
  expect(scopedRule?.[2]).not.toMatch(/moon|andy|acme|conversation-surface/u)

  expect(styles).toContain('--atum-root-ink: #1B1D22')
  expect(styles).toContain('--atum-root-ink: #ECEDF0')
})

it('keeps the root-scope start-card copy above 4.5:1 in system light and dark', () => {
  const luminance = (hex: string) => {
    const channels = [1, 3, 5].map(offset => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
    const linear = channels.map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)

    return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!
  }
  const contrast = (left: string, right: string) => {
    const [bright, dark] = [luminance(left), luminance(right)].sort((a, b) => b - a)

    return (bright! + 0.05) / (dark! + 0.05)
  }

  expect(contrast('#3B3F47', '#FFFFFF')).toBeGreaterThanOrEqual(4.5)
  expect(contrast('#D9DBE0', '#2D2D2D')).toBeGreaterThanOrEqual(4.5)
})
