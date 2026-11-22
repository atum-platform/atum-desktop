import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type {
  MatrixWorkAssistants,
  MatrixWorkPlanConsent,
  MatrixWorkProjection,
  MatrixWorkViewState
} from '../../../shared/matrix-work'

import { macLabelsFor } from './plan-consent'
import { $work, $workActive, $workPlanConsent, resetWorkStoreForTests } from './store'
import { MatrixWorkSettings } from './work-settings'

const THIS_MAC = '00000000-0000-4000-8000-00000000a001'
const OTHER_MAC = '00000000-0000-4000-8000-00000000a002'
const RIN = '00000000-0000-4000-8000-00000000b001'
const LUNA = '00000000-0000-4000-8000-00000000b002'
const AGENTS = [
  { principal: RIN, name: 'Rin' },
  { principal: LUNA, name: 'Luna' }
]
const OFF: MatrixWorkPlanConsent = {
  state: 'off',
  agents: [],
  eligible: [RIN, LUNA],
  macs: [{ id: THIS_MAC, thisMac: true, named: false }],
  alsoWhenScheduled: false
}
const ON: MatrixWorkPlanConsent = {
  state: 'on',
  agents: [RIN],
  eligible: [RIN, LUNA],
  macs: [{ id: THIS_MAC, thisMac: true, named: true }],
  alsoWhenScheduled: false,
  grantedAt: Date.UTC(2026, 10, 22, 9)
}

beforeEach(resetWorkStoreForTests)
afterEach(cleanup)

const projection = (view: MatrixWorkViewState, assistants: MatrixWorkAssistants = 'on'): MatrixWorkProjection => ({
  view,
  assistants,
  agents: [],
  protons: 'ok'
})

function bridge(consent: MatrixWorkPlanConsent = OFF) {
  return {
    setWork: vi.fn(async (_on: boolean) => {}),
    setAssistants: vi.fn(async (_on: boolean) => {}),
    setPlan: vi.fn(async (_on: boolean) => {}),
    openPlanConnect: vi.fn(async () => {}),
    readPlanConsent: vi.fn(async () => consent),
    setPlanConsent: vi.fn(async (_input: { agents: string[]; macs: string[]; alsoWhenScheduled: boolean }) => ON),
    revokePlanConsent: vi.fn(async () => ({ ...OFF, grantedAt: ON.grantedAt }))
  }
}

function show(port = bridge(), locale: 'en' | 'vi' = 'en') {
  render(
    <I18nProvider configClient={null} initialLocale={locale}>
      <MatrixWorkSettings agents={AGENTS} bridge={port} />
    </I18nProvider>
  )

  return port
}

describe('MatrixWorkSettings: the plan switch and its consent (gate 4b)', () => {
  const SWITCH = 'Agents may use my ChatGPT plan here'

  it('is drawn only while a plan is connected here or the switch is on, with one line', async () => {
    $work.set(projection('ready'))
    show()
    expect(screen.queryByRole('switch', { name: SWITCH })).toBeNull()

    cleanup()
    $work.set({ ...projection('ready'), plan: 'off' })
    show()
    const row = await screen.findByRole('switch', { name: SWITCH })

    expect(row.getAttribute('data-state')).toBe('unchecked')
    expect(screen.getByText('Only the assistants you allow. Off stops their plan work at once.')).toBeTruthy()
  })

  it('turning it on without a consent opens the one consent sheet: nothing chosen but this Mac, Allow names it and turns it on', async () => {
    $work.set({ ...projection('ready'), plan: 'off' })
    const port = show()

    fireEvent.click(await screen.findByRole('switch', { name: SWITCH }))
    expect(port.setPlan).not.toHaveBeenCalled()
    expect($workPlanConsent.get()).toEqual({ thisMac: true })

    const sheet = await screen.findByRole('dialog', { name: 'Let assistants use your ChatGPT plan?' })
    expect(sheet.getAttribute('data-atum-work-plan-consent')).toBe('off')
    const rin = await screen.findByRole('checkbox', { name: 'Rin' })
    expect(rin.getAttribute('data-state')).toBe('unchecked')
    expect(screen.getByRole('checkbox', { name: 'Luna' }).getAttribute('data-state')).toBe('unchecked')
    expect(screen.getByRole('switch', { name: 'Also for scheduled tasks' }).getAttribute('data-state')).toBe('unchecked')

    const allow = screen.getByRole('button', { name: 'Allow' })
    expect(allow.hasAttribute('disabled')).toBe(true)
    fireEvent.click(rin)
    fireEvent.click(allow)

    await waitFor(() =>
      expect(port.setPlanConsent).toHaveBeenCalledWith({ agents: [RIN], macs: [THIS_MAC], alsoWhenScheduled: false })
    )
    await waitFor(() => expect(port.setPlan).toHaveBeenCalledWith(true))
    await waitFor(() => expect($workPlanConsent.get()).toBeNull())
  })

  it('with a consent naming this Mac, says who and since when, and the switch acts at once', async () => {
    $work.set({ ...projection('ready'), plan: 'off' })
    const port = show(bridge(ON))

    expect(await screen.findByText(/^Rin · since /u)).toBeTruthy()
    fireEvent.click(screen.getByRole('switch', { name: SWITCH }))
    await waitFor(() => expect(port.setPlan).toHaveBeenCalledWith(true))
    expect($workPlanConsent.get()).toBeNull()
  })

  it('Change opens the sheet on what the consent names; Turn off everywhere revokes in one tap', async () => {
    $work.set({ ...projection('ready'), plan: 'on' })
    const port = show(bridge({ ...ON, macs: [...ON.macs, { id: OTHER_MAC, thisMac: false, named: false, name: 'Studio Mac' }] }))

    fireEvent.click(await screen.findByRole('button', { name: 'Change' }))
    expect(await screen.findByText(/^Allowed since /u)).toBeTruthy()
    expect((await screen.findByRole('checkbox', { name: 'Rin' })).getAttribute('data-state')).toBe('checked')
    expect(screen.getByRole('checkbox', { name: 'This Mac' }).getAttribute('data-state')).toBe('checked')
    expect(screen.getByRole('checkbox', { name: 'Studio Mac' }).getAttribute('data-state')).toBe('unchecked')

    fireEvent.click(screen.getByRole('button', { name: 'Turn off everywhere' }))
    await waitFor(() => expect(port.revokePlanConsent).toHaveBeenCalledOnce())
    expect(port.setPlanConsent).not.toHaveBeenCalled()
  })

  it('can always be turned off while it is on, and goes with Work itself', async () => {
    $work.set({ ...projection('ready'), plan: 'on' })
    const port = show()

    fireEvent.click(await screen.findByRole('switch', { name: SWITCH }))
    await waitFor(() => expect(port.setPlan).toHaveBeenCalledWith(false))

    $work.set({ ...projection('off'), plan: 'on' })
    await waitFor(() => expect(screen.queryByRole('switch', { name: SWITCH })).toBeNull())
  })

  it('says so when the consent could not be saved, and keeps the sheet open', async () => {
    $work.set({ ...projection('ready'), plan: 'off' })
    const port = bridge()
    port.setPlanConsent.mockRejectedValueOnce(new Error('device_services_403'))
    show(port)

    fireEvent.click(await screen.findByRole('switch', { name: SWITCH }))
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Luna' }))
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }))
    expect(await screen.findByText('Couldn’t save just now.')).toBeTruthy()
    expect(port.setPlan).not.toHaveBeenCalled()
    expect($workPlanConsent.get()).toEqual({ thisMac: true })
  })

  it('speaks Vietnamese in the Vietnamese app', async () => {
    $work.set({ ...projection('ready'), plan: 'off' })
    show(bridge(), 'vi')
    expect(await screen.findByRole('switch', { name: 'Cho phép trợ lý dùng gói ChatGPT của tôi tại đây' })).toBeTruthy()
  })
})

describe('MatrixWorkSettings: Connect your ChatGPT plan (gate 4a)', () => {
  it('has no row while gate 4a is closed', () => {
    $work.set(projection('ready'))
    show()
    expect(document.querySelector('[data-atum-work-plan-connect-row]')).toBeNull()
  })

  it('offers Connect, which shows Work and opens T3\'s own screen; Manage once connected', async () => {
    $work.set({ ...projection('ready'), planConnect: 'offer' })
    const port = show()

    expect(screen.getByText('Use your Plus or Pro plan in Work.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await waitFor(() => expect(port.openPlanConnect).toHaveBeenCalledOnce())
    expect($workActive.get()).toBe(true)

    $work.set({ ...projection('ready'), planConnect: 'connected' })
    expect(await screen.findByText('Connected on this Mac')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Manage' })).toBeTruthy()
  })
})

describe('MatrixWorkSettings', () => {
  it('draws nothing while main reports no Work for this account, or has not said yet', () => {
    $work.set(null)
    show()
    expect(document.querySelector('[data-matrix-work-settings]')).toBeNull()

    cleanup()
    $work.set(undefined)
    show()
    expect(document.querySelector('[data-matrix-work-settings]')).toBeNull()
  })

  it('one switch turns Work off, and the assistants\' switch goes with it', async () => {
    $work.set(projection('ready'))
    const port = show()

    const work = screen.getByRole('switch', { name: 'Work on this Mac' })
    expect(work.getAttribute('data-state')).toBe('checked')
    expect(screen.getByRole('switch', { name: 'Assistants can start work here' }).getAttribute('data-state')).toBe('checked')

    fireEvent.click(work)
    await waitFor(() => expect(port.setWork).toHaveBeenCalledWith(false))

    $work.set(projection('off'))
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Work on this Mac' }).getAttribute('data-state')).toBe('unchecked'))
    expect(screen.queryByRole('switch', { name: 'Assistants can start work here' })).toBeNull()
  })

  it('turns Work back on from its own row', async () => {
    $work.set(projection('off'))
    const port = show()

    fireEvent.click(screen.getByRole('switch', { name: 'Work on this Mac' }))
    await waitFor(() => expect(port.setWork).toHaveBeenCalledWith(true))
  })

  it('the assistants\' switch follows the gate, and only where it means something', async () => {
    $work.set(projection('ready', 'off'))
    const port = show()

    const assistants = screen.getByRole('switch', { name: 'Assistants can start work here' })
    expect(assistants.getAttribute('data-state')).toBe('unchecked')
    fireEvent.click(assistants)
    await waitFor(() => expect(port.setAssistants).toHaveBeenCalledWith(true))

    for (const state of ['not_enrolled', 'needs_grant'] as const) {
      cleanup()
      $work.set(projection('ready', state))
      show()
      expect(screen.queryByRole('switch', { name: 'Assistants can start work here' })).toBeNull()
      expect(screen.getByRole('switch', { name: 'Work on this Mac' })).toBeTruthy()
    }
  })

  it('says so, once, when a change did not go through, and keeps the switch usable', async () => {
    $work.set(projection('ready'))
    const port = bridge()
    port.setWork.mockRejectedValueOnce(new Error('work_off_failed'))
    show(port)

    fireEvent.click(screen.getByRole('switch', { name: 'Work on this Mac' }))
    expect(await screen.findByText('Could not change Work just now.')).toBeTruthy()
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Work on this Mac' }).hasAttribute('disabled')).toBe(false))
  })

  it('reads in Vietnamese', () => {
    $work.set(projection('ready'))
    show(bridge(), 'vi')

    expect(screen.getByRole('switch', { name: 'Work trên máy Mac này' })).toBeTruthy()
    expect(screen.getByRole('switch', { name: 'Trợ lý có thể bắt đầu việc tại đây' })).toBeTruthy()
  })
})

describe('macLabelsFor: the other Macs are named by their owner, stably', () => {
  const mac = (id: string, name?: string, thisMac = false) => ({ id, thisMac, named: false, ...(name ? { name } : {}) })
  const ordinal = (index: number) => `Your other Mac ${index}`

  it('uses the registry name, numbers two Macs that share one, and falls back to the ordinal only without a name', () => {
    const labels = macLabelsFor(
      [mac('a', undefined, true), mac('b', 'Studio Mac'), mac('c', 'MacBook Pro'), mac('d', 'MacBook Pro'), mac('e'), mac('f')],
      ordinal
    )

    expect(labels.has('a')).toBe(false)
    expect(labels.get('b')).toBe('Studio Mac')
    expect([labels.get('c'), labels.get('d')]).toEqual(['MacBook Pro 1', 'MacBook Pro 2'])
    expect([labels.get('e'), labels.get('f')]).toEqual(['Your other Mac 1', 'Your other Mac 2'])
  })

  it('does not change when the Mac list is read again in the same order', () => {
    const macs = [mac('b', 'MacBook Pro'), mac('c', 'MacBook Pro')]

    expect([...macLabelsFor(macs, ordinal)]).toEqual([...macLabelsFor([...macs], ordinal)])
  })
})
