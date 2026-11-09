import { useStore } from '@nanostores/react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixAgentRoutine, MatrixAgentRoutinesSnapshot, MatrixRoutinesBridge } from '../../../shared/agent-routines'
import { ACME, botApp } from '../../../shared/app-catalog.test-support'
import type { MatrixBackgroundSweepBridge } from '../../../shared/background-sweep'
import { MATRIX_BACKGROUND_SWEEP_SETTING_PROFILE } from '../../../shared/background-sweep'
import type { MatrixExecutionPolicyBridge, MatrixExecutionPolicyView } from '../../../shared/execution-policy'
import { parseExecutionPolicySnapshot, parseExecutionStatusSnapshot } from '../../../shared/execution-policy'
import policyFixture from '../../../shared/execution-policy/fixtures/execution-policy/v1/fixtures/policy-saved.response.json'
import statusFixture from '../../../shared/execution-policy/fixtures/execution-policy/v1/fixtures/status-working.response.json'
import type { MatrixAgentView, MatrixSnapshot, MatrixUiBridge } from '../../../shared/matrix'
import type { MatrixAliasBridge, MatrixAliasRequest } from '../../../shared/matrix-aliases'
import type { MatrixAssistantCard, MatrixAssistantCardsBridge } from '../../../shared/matrix-assistant-card'
import { PRIMARY_ASSISTANT_KEEPS_NAME } from '../../../shared/matrix-assistant-name'
import { defaultMatrixCheckInSettings, emptyMatrixCheckInLedger } from '../../../shared/matrix-check-ins'

import { $backgroundSweepSettings } from './store'

import {
  $assistantCard,
  $assistantNameOverrides,
  AssistantCardHost,
  openAssistantCard,
  withAssistantNames
} from '.'

const LAN = 'agent-lan'
const ATUM = 'agent-atum'

const agent = (principal: string, name: string, extra: Partial<MatrixAgentView> = {}): MatrixAgentView => ({
  principal,
  userId: `@${principal}:atum.chat`,
  name,
  isDefault: principal === ATUM,
  ready: true,
  hermes: 'ready',
  readiness: { phase: 'ready', since: 1 },
  atumModel: true,
  ...extra
})

const SOUL = '# Lan\n\n## Who you are\n\nĐiềm tĩnh.\n\n## What you do\n\nLo lịch họp.\n\n## Rules\n\nNo Fridays.'

const CUSTOM_SOUL =
  "# Lan\n\nYou are Lan, Minh's research partner.\n\n## Rules\n\nKeep citations exact.\n\n## Who you are\n\nWarm and candid.\n\n## Memory\n\nRemember durable decisions.\n"

/** The Mac's owner name, as main projects it from `GET /device-services` (§9.4). */
const policyView = (): MatrixExecutionPolicyView => ({
  policy: parseExecutionPolicySnapshot(policyFixture)!,
  status: parseExecutionStatusSnapshot(statusFixture)!,
  stale: false,
  deviceNames: { '00000000-0000-4000-8000-b454f82c5857': { displayName: 'Mac mini', thisMac: false } }
})

function snapshot(): MatrixSnapshot {
  return {
    state: 'ready',
    identity: { userId: '@minh:atum.chat', deviceId: 'MAC' },
    rooms: [],
    messages: [],
    agents: [agent(ATUM, 'Atum'), agent(LAN, 'Lan'), agent('agent-mai', 'Mai')]
  } as unknown as MatrixSnapshot
}

function card(principal: string, extra: Partial<MatrixAssistantCard> = {}): MatrixAssistantCard {
  return {
    principal,
    displayName: principal === ATUM ? 'Atum' : 'Lan',
    isDefault: principal === ATUM,
    soul: principal === ATUM ? '# Atum\n\nYou are Atum.' : SOUL,
    inherited: principal === ATUM,
    skills: ['google-calendar'],
    definitionRevision: 2,
    identityRevision: 1,
    ...extra
  }
}

/** The window as app.tsx composes it: the snapshot with the card's names, and the card. */
function Window({ base }: { base: MatrixSnapshot }) {
  const names = useStore($assistantNameOverrides)
  const shown = withAssistantNames(base, names)

  return (
    <I18nProvider configClient={null} initialLocale="vi">
      <ul>
        {shown.agents?.map(each => (
          <li data-roster-name key={each.principal}>
            {each.name}
          </li>
        ))}
      </ul>
      <AssistantCardHost compact={false} snapshot={shown} />
    </I18nProvider>
  )
}

let assistants: { read: ReturnType<typeof vi.fn>; save: ReturnType<typeof vi.fn>; avatar: ReturnType<typeof vi.fn> }

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  assistants = {
    read: vi.fn<MatrixAssistantCardsBridge['read']>(async principal => ({ ok: true, card: card(principal) })),
    save: vi.fn<MatrixAssistantCardsBridge['save']>(async change => ({
      ok: true,
      card: card(change.principal, {
        displayName: change.displayName ?? 'Lan',
        soul: change.soul ?? SOUL,
        definitionRevision: 3,
        identityRevision: 2
      })
    })),
    avatar: vi.fn<MatrixAssistantCardsBridge['avatar']>(async change => ({
      ok: true,
      avatarUrl: change.avatar ? 'https://cdn.atum.test/avatar.webp' : null
    }))
  }
  window.atumMatrix = { assistants, command: vi.fn().mockResolvedValue(null) } as unknown as MatrixUiBridge
})

afterEach(() => {
  cleanup()
  $assistantCard.set(null)
  $assistantNameOverrides.set({})
  $backgroundSweepSettings.set({})
  vi.unstubAllGlobals()
  Reflect.deleteProperty(window, 'atumMatrix')
})

const rosterNames = () => screen.getAllByText((_, element) => element?.hasAttribute('data-roster-name') ?? false).map(each => each.textContent)

async function openLan(focus?: 'name', base: MatrixSnapshot = snapshot()) {
  render(<Window base={base} />)
  act(() => openAssistantCard({ kind: 'agent', principal: LAN, ...(focus ? { focus } : {}) }))
  await waitFor(() => expect(assistants.read).toHaveBeenCalledWith(LAN))
}

describe('background follow-ups on the card', () => {
  const backgroundSweep = (): MatrixBackgroundSweepBridge => ({
    read: vi.fn(async () => ({
      profile: MATRIX_BACKGROUND_SWEEP_SETTING_PROFILE,
      assistantId: '00000000-0000-4000-8000-288c0dd127cf',
      enabled: true,
      revision: 1,
      activeForOwner: true
    })),
    save: vi.fn()
  })

  it('shows exactly one short Vietnamese switch for a personal agent beside, not inside, routines', async () => {
    const bridge = backgroundSweep()
    const routines = {
      read: vi.fn(async (principal: string) => ({
        ok: true as const,
        snapshot: {
          assistantId: '00000000-0000-4000-8000-5b3379da4cd1',
          assistantPrincipal: principal,
          serverTime: 1,
          legacyState: 'clear' as const,
          routines: []
        }
      }))
    } as unknown as MatrixRoutinesBridge
    window.atumMatrix = { ...window.atumMatrix, backgroundSweep: bridge, routines } as MatrixUiBridge

    await openLan()
    const row = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[data-assistant-card-background-sweep]')
      expect(found).toBeTruthy()
      return found!
    })

    expect(document.querySelectorAll('[data-assistant-card-background-sweep]')).toHaveLength(1)
    expect(row.textContent).toBe('Theo dõi nền')
    expect(within(row).getAllByRole('switch', { name: 'Theo dõi nền' })).toHaveLength(1)
    expect(row.closest('[data-routines-panel]')).toBeNull()
  })

  it('uses the same server setting for the Main assistant even when it answers from cloud', async () => {
    const bridge = backgroundSweep()
    window.atumMatrix = { ...window.atumMatrix, backgroundSweep: bridge } as MatrixUiBridge
    const base = snapshot()
    base.agents = base.agents?.map(each => each.principal === ATUM ? { ...each, answering: 'cloud' } : each)

    render(<Window base={base} />)
    act(() => openAssistantCard({ kind: 'agent', principal: ATUM }))
    await waitFor(() => expect(bridge.read).toHaveBeenCalledWith(ATUM))

    const toggle = screen.getByRole('switch', { name: 'Theo dõi nền' })
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'))
  })
})

it('shows the routines row on a card that is not the primary’s', async () => {
  const read = vi.fn(
    async (principal: string): Promise<{ ok: true; snapshot: MatrixAgentRoutinesSnapshot }> => ({
      ok: true,
      snapshot: {
        assistantId: '00000000-0000-4000-8000-5b3379da4cd1',
        assistantPrincipal: principal,
        serverTime: 1,
        legacyState: 'clear',
        routines: []
      }
    })
  )
  window.atumMatrix = {
    ...window.atumMatrix,
    routines: { read } as unknown as MatrixRoutinesBridge
  } as unknown as MatrixUiBridge

  await openLan()

  await waitFor(() => expect(read).toHaveBeenCalledWith(LAN))
  expect(screen.getByText('Lịch tự động')).toBeTruthy()
  expect(screen.getByText('Chưa có')).toBeTruthy()
})

it('opens the routines list on arrival when the composer asks for routines', async () => {
  const read = vi.fn(
    async (principal: string): Promise<{ ok: true; snapshot: MatrixAgentRoutinesSnapshot }> => ({
      ok: true,
      snapshot: {
        assistantId: '00000000-0000-4000-8000-5b3379da4cd1',
        assistantPrincipal: principal,
        serverTime: 1,
        legacyState: 'clear',
        routines: []
      }
    })
  )
  window.atumMatrix = {
    ...window.atumMatrix,
    routines: { read } as unknown as MatrixRoutinesBridge
  } as unknown as MatrixUiBridge

  render(<Window base={snapshot()} />)
  act(() => openAssistantCard({ kind: 'agent', principal: LAN, focus: 'routines' }))

  const panel = await waitFor(() => {
    const found = document.querySelector<HTMLElement>('[data-routines-panel]')
    expect(found).toBeTruthy()

    return found!
  })

  expect(document.querySelector('[data-assistant-card-routines]')?.getAttribute('aria-expanded')).toBe('true')
  expect(within(panel).getByText('Chưa có lịch tự động.')).toBeTruthy()
})

it('uses the routine snapshot as the sole authority even when legacy check-in settings remain', async () => {
  const checkInRoutine: MatrixAgentRoutine = {
    id: '00000000-0000-4000-8000-c9f98e2c65c7',
    title: 'Hỏi thăm',
    instruction: 'Tóm tắt những việc quan trọng hôm nay và gửi cho tôi.',
    schedule: { kind: 'daily', hour: 8, minute: 0 },
    timezone: 'Asia/Ho_Chi_Minh',
    enabled: true,
    notifications: true,
    revision: 2,
    nextRunAt: Date.now() + 86_400_000,
    lastRun: null
  }

  const read = vi.fn(
    async (principal: string): Promise<{ ok: true; snapshot: MatrixAgentRoutinesSnapshot }> => ({
      ok: true,
      snapshot: {
        assistantId: '00000000-0000-4000-8000-5b3379da4cd1',
        assistantPrincipal: principal,
        serverTime: 1,
        legacyState: 'clear',
        routines: [checkInRoutine]
      }
    })
  )

  const update = vi.fn<MatrixRoutinesBridge['update']>(async input => ({
    ok: true,
    routine: {
      ...checkInRoutine,
      title: input.title,
      instruction: input.instruction,
      schedule: input.schedule,
      timezone: input.timezone,
      enabled: input.enabled,
      notifications: input.notifications,
      revision: 3
    }
  }))

  const runs = vi.fn<MatrixRoutinesBridge['runs']>(async () => ({
    ok: true,
    snapshot: { routineId: checkInRoutine.id, runs: [] }
  }))

  window.atumMatrix = {
    ...window.atumMatrix,
    routines: { read, runs, update } as unknown as MatrixRoutinesBridge
  } as unknown as MatrixUiBridge

  const base = snapshot()
  base.checkIns = {
    settings: defaultMatrixCheckInSettings(),
    feedback: { muted: [], snoozed: [], ackAt: 0 },
    ledger: emptyMatrixCheckInLedger(),
    writable: true
  }

  render(<Window base={base} />)
  act(() => openAssistantCard({ kind: 'agent', principal: ATUM }))
  await waitFor(() => expect(read).toHaveBeenCalledWith(ATUM))

  expect(window.document.querySelector('[data-assistant-card-check-ins]')).toBeNull()
  expect(screen.getByText('1 việc')).toBeTruthy()
  fireEvent.click(screen.getByText('Lịch tự động'))

  const row = await waitFor(() => {
    const found = window.document.querySelector<HTMLElement>('[data-routine-row]')
    expect(found).toBeTruthy()

    return found!
  })

  expect(row.textContent).toContain('Hỏi thăm')
  expect(window.document.querySelectorAll('[data-routine-row]')).toHaveLength(1)
  expect(window.document.querySelector('[data-routine-check-ins]')).toBeNull()

  fireEvent.click(within(row).getByText('Hỏi thăm'))
  await waitFor(() => expect(window.document.querySelector('[data-routine-dialog]')).toBeTruthy())
  fireEvent.change(window.document.querySelector('[data-routine-instruction]') as HTMLTextAreaElement, {
    target: { value: 'Tóm tắt việc quan trọng hôm nay cho tôi.' }
  })
  fireEvent.click(window.document.querySelector('[data-routine-save]') as HTMLButtonElement)

  await waitFor(() =>
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        routineId: checkInRoutine.id,
        title: 'Hỏi thăm',
        instruction: 'Tóm tắt việc quan trọng hôm nay cho tôi.'
      })
    )
  )
  expect(window.atumMatrix.command).not.toHaveBeenCalled()

  update.mockClear()
  await waitFor(() => expect(window.document.querySelector('[data-routine-dialog]')).toBeNull())
  fireEvent.click(within(window.document.querySelector('[data-routine-row]') as HTMLElement).getByRole('switch'))

  await waitFor(() =>
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ routineId: checkInRoutine.id, title: 'Hỏi thăm', enabled: false })
    )
  )
  expect(window.atumMatrix.command).not.toHaveBeenCalled()
})

it('does not fabricate a routine from legacy settings when the routines platform has none', async () => {
  const read = vi.fn(
    async (principal: string): Promise<{ ok: true; snapshot: MatrixAgentRoutinesSnapshot }> => ({
      ok: true,
      snapshot: {
        assistantId: '00000000-0000-4000-8000-5b3379da4cd1',
        assistantPrincipal: principal,
        serverTime: 1,
        legacyState: 'clear',
        routines: []
      }
    })
  )

  window.atumMatrix = {
    ...window.atumMatrix,
    routines: { read } as unknown as MatrixRoutinesBridge
  } as unknown as MatrixUiBridge

  const base = snapshot()
  base.checkIns = {
    settings: defaultMatrixCheckInSettings(),
    feedback: { muted: [], snoozed: [], ackAt: 0 },
    ledger: emptyMatrixCheckInLedger(),
    writable: true
  }

  render(<Window base={base} />)
  act(() => openAssistantCard({ kind: 'agent', principal: ATUM }))
  await waitFor(() => expect(screen.getByText('Chưa có')).toBeTruthy())
  fireEvent.click(screen.getByText('Lịch tự động'))

  await waitFor(() => expect(window.document.querySelector('[data-routines-empty]')).toBeTruthy())
  expect(window.document.querySelector('[data-routines-list]')).toBeNull()
  expect(window.document.querySelector('[data-routine-check-ins]')).toBeNull()
  expect(window.document.querySelector('[data-assistant-card-check-ins]')).toBeNull()
})

it('keeps the legacy check-in row when the runtime has no routines bridge', async () => {
  const base = snapshot()
  base.checkIns = {
    settings: defaultMatrixCheckInSettings(),
    feedback: { muted: [], snoozed: [], ackAt: 0 },
    ledger: emptyMatrixCheckInLedger(),
    writable: true
  }

  render(<Window base={base} />)
  act(() => openAssistantCard({ kind: 'agent', principal: ATUM }))

  const row = await waitFor(() => {
    const found = window.document.querySelector<HTMLElement>('[data-assistant-card-check-ins]')
    expect(found).toBeTruthy()

    return found!
  })

  expect(screen.queryByText('Lịch tự động')).toBeNull()
  fireEvent.click(within(row).getByRole('switch'))

  await waitFor(() =>
    expect(window.atumMatrix.command).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'checkInsChange', change: expect.objectContaining({ field: 'enabled' }) })
    )
  )
})

it('renames in place: everywhere at once, one write, then Undo puts the old name back', async () => {
  await openLan()
  fireEvent.click(await screen.findByRole('button', { name: 'Tên hiển thị, Lan. Nhấn để đổi' }))
  const field = screen.getByRole('textbox', { name: 'Tên hiển thị' })
  fireEvent.change(field, { target: { value: '  Lan   Anh ' } })
  fireEvent.keyDown(field, { key: 'Enter' })

  // Painted before the write answers.
  expect(rosterNames()).toContain('Lan Anh')
  await screen.findByText('Đã đổi tên')
  expect(assistants.save).toHaveBeenCalledExactlyOnceWith({
    principal: LAN,
    expectedDefinitionRevision: 2,
    expectedIdentityRevision: 1,
    displayName: 'Lan Anh'
  })

  fireEvent.click(screen.getByRole('button', { name: 'Hoàn tác' }))
  await screen.findByText('Đã hoàn tác')
  expect(assistants.save).toHaveBeenLastCalledWith(
    expect.objectContaining({ displayName: 'Lan', expectedDefinitionRevision: 3, expectedIdentityRevision: 2 })
  )
})

it('refuses Atum’s names and duplicates without writing, and keeps the field open', async () => {
  await openLan()
  fireEvent.click(await screen.findByRole('button', { name: 'Tên hiển thị, Lan. Nhấn để đổi' }))
  const field = screen.getByRole('textbox', { name: 'Tên hiển thị' })

  fireEvent.change(field, { target: { value: 'Mòon' } })
  fireEvent.keyDown(field, { key: 'Enter' })
  expect(await screen.findByText('Tên này dành cho trợ lý của Atum.')).toBeTruthy()

  fireEvent.change(field, { target: { value: 'mai' } })
  fireEvent.keyDown(field, { key: 'Enter' })
  expect(await screen.findByText('Bạn đã có trợ lý tên mai.')).toBeTruthy()

  // Only the primary may be called Atum.
  fireEvent.change(field, { target: { value: 'Atum' } })
  fireEvent.keyDown(field, { key: 'Enter' })
  expect(await screen.findByText('Tên này dành cho trợ lý của Atum.')).toBeTruthy()
  expect(assistants.save).not.toHaveBeenCalled()
  expect(screen.getByRole('textbox', { name: 'Tên hiển thị' })).toBeTruthy()
})

it('keeps the name of an app in the catalog for the app, and lets it be one word of a person’s name', async () => {
  // An app published after this client shipped: the card knows it by the catalog alone.
  const base = snapshot()
  base.apps = { state: 'ready', apps: [botApp({ ...ACME, name: 'Demoza', slug: 'demoza' })], connections: {} }
  await openLan(undefined, base)
  fireEvent.click(await screen.findByRole('button', { name: 'Tên hiển thị, Lan. Nhấn để đổi' }))
  const field = screen.getByRole('textbox', { name: 'Tên hiển thị' })

  for (const name of ['Demoza', 'Demoza Official']) {
    fireEvent.change(field, { target: { value: name } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(await screen.findByText('Tên này dành cho trợ lý của Atum.')).toBeTruthy()
  }

  expect(assistants.save).not.toHaveBeenCalled()

  fireEvent.change(field, { target: { value: 'Demoza Nguyễn' } })
  fireEvent.keyDown(field, { key: 'Enter' })
  await screen.findByText('Đã đổi tên')
  expect(assistants.save).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ displayName: 'Demoza Nguyễn' }))
})

it('rolls a refused rename back visibly and reopens the field with the reason', async () => {
  assistants.save.mockResolvedValueOnce({ ok: false, error: 'reserved' })
  await openLan()
  fireEvent.click(await screen.findByRole('button', { name: 'Tên hiển thị, Lan. Nhấn để đổi' }))
  const field = screen.getByRole('textbox', { name: 'Tên hiển thị' })
  fireEvent.change(field, { target: { value: 'Taylor Swift' } })
  fireEvent.keyDown(field, { key: 'Enter' })

  expect(await screen.findByText('Tên này dành cho trợ lý của Atum.')).toBeTruthy()
  expect(rosterNames()).toContain('Lan')
  expect((screen.getByRole('textbox', { name: 'Tên hiển thị' }) as HTMLInputElement).value).toBe('Taylor Swift')
})

it('keeps the change and offers Try again when the write fails', async () => {
  assistants.save.mockResolvedValueOnce({ ok: false, error: 'offline' })
  await openLan()
  fireEvent.click(await screen.findByRole('button', { name: 'Tên hiển thị, Lan. Nhấn để đổi' }))
  const field = screen.getByRole('textbox', { name: 'Tên hiển thị' })
  fireEvent.change(field, { target: { value: 'Lan Anh' } })
  fireEvent.keyDown(field, { key: 'Enter' })

  fireEvent.click(await screen.findByRole('button', { name: 'Thử lại' }))
  await screen.findByText('Đã đổi tên')
  expect(assistants.save).toHaveBeenCalledTimes(2)
  expect(rosterNames()).toContain('Lan Anh')
})

it('re-applies a rename once when another device wrote something else first', async () => {
  assistants.save.mockResolvedValueOnce({
    ok: false,
    error: 'conflict',
    card: card(LAN, { definitionRevision: 7, identityRevision: 4, soul: `${SOUL}\n\n## Notes\n\nNew.` })
  })
  await openLan()
  fireEvent.click(await screen.findByRole('button', { name: 'Tên hiển thị, Lan. Nhấn để đổi' }))
  const field = screen.getByRole('textbox', { name: 'Tên hiển thị' })
  fireEvent.change(field, { target: { value: 'Lan Anh' } })
  fireEvent.keyDown(field, { key: 'Enter' })

  await screen.findByText('Đã đổi tên')
  expect(assistants.save).toHaveBeenLastCalledWith(
    expect.objectContaining({ displayName: 'Lan Anh', expectedDefinitionRevision: 7, expectedIdentityRevision: 4 })
  )
})

it('steps back one level per Esc: the field first, then the sheet', async () => {
  await openLan('name')
  const field = await screen.findByRole('textbox', { name: 'Tên hiển thị' })
  fireEvent.change(field, { target: { value: 'Lan Anh' } })
  fireEvent.keyDown(field, { key: 'Escape' })

  expect(screen.queryByRole('textbox', { name: 'Tên hiển thị' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Tên hiển thị, Lan. Nhấn để đổi' })).toBeTruthy()
  expect($assistantCard.get()).not.toBeNull()
  expect(assistants.save).not.toHaveBeenCalled()

  fireEvent.keyDown(window.document.activeElement ?? window.document.body, { key: 'Escape' })
  await waitFor(() => expect($assistantCard.get()).toBeNull())
})

it('saves "what it does" as part of the persona, keeping the sections the card does not show', async () => {
  await openLan()
  const field = await screen.findByRole('textbox', { name: 'Lan giúp bạn việc gì?' })
  await waitFor(() => expect((field as HTMLTextAreaElement).value).toBe('Lo lịch họp.'))
  fireEvent.focus(field)
  fireEvent.change(field, { target: { value: 'Lo lịch họp và email.' } })
  fireEvent.blur(field)

  await screen.findByText('Đã lưu')
  const soul = assistants.save.mock.calls[0]![0].soul as string
  expect(soul).toContain('## What you do\n\nLo lịch họp và email.')
  expect(soul).toContain('## Who you are\n\nĐiềm tĩnh.')
  expect(soul).toContain('## Rules\n\nNo Fridays.')
})

it('shows the standard fields for custom text and changes only its personality section', async () => {
  assistants.read.mockResolvedValueOnce({ ok: true, card: card(LAN, { inherited: false, soul: CUSTOM_SOUL }) })
  await openLan()

  const main = (await screen.findByRole('textbox', { name: 'Lan giúp bạn việc gì?' })) as HTMLTextAreaElement
  expect(main.value).toBe(
    "You are Lan, Minh's research partner.\n\n## Rules\n\nKeep citations exact.\n\n## Memory\n\nRemember durable decisions."
  )
  expect(screen.queryByRole('textbox', { name: 'Hướng dẫn' })).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: 'Tính cách, Warm and candid.' }))
  const personality = await screen.findByRole('textbox', { name: 'Tính cách' })
  fireEvent.change(personality, { target: { value: 'Calm under pressure.' } })
  fireEvent.blur(personality)

  await screen.findByText('Đã lưu')
  expect(assistants.save.mock.calls[0]![0].soul).toBe(CUSTOM_SOUL.replace('Warm and candid.', 'Calm under pressure.'))
})

it('replaces custom main text while preserving its personality section', async () => {
  assistants.read.mockResolvedValueOnce({ ok: true, card: card(LAN, { inherited: false, soul: CUSTOM_SOUL }) })
  await openLan()

  const main = (await screen.findByRole('textbox', { name: 'Lan giúp bạn việc gì?' })) as HTMLTextAreaElement
  fireEvent.focus(main)
  fireEvent.change(main, { target: { value: 'A new brief.\n\n## Boundaries\n\nAsk before sending.' } })
  fireEvent.blur(main)

  await screen.findByText('Đã lưu')
  expect(assistants.save.mock.calls[0]![0].soul).toBe(
    '# Lan\n\nA new brief.\n\n## Boundaries\n\nAsk before sending.\n\n## Who you are\n\nWarm and candid.\n\n'
  )
})

it('renames the primary as owner decision D1 says, keeping the Atum mark and no Delete', async () => {
  render(<Window base={snapshot()} />)
  act(() => openAssistantCard({ kind: 'agent', principal: ATUM }))
  await waitFor(() => expect(assistants.read).toHaveBeenCalledWith(ATUM))

  // The face is the Atum mark until a photo is chosen, whatever the name.
  const face = () => window.document.querySelector('.atum-card-avatar[data-atum-eclipse-face]')
  expect(face()).toBeTruthy()
  expect(screen.queryByRole('button', { name: /^Xóa/ })).toBeNull()
  expect(screen.getByRole('img', { name: 'Trợ lý chính' })).toBeTruthy()

  if (PRIMARY_ASSISTANT_KEEPS_NAME) {
    expect(await screen.findByRole('heading', { name: 'Atum' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Nhấn để đổi/ })).toBeNull()

    return
  }

  fireEvent.click(await screen.findByRole('button', { name: 'Tên hiển thị, Atum. Nhấn để đổi' }))
  const field = screen.getByRole('textbox', { name: 'Tên hiển thị' })
  fireEvent.change(field, { target: { value: 'Moon' } })
  fireEvent.keyDown(field, { key: 'Enter' })
  expect(await screen.findByText('Tên này dành cho trợ lý của Atum.')).toBeTruthy()

  fireEvent.change(field, { target: { value: 'Linh' } })
  fireEvent.keyDown(field, { key: 'Enter' })

  // The roster, the header and the palette read the same name: painted before the write answers.
  expect(rosterNames()).toContain('Linh')
  await screen.findByText('Đã đổi tên')
  expect(screen.getByRole('button', { name: 'Tên hiển thị, Linh. Nhấn để đổi' })).toBeTruthy()
  expect(screen.getByRole('img', { name: 'Trợ lý chính' })).toBeTruthy()
  expect(face()).toBeTruthy()
  expect(assistants.save).toHaveBeenCalledExactlyOnceWith({
    principal: ATUM,
    expectedDefinitionRevision: 2,
    expectedIdentityRevision: 1,
    displayName: 'Linh'
  })

  // And back to Atum, which only the primary may be called.
  fireEvent.click(screen.getByRole('button', { name: 'Hoàn tác' }))
  await screen.findByText('Đã hoàn tác')
  expect(assistants.save).toHaveBeenLastCalledWith(expect.objectContaining({ principal: ATUM, displayName: 'Atum' }))
})

it('removes an agent photo through the canonical assistant bridge', async () => {
  const base = snapshot()
  base.agents = base.agents?.map(each => each.principal === LAN
    ? { ...each, avatarUrl: 'https://cdn.atum.test/avatar.webp' }
    : each)
  render(<Window base={base} />)
  act(() => openAssistantCard({ kind: 'agent', principal: LAN }))
  await waitFor(() => expect(assistants.read).toHaveBeenCalledWith(LAN))

  fireEvent.click(await screen.findByRole('button', { name: 'Gỡ ảnh' }))
  await waitFor(() => expect(assistants.avatar).toHaveBeenCalledExactlyOnceWith({ principal: LAN, avatar: null }))
})

it('closes the name field on an unchanged name the rules now refuse, writing nothing', async () => {
  if (PRIMARY_ASSISTANT_KEEPS_NAME) {
    return
  }

  // A primary stored as "Atum Main" before the primary could only be called Atum as a whole.
  assistants.read.mockImplementation(async principal => ({
    ok: true,
    card: card(principal, { displayName: 'Atum Main' })
  }))
  const base = snapshot()
  base.agents = [agent(ATUM, 'Atum Main'), agent(LAN, 'Lan')]
  render(<Window base={base} />)
  act(() => openAssistantCard({ kind: 'agent', principal: ATUM }))
  await waitFor(() => expect(assistants.read).toHaveBeenCalledWith(ATUM))

  fireEvent.click(await screen.findByRole('button', { name: 'Tên hiển thị, Atum Main. Nhấn để đổi' }))
  const field = screen.getByRole('textbox', { name: 'Tên hiển thị' })
  fireEvent.keyDown(field, { key: 'Enter' })

  expect(screen.queryByRole('textbox', { name: 'Tên hiển thị' })).toBeNull()
  expect(screen.queryByText('Tên này dành cho trợ lý của Atum.')).toBeNull()
  expect(assistants.save).not.toHaveBeenCalled()

  // Typing it again is a new name, and is refused.
  fireEvent.click(screen.getByRole('button', { name: 'Tên hiển thị, Atum Main. Nhấn để đổi' }))
  const again = screen.getByRole('textbox', { name: 'Tên hiển thị' })
  fireEvent.change(again, { target: { value: 'Atum  Main' } })
  fireEvent.keyDown(again, { key: 'Enter' })
  expect(await screen.findByText('Tên này dành cho trợ lý của Atum.')).toBeTruthy()
  expect(assistants.save).not.toHaveBeenCalled()
})

it('never says Matrix, Hermes or bot', async () => {
  await openLan()
  await screen.findByText('Lo lịch họp.', { selector: 'textarea' }).catch(() => undefined)
  const text = window.document.body.textContent ?? ''

  expect(text).not.toMatch(/Matrix|Hermes|\bbot\b|MB/i)
})

describe('where an assistant answers is never said (0.19.4 Q4)', () => {
  const LOCATION = /đám mây|Mac này|Trả lời trên/i

  function openWith(agents: MatrixAgentView[], principal: string) {
    const base = { ...snapshot(), agents }
    render(<Window base={base} />)
    act(() => openAssistantCard({ kind: 'agent', principal }))
  }

  it('a cloud assistant’s card says nothing of where it answers and offers nothing it cannot do', async () => {
    const cloudAgent = vi.fn()
    Object.assign(window.atumMatrix, { cloudAgent })
    openWith([agent(ATUM, 'Atum'), agent(LAN, 'Lan', { ready: false, answering: 'cloud', readiness: undefined })], LAN)
    await waitFor(() => expect(assistants.read).toHaveBeenCalledWith(LAN))
    await screen.findByRole('textbox', { name: 'Lan giúp bạn việc gì?' })
    const card = window.document.querySelector<HTMLElement>('[data-assistant-card]')!

    expect(card.textContent).not.toMatch(LOCATION)
    // Canonical photos do not need the cloud agent's host; setup, move and Advanced stay absent.
    expect(card.querySelector('[data-assistant-card-avatar]')).toBeTruthy()
    expect(card.querySelector('[data-assistant-card-setup]')).toBeNull()
    expect(card.querySelector('[data-agent-advanced]')).toBeNull()
    // Hovering or focusing the face says nothing either.
    expect(card.querySelector('[data-matrix-tip], [role="tooltip"]')).toBeNull()
    expect(cloudAgent).not.toHaveBeenCalled()
  })

  it('renaming a cloud assistant leaves no note about when others see it', async () => {
    openWith([agent(ATUM, 'Atum'), agent(LAN, 'Lan', { ready: false, answering: 'cloud', readiness: undefined })], LAN)
    fireEvent.click(await screen.findByRole('button', { name: 'Tên hiển thị, Lan. Nhấn để đổi' }))
    const field = screen.getByRole('textbox', { name: 'Tên hiển thị' })
    fireEvent.change(field, { target: { value: 'Lan Anh' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    await waitFor(() => expect(assistants.save).toHaveBeenCalledOnce())
    expect(await screen.findByText('Đã đổi tên')).toBeTruthy()
    const text = window.document.querySelector('[data-assistant-card]')!.textContent

    expect(text).not.toMatch(/trực tuyến/)
    expect(text).not.toMatch(LOCATION)
  })

  it('an assistant that runs here keeps its photo and offers no move and no Advanced section', async () => {
    const cloudAgent = vi.fn(async () => ({ state: 'cancelled' as const }))
    Object.assign(window.atumMatrix, { cloudAgent })
    // Main would still allow the move here; every assistant is cloud-first now, so nothing offers it.
    openWith([agent(ATUM, 'Atum'), agent(LAN, 'Lan')], LAN)
    await waitFor(() => expect(assistants.read).toHaveBeenCalledWith(LAN))
    await screen.findByRole('textbox', { name: 'Lan giúp bạn việc gì?' })
    const card = window.document.querySelector<HTMLElement>('[data-assistant-card]')!

    expect(card.querySelector('[data-assistant-card-avatar]')).toBeTruthy()
    expect(card.querySelector('[data-agent-advanced], [data-agent-move]')).toBeNull()
    expect(screen.queryByText('Nâng cao')).toBeNull()
    expect(card.textContent).not.toMatch(LOCATION)
    expect(cloudAgent).not.toHaveBeenCalled()
  })

  it('an assistant that runs here but is not ready says so plainly, with its action', async () => {
    openWith(
      [agent(ATUM, 'Atum'), agent(LAN, 'Lan', { ready: false, readiness: { phase: 'blocked', code: 'x', since: 1 } })],
      LAN
    )

    const row = await waitFor(() => {
      const found = window.document.querySelector<HTMLElement>('[data-assistant-card-setup]')
      expect(found).toBeTruthy()

      return found!
    })

    expect(row.textContent).not.toMatch(LOCATION)
    expect(within(row).getByRole('button', { name: 'Thiết lập' })).toBeTruthy()
  })
})

describe('a cloud-route assistant this Mac runs', () => {
  const LOCATION = /đám mây|Mac này|Trả lời trên/i
  const blocked = { phase: 'blocked' as const, code: 'x', since: 1 }

  function openWith(agents: MatrixAgentView[], principal: string) {
    render(<Window base={{ ...snapshot(), agents }} />)
    act(() => openAssistantCard({ kind: 'agent', principal }))
  }

  it.each(['answering', 'standby'] as const)(
    'offers its setup when it is not ready, whether this Mac answers or stands by (%s), without saying where it answers',
    async macRole => {
      openWith(
        [agent(ATUM, 'Atum'), agent(LAN, 'Lan', { ready: false, answering: 'cloud', macRole, readiness: blocked })],
        LAN
      )

      const row = await waitFor(() => {
        const found = window.document.querySelector<HTMLElement>('[data-assistant-card-setup]')
        expect(found).toBeTruthy()

        return found!
      })

      expect(row.textContent).not.toMatch(LOCATION)
      expect(within(row).getByRole('button', { name: 'Thiết lập' })).toBeTruthy()
    }
  )

  it('offers no setup for one that is ready, or that no Mac runs', async () => {
    openWith([agent(ATUM, 'Atum'), agent(LAN, 'Lan', { ready: true, answering: 'cloud', macRole: 'answering' })], LAN)
    await waitFor(() => expect(assistants.read).toHaveBeenCalledWith(LAN))
    await screen.findByRole('textbox', { name: 'Lan giúp bạn việc gì?' })
    expect(window.document.querySelector('[data-assistant-card-setup]')).toBeNull()
    cleanup()
    $assistantCard.set(null)

    openWith([agent(ATUM, 'Atum'), agent(LAN, 'Lan', { ready: false, answering: 'cloud', readiness: undefined })], LAN)
    await screen.findByRole('textbox', { name: 'Lan giúp bạn việc gì?' })
    expect(window.document.querySelector('[data-assistant-card-setup]')).toBeNull()
  })
})

async function openWhatItDoes() {
  await openLan()
  const field = (await screen.findByRole('textbox', { name: 'Lan giúp bạn việc gì?' })) as HTMLTextAreaElement
  await waitFor(() => expect(field.value).toBe('Lo lịch họp.'))
  act(() => field.focus())

  return field
}

function expandedEditor() {
  const editor = window.document.querySelector<HTMLElement>('[data-assistant-card-field-dialog]')

  return editor
    ? {
        editor,
        large: within(editor).getByRole('textbox', { name: 'Lan giúp bạn việc gì?' }) as HTMLTextAreaElement
      }
    : undefined
}

async function openExpanded() {
  fireEvent.click(window.document.querySelector('[data-assistant-card-field-expand]')!)
  await waitFor(() => expect(expandedEditor()).toBeTruthy())

  return expandedEditor()!
}

it('gives the instructions field eight lines and a window-sized editor that saves on ⌘Return', async () => {
  const field = await openWhatItDoes()
  expect(field.rows).toBe(8)

  const { large } = await openExpanded()
  expect(large.value).toBe('Lo lịch họp.')

  fireEvent.change(large, { target: { value: 'Lo lịch họp và email.' } })
  fireEvent.keyDown(large, { key: 'Enter', metaKey: true })

  await waitFor(() => expect(expandedEditor()).toBeUndefined())
  await screen.findByText('Đã lưu')
  expect(assistants.save.mock.calls[0]![0].soul).toContain('## What you do\n\nLo lịch họp và email.')
  expect(field.value).toBe('Lo lịch họp và email.')
})

it('saves the large editor on close, and Esc there puts it back without saving', async () => {
  const field = await openWhatItDoes()

  let editor = await openExpanded()
  fireEvent.change(editor.large, { target: { value: 'Lo lịch họp và email.' } })
  fireEvent.keyDown(editor.large, { key: 'Escape' })

  await waitFor(() => expect(expandedEditor()).toBeUndefined())
  expect(field.value).toBe('Lo lịch họp.')
  expect(assistants.save).not.toHaveBeenCalled()

  editor = await openExpanded()
  fireEvent.change(editor.large, { target: { value: 'Lo lịch họp và email.' } })
  fireEvent.click(within(editor.editor).getByRole('button', { name: 'Xong' }))

  await waitFor(() => expect(assistants.save).toHaveBeenCalledOnce())
  expect(assistants.save.mock.calls[0]![0].soul).toContain('## What you do\n\nLo lịch họp và email.')
})

it('Esc in "what it does" puts back what was saved and leaves the card open, writing nothing', async () => {
  const field = await openWhatItDoes()
  fireEvent.change(field, { target: { value: 'Lo lịch họp và email.' } })
  fireEvent.keyDown(field, { key: 'Escape' })

  expect(field.value).toBe('Lo lịch họp.')
  expect(window.document.activeElement).not.toBe(field)
  expect($assistantCard.get()).not.toBeNull()
  expect(assistants.save).not.toHaveBeenCalled()
})

it('saves "what it does" once when the person is done, not at every pause in typing', async () => {
  const field = await openWhatItDoes()
  fireEvent.change(field, { target: { value: 'Lo lịch họp' } })
  fireEvent.change(field, { target: { value: 'Lo lịch họp và email.' } })
  await act(() => new Promise(resolve => setTimeout(resolve, 1_000)))
  expect(assistants.save).not.toHaveBeenCalled()

  act(() => field.blur())
  await screen.findByText('Đã lưu')
  expect(assistants.save).toHaveBeenCalledOnce()
  expect(assistants.save.mock.calls[0]![0].soul).toContain('## What you do\n\nLo lịch họp và email.')
})

it('keeps what was typed when the card closes with the field still open', async () => {
  const field = await openWhatItDoes()
  fireEvent.change(field, { target: { value: 'Lo lịch họp và email.' } })
  act(() => $assistantCard.set(null))

  await waitFor(() => expect(assistants.save).toHaveBeenCalledOnce())
  expect(assistants.save.mock.calls[0]![0].soul).toContain('## What you do\n\nLo lịch họp và email.')
})

it('keeps an open personality draft when the card closes', async () => {
  await openLan()
  fireEvent.click(await screen.findByRole('button', { name: /^Tính cách/ }))
  const field = await screen.findByRole('textbox', { name: 'Tính cách' })
  fireEvent.change(field, { target: { value: 'Vui vẻ.' } })
  act(() => $assistantCard.set(null))

  await waitFor(() => expect(assistants.save).toHaveBeenCalledOnce())
  expect(assistants.save.mock.calls[0]![0].soul).toContain('## Who you are\n\nVui vẻ.')
})

it('refuses a look-alike of Atum’s names in the card, with a reason, and writes nothing', async () => {
  await openLan()
  fireEvent.click(await screen.findByRole('button', { name: 'Tên hiển thị, Lan. Nhấn để đổi' }))
  const field = screen.getByRole('textbox', { name: 'Tên hiển thị' })

  fireEvent.change(field, { target: { value: 'Mòon' } })
  fireEvent.keyDown(field, { key: 'Enter' })
  expect(await screen.findByText('Tên này dành cho trợ lý của Atum.')).toBeTruthy()

  // Another script's look-alike letter: named, with what a name may use.
  fireEvent.change(field, { target: { value: '\uA4EEtum' } })
  fireEvent.keyDown(field, { key: 'Enter' })
  expect(
    await screen.findByText(
      "“\uA4EE” thuộc bảng chữ khác. Tên dùng chữ Latinh hoặc tiếng Việt, chữ Trung, Nhật, Hàn, chữ số, emoji và ' - . & ,"
    )
  ).toBeTruthy()

  fireEvent.change(field, { target: { value: 'Lan ✅' } })
  fireEvent.keyDown(field, { key: 'Enter' })
  expect(await screen.findByText('Tên không được có dấu tích.')).toBeTruthy()

  fireEvent.change(field, { target: { value: 'Mo\u00ADon' } })
  fireEvent.keyDown(field, { key: 'Enter' })
  expect(await screen.findByText('Tên có ký tự ẩn hoặc không dùng được. Hãy gõ lại.')).toBeTruthy()

  fireEvent.change(field, { target: { value: 'Lan \u{1F170}\uFE0F' } })
  fireEvent.keyDown(field, { key: 'Enter' })
  expect(await screen.findByText('“\u{1F170}\uFE0F” là chữ hoặc số trong khung, nên không dùng được trong tên.')).toBeTruthy()

  fireEvent.change(field, { target: { value: 'Lan $' } })
  fireEvent.keyDown(field, { key: 'Enter' })
  expect(await screen.findByText("Tên không dùng được “$”. Hãy dùng chữ cái, chữ số, emoji và ' - . & ,")).toBeTruthy()

  fireEvent.change(field, { target: { value: '\u0301Lan' } })
  fireEvent.keyDown(field, { key: 'Enter' })
  expect(await screen.findByText('Dấu “\u25CC\u0301” không nằm trên chữ nào. Hãy gõ lại.')).toBeTruthy()

  fireEvent.change(field, { target: { value: 'さくら민수' } })
  fireEvent.keyDown(field, { key: 'Enter' })
  expect(await screen.findByText('Tên không thể vừa có chữ kana Nhật vừa có chữ Hàn.')).toBeTruthy()
  expect(assistants.save).not.toHaveBeenCalled()
})

describe('the assistant’s public handle', () => {
  const LAN_ASSISTANT = '00000000-0000-4000-8000-0d1d7248044a'

  function withDirectory(base: MatrixSnapshot): MatrixSnapshot {
    return {
      ...base,
      domainEnabled: true,
      agents: base.agents?.map(each => (each.principal === LAN ? { ...each, assistantId: LAN_ASSISTANT } : each))
    } as MatrixSnapshot
  }

  function directory() {
    const requests: MatrixAliasRequest[] = []
    let held: string | null = null

    const aliases: MatrixAliasBridge = {
      pending: async () => ({ ok: true, request: null }),
      request: vi.fn(async input => {
        requests.push(input)

        if (input.action === 'current') {
          return { ok: true as const, value: { kind: 'current' as const, alias: held ? { handle: held, generation: 1 } : null } }
        }

        if (input.action === 'check') {
          return { ok: true as const, value: { kind: 'check' as const, handle: input.handle, available: true, code: null } }
        }

        if (input.action === 'claim') {
          held = input.handle

          return { ok: true as const, value: { kind: 'claim' as const, handle: input.handle, generation: 1 } }
        }

        return { ok: false as const, error: 'unavailable' as const }
      })
    }

    window.atumMatrix = { ...window.atumMatrix, aliases } as unknown as MatrixUiBridge

    return requests
  }

  it('is chosen on the card itself: offered from the name, checked, confirmed, then shown', async () => {
    const requests = directory()
    render(<Window base={withDirectory(snapshot())} />)
    act(() => openAssistantCard({ kind: 'agent', principal: LAN }))

    // The same two names as the "Trợ lý mới" sheet: the display name above, the bot handle here.
    const section = await waitFor(() => {
      const found = window.document.querySelector<HTMLElement>('[data-assistant-card-handle]')
      expect(found).toBeTruthy()

      return found!
    })

    expect(within(section).getByRole('heading', { name: 'Tên bot' })).toBeTruthy()
    expect(within(section).getByText('Người khác gõ @tên này để tìm và nhắc đến trợ lý.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Tên hiển thị, Lan. Nhấn để đổi' })).toBeTruthy()
    expect(await screen.findByText('Chưa có tên bot')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Chọn tên bot' }))
    // The field holds the part before the fixed _bot, filled from the name.
    expect((screen.getByRole('textbox', { name: 'Tên bot' }) as HTMLInputElement).value).toBe('lan')
    expect(section.textContent).toContain('_bot')
    await screen.findByText('@lan_bot còn trống.', undefined, { timeout: 2500 })

    fireEvent.click(screen.getByRole('button', { name: 'Lưu' }))
    const dialog = await screen.findByRole('dialog', { name: 'Dùng tên này?' })
    expect(dialog.textContent).toContain('@lan_bot sẽ là tên bot của Lan.')
    fireEvent.click(screen.getByRole('button', { name: 'Dùng tên' }))

    expect(await screen.findByText('@lan_bot')).toBeTruthy()
    expect(requests.filter(request => request.action === 'claim')).toEqual([
      expect.objectContaining({ action: 'claim', handle: 'lan_bot', assistantId: LAN_ASSISTANT })
    ])
  })

  it('Escape leaves the handle field, not the card', async () => {
    directory()
    render(<Window base={withDirectory(snapshot())} />)
    act(() => openAssistantCard({ kind: 'agent', principal: LAN }))
    fireEvent.click(await screen.findByRole('button', { name: 'Chọn tên bot' }))
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Tên bot' }), { key: 'Escape' })

    expect(screen.queryByRole('textbox', { name: 'Tên bot' })).toBeNull()
    expect(screen.getByText('Chưa có tên bot')).toBeTruthy()
  })

  it('is not offered where the directory is not on', async () => {
    directory()
    await openLan()
    expect(screen.getByRole('button', { name: 'Tên hiển thị, Lan. Nhấn để đổi' })).toBeTruthy()
    expect(screen.queryByText('Chưa có tên bot')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Chọn tên bot' })).toBeNull()
  })
})

describe('the failover policy on the card', () => {
  it('has no “Nơi trả lời” row when the assistant has no policy', async () => {
    await openLan()
    expect(window.document.querySelector('[data-assistant-card-answer-where]')).toBeNull()
  })

  it('keeps the legacy priority control when no authoritative home exists', async () => {
    const base = snapshot()
    const policy = policyView()
    const read = vi.fn(async () => policy)
    base.agents = base.agents?.map(each => (each.principal === LAN ? { ...each, executionPolicy: policy } : each))
    window.atumMatrix = {
      assistants,
      command: vi.fn().mockResolvedValue(null),
      executionPolicy: { read, save: vi.fn() } as unknown as MatrixExecutionPolicyBridge
    } as unknown as MatrixUiBridge

    render(<Window base={base} />)
    act(() => openAssistantCard({ kind: 'agent', principal: LAN }))
    await waitFor(() => expect(assistants.read).toHaveBeenCalledWith(LAN))

    const row = window.document.querySelector<HTMLElement>('[data-assistant-card-answer-where]')
    expect(row).toBeTruthy()
    expect(screen.getByText('Nơi trả lời')).toBeTruthy()
    fireEvent.click(row!)
    expect(await screen.findByRole('heading', { name: 'Nơi trợ lý này trả lời' })).toBeTruthy()
    expect(read).toHaveBeenCalledWith(LAN)
  })

  it('shows only D1 home when an authoritative home and a legacy policy coexist', async () => {
    const base = snapshot()
    const policy = policyView()
    const home: NonNullable<MatrixAgentView['home']> = {
      lives: { kind: 'cloud' },
      move: null,
      targets: [{ id: '00000000-0000-4000-8000-b454f82c5857', name: 'Mac mini' }],
      issue: null,
      placement: {
        profile: 'atum.agent-home/2.5',
        moveAvailable: true,
        current: 'cloud',
        reachability: 'reachable',
        modelStatus: 'applied',
        destinations: [
          { id: 'cloud', kind: 'cloud', name: '', thisMac: false, eligibility: 'ready', catalogRevision: 0, models: [] },
          {
            id: '00000000-0000-4000-8000-b454f82c5857',
            kind: 'mac',
            name: 'Mac mini',
            thisMac: false,
            eligibility: 'ready',
            catalogRevision: 1,
            models: []
          }
        ]
      }
    }
    base.agents = base.agents?.map(each =>
      each.principal === LAN ? { ...each, executionPolicy: policy, home } : each
    )
    window.atumMatrix = {
      assistants,
      command: vi.fn().mockResolvedValue(null),
      executionPolicy: { read: vi.fn(), save: vi.fn() } as unknown as MatrixExecutionPolicyBridge,
      agentHome: {
        read: vi.fn(async () => home),
        preflight: vi.fn(),
        move: vi.fn(),
        cancel: vi.fn(),
        model: vi.fn(),
        prepare: vi.fn()
      }
    } as unknown as MatrixUiBridge

    render(<Window base={base} />)
    act(() => openAssistantCard({ kind: 'agent', principal: LAN }))
    await waitFor(() => expect(assistants.read).toHaveBeenCalledWith(LAN))

    expect(window.document.querySelector('[data-assistant-card-home]')).toBeTruthy()
    expect(window.document.querySelector('[data-assistant-card-answer-where]')).toBeNull()
  })
})

describe('where the assistant lives on the card', () => {
  const home: MatrixAgentView['home'] = {
    lives: { kind: 'mac', name: 'MacBook', thisMac: true },
    move: null,
    targets: [{ id: '00000000-0000-4000-8000-b454f82c5857', name: 'Mac mini' }],
    issue: null
  }

  const bridge = {
    read: vi.fn(),
    preflight: vi.fn(),
    move: vi.fn(),
    cancel: vi.fn(),
    model: vi.fn(),
    prepare: vi.fn()
  }

  async function open(agentHome: MatrixAgentView['home'], withBridge: boolean) {
    const base = snapshot()
    base.agents = base.agents?.map(each => (each.principal === LAN && agentHome ? { ...each, home: agentHome } : each))
    window.atumMatrix = {
      assistants,
      command: vi.fn().mockResolvedValue(null),
      ...(withBridge ? { agentHome: bridge } : {})
    } as unknown as MatrixUiBridge

    render(<Window base={base} />)
    act(() => openAssistantCard({ kind: 'agent', principal: LAN }))
    await waitFor(() => expect(assistants.read).toHaveBeenCalledWith(LAN))
  }

  it('shows the Mac it lives on, in the owner’s name for it', async () => {
    await open(home, true)

    const row = window.document.querySelector<HTMLElement>('[data-assistant-card-home]')!
    expect(row.textContent).toContain('Đang ở trên')
    expect(row.textContent).toContain('MacBook · máy này')
  })

  it('does not claim a D1 home before authoritative home data exists', async () => {
    await open(undefined, true)

    expect(window.document.querySelector('[data-assistant-card-home]')).toBeNull()
    cleanup()

    // A window without the bridge has nothing to read or move with, so it draws no row at all.
    await open(home, false)
    expect(window.document.querySelector('[data-assistant-card-home]')).toBeNull()
  })

  it('keeps the known cloud place on a stale snapshot and Retry performs another read', async () => {
    const stale: MatrixAgentView['home'] = {
      lives: { kind: 'cloud' },
      move: null,
      targets: [],
      issue: 'placement_stale'
    }
    bridge.read.mockResolvedValue(stale)
    await open(stale, true)

    fireEvent.click(window.document.querySelector<HTMLElement>('[data-assistant-card-home]')!)
    await waitFor(() => expect(bridge.read).toHaveBeenCalledTimes(1))
    expect(window.document.querySelector('[data-agent-home-current]')?.textContent).toContain('Đám mây')
    expect(window.document.querySelector('[data-agent-home-popover]')?.textContent).toContain('cần sửa vị trí đã lưu')

    fireEvent.click(screen.getByRole('button', { name: 'Thử lại' }))
    await waitFor(() => expect(bridge.read).toHaveBeenCalledTimes(2))
  })
})

describe('one assistant card, the primary included', () => {
  const home: MatrixAgentView['home'] = {
    lives: { kind: 'mac', name: 'MacBook', thisMac: true },
    move: null,
    targets: [],
    issue: null
  }

  const rowsOf = () =>
    [...window.document.querySelectorAll<HTMLElement>('[data-assistant-card-rows] > *')].map(row => {
      const tag = row.tagName.toLowerCase()
      const attributes = [
        'data-assistant-card-home',
        'data-assistant-card-pet',
        'data-assistant-card-skills',
        'data-assistant-card-background-sweep',
        'data-assistant-card-routines',
        'data-assistant-card-check-ins',
        'data-assistant-card-model-heading',
        'data-assistant-card-persona',
        'data-assistant-card-personality',
        'data-atum-routines-row'
      ]
        .filter(name => row.hasAttribute(name))
        .sort()
        .join(',')

      return `${tag}:${row.getAttribute('data-agent-home-row') ?? ''}:${attributes}`
    })

  const personaRows = () =>
    [...window.document.querySelectorAll<HTMLElement>('[data-assistant-card-persona] [data-assistant-card-personality]')].length

  async function openCard(principal: string, extra: (agent: MatrixAgentView) => MatrixAgentView) {
    const base = snapshot()
    base.agents = base.agents?.map(each => (each.principal === principal ? extra({ ...each, home }) : each))
    window.atumMatrix = {
      assistants,
      command: vi.fn().mockResolvedValue(null),
      agentHome: { move: vi.fn(), cancel: vi.fn() } as unknown as MatrixUiBridge['agentHome'],
      backgroundSweep: {
        read: vi.fn(async () => ({
          profile: MATRIX_BACKGROUND_SWEEP_SETTING_PROFILE,
          assistantId: '00000000-0000-4000-8000-288c0dd127cf',
          enabled: false,
          revision: 1,
          activeForOwner: true
        })),
        save: vi.fn()
      } as unknown as MatrixBackgroundSweepBridge,
      routines: {
        read: vi.fn(async (principal: string) => ({
          ok: true as const,
          snapshot: {
            assistantId: '00000000-0000-4000-8000-5b3379da4cd1',
            assistantPrincipal: principal,
            serverTime: 1,
            legacyState: 'clear' as const,
            routines: []
          }
        }))
      } as unknown as MatrixRoutinesBridge
    } as unknown as MatrixUiBridge

    render(<Window base={base} />)
    act(() => openAssistantCard({ kind: 'agent', principal }))
    await waitFor(() => expect(assistants.read).toHaveBeenCalledWith(principal))
    await screen.findByText('Xong')
  }

  it('draws the same rows for template, primary and custom personas, apart from primary privileges', async () => {
    // The primary's own persona is the built-in paragraph (no two-section template) and the
    // platform seeded it, so `inherited` is false — the shape that used to lose "Tính cách".
    assistants.read.mockImplementation(async principal => ({
      ok: true,
      card: card(principal, {
        soul: principal === ATUM
          ? '# Atum\n\nYou are Atum, the person’s own assistant in the Atum app. If they give you another name, use it from then on and remember it.\n\nBe warm and brief.'
          : principal === 'agent-mai'
            ? '# Mai\n\nYou are Mai, a hand-written research partner.\n\n## Rules\n\nKeep citations exact.'
            : SOUL
      })
    }))

    await openCard(ATUM, each => ({ ...each, home }))
    const primary = rowsOf()
    const primaryPersona = personaRows()
    cleanup()

    await openCard(LAN, each => ({ ...each, home }))
    const template = rowsOf()
    const templatePersona = personaRows()
    cleanup()

    await openCard('agent-mai', each => ({ ...each, home }))
    const custom = rowsOf()
    const customPersona = personaRows()
    const customField = screen.getByRole('textbox', { name: 'Mai giúp bạn việc gì?' }) as HTMLTextAreaElement

    // The documented privilege: the primary has no Delete row (it lives outside the rows group).
    expect(primary).toEqual(template)
    expect(primary).toEqual(custom)
    expect(primaryPersona).toBe(1)
    expect(templatePersona).toBe(1)
    expect(customPersona).toBe(1)
    expect(customField.value).toBe('You are Mai, a hand-written research partner.\n\n## Rules\n\nKeep citations exact.')
    expect(primary.some(row => row.includes('data-assistant-card-home'))).toBe(true)
    cleanup()

    await openCard(ATUM, each => ({ ...each, home }))
    expect(window.document.querySelector('[data-assistant-card-delete]')).toBeNull()
    cleanup()

    await openCard(LAN, each => ({ ...each, home }))
    expect(window.document.querySelector('[data-assistant-card-delete]')).not.toBeNull()
  })

  it('shows the primary’s “Tính cách” row even when its card carries the built-in persona', async () => {
    assistants.read.mockImplementation(async principal => ({
      ok: true,
      card: card(principal, {
        soul: principal === ATUM
          ? '# Atum\n\nYou are Atum, the person’s own assistant in the Atum app. If they give you another name, use it from then on and remember it.\n\nBe warm and brief.'
          : SOUL
      })
    }))

    await openCard(ATUM, each => ({ ...each, home }))

    expect(screen.getByRole('button', { name: /^Tính cách/ })).toBeTruthy()
    const field = screen.getByRole('textbox', { name: 'Atum giúp bạn việc gì?' }) as HTMLTextAreaElement
    expect(field.value).toBe('Be warm and brief.')
  })
})
