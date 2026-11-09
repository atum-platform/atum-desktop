import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AtumAccountStatus } from '@/lib/atum-account-client'

/**
 * The "Pet settings…" bug class: `settings/index.tsx` resolves `?tab=` through
 * `useRouteEnumParam` against an allowlist, and a target outside the list is
 * SILENTLY coerced to the default view — #264 shipped `?tab=appearance`, which
 * never resolved in any shell, so the menu opened General settings and the pet
 * settings were unreachable. Nobody saw it until a verifier drove the menu.
 *
 * Three guards, one file:
 *
 *   1. BEHAVIORAL — the account menu's "Pet settings…" row is clicked for real
 *      and its destination is asserted against the very allowlists the settings
 *      page accepts, for BOTH shells. If the target ever stops resolving, this
 *      fails loudly instead of coercing silently.
 *   2. STATIC — every other literal `?tab=` link to Settings under
 *      `src/app/atum/` is scanned out of the sources and asserted against the
 *      same union, so a new link cannot reintroduce the class.
 *   3. BEHAVIORAL, CONSUMER-REACHABLE — the advanced-only targets a consumer
 *      can actually reach under the Atum shell (the hatch's "Set up", a
 *      Capabilities row, mod+/) are RENDERED against the real SettingsView
 *      with Advanced off, and must land on their own view: the page answers
 *      them by entering Advanced, never by coercing to General.
 */

// Spread the real module and override only what this test pins: a hand-picked
// partial mock breaks each time the menu's store chain reaches one more export.
vi.mock('@/store/atum-messaging', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()
  const { atom } = await import('nanostores')

  return {
    ...actual,
    $atumAccountScopeId: atom('account-1'),
    $atumAccountStatus: atom<AtumAccountStatus>({
      state: 'signed_in',
      configured: true,
      account: { id: 'account-1', displayName: 'An Example', handle: 'minh' },
      errorCode: null,
      providers: { google: true, password: false }
    } as AtumAccountStatus),
    refreshAtumAccountStatus: vi.fn(),
    signInToAtum: vi.fn(async () => undefined),
    signOutOfAtum: vi.fn()
  }
})

const { I18nProvider } = await import('@/i18n')

// The real SettingsView with labelled stubs for each leaf view, so a render
// proves WHICH view a ?tab= resolved to without dragging every leaf's data
// chain into jsdom.
vi.mock('../settings/about-settings', () => ({ AboutSettings: () => <div data-settings-view="about" /> }))
vi.mock('../settings/appearance-settings', () => ({ AppearanceSettings: () => <div data-settings-view="config:appearance" /> }))
vi.mock('../settings/atum-account-settings', () => ({ AtumAccountSettings: () => <div data-settings-view="atum:account" /> }))
vi.mock('../settings/atum-consumer-settings', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  AtumConsumerSettings: () => <div data-settings-view="atum:general" />
}))
vi.mock('../settings/atum-protons-settings', () => ({ AtumProtonsSettings: () => <div data-settings-view="atum:protons" /> }))
vi.mock('../settings/billing', () => ({ BillingSettings: () => <div data-settings-view="billing" /> }))
vi.mock('../settings/config-settings', () => ({
  ConfigSettings: ({ activeSectionId }: { activeSectionId: string }) => <div data-settings-view={`config:${activeSectionId}`} />
}))
vi.mock('../settings/gateway-settings', () => ({ GatewaySettings: () => <div data-settings-view="gateway" /> }))
vi.mock('../settings/keybind-settings', () => ({ KeybindSettings: () => <div data-settings-view="keybinds" /> }))
vi.mock('../settings/keys-settings', () => ({
  KEYS_VIEWS: ['tools', 'settings'],
  KeysSettings: () => <div data-settings-view="keys" />
}))
vi.mock('../settings/notifications-settings', () => ({ NotificationsSettings: () => <div data-settings-view="notifications" /> }))
vi.mock('../settings/plugins-settings', () => ({ PluginsSettings: () => <div data-settings-view="plugins" /> }))
vi.mock('../settings/providers-settings', () => ({
  PROVIDER_VIEWS: ['accounts', 'keys', 'custom-endpoints'],
  ProvidersSettings: () => <div data-settings-view="providers" />
}))
vi.mock('../settings/sessions-settings', () => ({ SessionsSettings: () => <div data-settings-view="sessions" /> }))

const { $atumProtonWallet } = await import('@/store/atum-proton-wallet')
const { $atumShellEnabled, resetAtumShellState } = await import('@/store/atum-shell')
const { $petInfoByAgent, syncActivePetViews } = await import('@/store/pet')
const { $activeGatewayProfile, $gatewaySwapTarget } = await import('@/store/profile')
const { ATUM_CONSUMER_SETTINGS_VIEWS, ATUM_ADVANCED_SETTINGS_VIEWS, LEGACY_SETTINGS_VIEWS, SettingsView } = await import('../settings/index')
const { PET_SETTINGS_SECTION_ID } = await import('../settings/pet-settings')
const { AtumAccountMenu } = await import('./account-footer-menu')

function LocationProbe() {
  const { hash, search } = useLocation()

  return <output data-testid="destination">{`${search}${hash}`}</output>
}

function openPetSubmenuAndClick(itemName: RegExp) {
  render(
    <I18nProvider configClient={null} initialLocale="en">
      <MemoryRouter>
        <AtumAccountMenu><button>Account menu</button></AtumAccountMenu>
        <LocationProbe />
      </MemoryRouter>
    </I18nProvider>
  )
  // Radix opens on keyboard in jsdom (no pointer events); ArrowRight opens a
  // submenu from its trigger, the same way account-footer-menu.test.tsx drives it.
  fireEvent.keyDown(screen.getByRole('button', { name: 'Account menu' }), { key: 'ArrowDown' })
  fireEvent.keyDown(screen.getByRole('menuitem', { name: /^Pet$/u }), { key: 'ArrowRight' })
  fireEvent.click(screen.getByRole('menuitem', { name: itemName }))

  const destination = screen.getByTestId('destination').textContent ?? ''
  const [search] = destination.split('#')

  return { destination, tab: new URLSearchParams(search).get('tab') }
}

beforeEach(() => {
  resetAtumShellState()
  $atumProtonWallet.set({ state: 'idle', accountId: 'account-1', knownSpendingEnabled: false })
  $activeGatewayProfile.set('default')
  $petInfoByAgent.set({ default: { displayName: 'Gigi', enabled: true, slug: 'gigi' } })
  syncActivePetViews()
  $gatewaySwapTarget.set(null)
})

afterEach(() => {
  $gatewaySwapTarget.set(null)
  $atumShellEnabled.set(true)
  cleanup()
})

describe('the account menu’s "Pet settings…" destination', () => {
  it('resolves to a view the Atum-shell settings page accepts, anchored to the pet section', () => {
    $atumShellEnabled.set(true)

    const { destination, tab } = openPetSubmenuAndClick(/^Pet settings…$/u)

    // The accepted list with Advanced OFF — the state every consumer is in.
    expect(ATUM_CONSUMER_SETTINGS_VIEWS).toContain(tab)
    expect(destination).toContain(`#${PET_SETTINGS_SECTION_ID}`)
  })

  it('keeps resolving under the legacy shell, where pet settings live in Appearance', () => {
    $atumShellEnabled.set(false)

    const { destination, tab } = openPetSubmenuAndClick(/^Pet settings…$/u)

    expect(LEGACY_SETTINGS_VIEWS).toContain(tab)
    expect(destination).toContain(`#${PET_SETTINGS_SECTION_ID}`)
  })
})

// ── Static guard: every literal `?tab=` link to Settings anywhere in src/ ──
// The whole renderer, not just src/app/atum: the same broken "Pet settings"
// target was copied into the in-window pet, the popped-out pet bridge and the
// store's own "Manage installed" link, none of which live under atum/.

const SRC_DIR = resolve(__dirname, '..', '..')

const atumSources = readdirSync(SRC_DIR, { recursive: true })
  .map(entry => String(entry))
  .filter(entry => (entry.endsWith('.tsx') || entry.endsWith('.ts')) && !entry.includes('.test.'))
  .map(entry => [entry, readFileSync(join(SRC_DIR, entry), 'utf8')] as const)

// Both call-site shapes: `` navigate(`${SETTINGS_ROUTE}?tab=x`) `` and a plain
// '/settings?tab=x' string literal. Targets are the literal segment after
// `tab=`, so template expressions (like the menu's shell-aware helper, covered
// behaviorally above) simply don't match.
// The negative lookahead refuses a capture cut short by a template expression:
// `?tab=config:${section.id}` would otherwise read as the bogus target `config:`.
const SETTINGS_TAB_LINK = /(?:\$\{SETTINGS_ROUTE\}|\/settings)\?tab=([A-Za-z:-]+)(?![A-Za-z:$-])/gu

describe('settings ?tab= links anywhere in the renderer', () => {
  it('every literal target is a view the settings page accepts in some shell — never a silent coercion', () => {
    const accepted = new Set<string>([
      ...ATUM_CONSUMER_SETTINGS_VIEWS,
      ...ATUM_ADVANCED_SETTINGS_VIEWS,
      ...LEGACY_SETTINGS_VIEWS,
      // Not a view: SettingsView redirects `?tab=mcp` to Capabilities before
      // useRouteEnumParam can coerce it (settings/index.tsx).
      'mcp'
    ])

    const found: Array<{ file: string; tab: string }> = []

    for (const [file, source] of atumSources) {
      for (const match of source.matchAll(SETTINGS_TAB_LINK)) {
        found.push({ file, tab: match[1]! })
      }
    }

    // The scan must keep seeing the links it guards: zero matches means the
    // regex drifted from the call-site shape, not that the links are gone.
    expect(found.length).toBeGreaterThanOrEqual(3)

    for (const { file, tab } of found) {
      expect(
        accepted.has(tab),
        `${file} links to /settings?tab=${tab}, which no settings-shell allowlist accepts — useRouteEnumParam would silently coerce it to the default view`
      ).toBe(true)
    }
  })
})


// ── Behavioral guard: links a CONSUMER can reach under the Atum shell ──
// The static union above accepts a target valid only with Advanced on. These
// are the advanced-only targets a consumer can actually be handed, rendered
// against the real SettingsView with Advanced OFF: each must land on its own
// view (the page enters Advanced for it), never coerce to General.

function renderSettingsAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  return render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider configClient={null} initialLocale="en">
        <MemoryRouter initialEntries={[path]}>
          <SettingsView onClose={() => undefined} />
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>
  )
}

describe('settings ?tab= links a consumer can reach under the Atum shell', () => {
  it.each([
    // The hatch's "Set up" (pet-generate-content.tsx), reached from the Pets shelf.
    ['providers', 'providers'],
    // Capabilities' vision "Model" link (skills/index.tsx), which the Skills
    // shelf's "Manage installed →" leads to.
    ['config:model&aux=vision', 'config:model'],
    // A toolset's "manage keys" (toolset-config-panel.tsx), in Capabilities.
    ['keys&key=FOO', 'keys'],
    // mod+/ (use-keybinds.ts).
    ['keybinds', 'keybinds']
  ])('/settings?tab=%s lands on its own view with Advanced off, never on General', (query, view) => {
    $atumShellEnabled.set(true)
    renderSettingsAt(`/settings?tab=${query}`)

    expect(globalThis.document.querySelector(`[data-settings-view="${view}"]`)).toBeTruthy()
    expect(globalThis.document.querySelector('[data-settings-view="atum:general"]')).toBeNull()
  })

  it('a plain open still starts on General with Advanced off', () => {
    $atumShellEnabled.set(true)
    renderSettingsAt('/settings')

    expect(globalThis.document.querySelector('[data-settings-view="atum:general"]')).toBeTruthy()
  })

  it('offers Advanced as a page and keeps provider management reachable from it', () => {
    renderSettingsAt('/settings')

    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }))
    expect(screen.getByRole('heading', { name: 'Advanced' })).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Models & providers' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Choose' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Manage' }))
    expect(globalThis.document.querySelector('[data-settings-view="providers"]')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Advanced' }))
    expect(screen.getByRole('heading', { name: 'Advanced' })).toBeTruthy()
  })

  it('opens the Advanced page directly from a saved link', () => {
    renderSettingsAt('/settings?tab=atum:advanced')
    expect(screen.getByRole('heading', { name: 'Advanced' })).toBeTruthy()
  })
})
