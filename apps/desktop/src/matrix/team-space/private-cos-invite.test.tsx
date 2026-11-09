import { render, screen, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixRoom } from '../../../shared/matrix'
import {
  MATRIX_COMPANY_PRIVATE_COS_ASYNC_PROFILE,
  MATRIX_COMPANY_PRIVATE_COS_INTEGRATION_PROFILE,
  MATRIX_COMPANY_PRIVATE_COS_PROTECTED_STATE,
  MATRIX_COMPANY_PRIVATE_COS_ROOM_TYPE
} from '../../../shared/matrix-company-private-cos'
import { resetMatrixHandleContactsForTest } from '../person-handle-contacts'
import { bindMatrixHandleOwner, rememberMatrixHandle, resetMatrixHandlesForTest } from '../person-handles'

import { teamSpaceKey } from './keys'
import { companyPrivateCosInvitation, PrivateCosAutoJoin } from './private-cos-invite'
import { PrivateCosMemberRow } from './private-cos-member-row'
import { $companyPrivateCos, type CompanyPrivateCosState } from './private-cos-store'

const COMPANY = '00000000-0000-4000-8000-87c6455cae48'
const INCARNATION = '00000000-0000-4000-8000-f6c6b8bb709f'
const EXECUTOR = '00000000-0000-4000-8000-8a4e23bab81e'
const OWNER = '@owner:atum.example'
const AGENT = '@private-cos:atum.example'
const MANAGER = '@manager:atum.example'

const powerLevels = () => ({
  users: { [MANAGER]: 100, [OWNER]: 0, [AGENT]: 0 },
  users_default: 0,
  events_default: 0,
  state_default: 100,
  invite: 100,
  kick: 100,
  ban: 100,
  redact: 100,
  events: Object.fromEntries(MATRIX_COMPANY_PRIVATE_COS_PROTECTED_STATE.map(type => [type, 100]))
})

const state: CompanyPrivateCosState = {
  served: true,
  profile: MATRIX_COMPANY_PRIVATE_COS_INTEGRATION_PROFILE,
  capability: {
    schemaVersion: 3,
    profile: MATRIX_COMPANY_PRIVATE_COS_INTEGRATION_PROFILE,
    capability: 'company.private-cos',
    supportedProfiles: [
      'atum.company-private-cos/1',
      MATRIX_COMPANY_PRIVATE_COS_ASYNC_PROFILE,
      MATRIX_COMPANY_PRIVATE_COS_INTEGRATION_PROFILE
    ],
    wire: { header: 'Atum-Company-Wire', value: '1.2' },
    displayName: 'Chief of Staff',
    teamDmPosition: 2,
    lazyCreation: true,
    fundingKind: 'company_wallet',
    separatePrice: false,
    purgeAfterDays: 30,
    userExport: false,
    roomType: 'io.atum.assistant',
    roomName: 'Chief of Staff',
    roomEncrypted: false,
    greetingVersion: 2
  },
  availability: 'preparing',
  loading: false,
  view: {
    schemaVersion: 1,
    state: 'preparing',
    pair: {
      companyPrincipal: COMPANY,
      memberPrincipal: '00000000-0000-4000-8000-f9ae298d66d3',
      membershipIncarnation: INCARNATION
    },
    greetingState: 'pending',
    binding: {
      scope: {
        pair: {
          companyPrincipal: COMPANY,
          memberPrincipal: '00000000-0000-4000-8000-f9ae298d66d3',
          membershipIncarnation: INCARNATION
        },
        authorityEpoch: 1,
        contextEpoch: 1,
        homeGeneration: 1
      },
      agentPrincipal: '00000000-0000-4000-8000-7886f5c6d975',
      agentUserId: AGENT,
      executorId: EXECUTOR,
      homeId: '00000000-0000-4000-8000-1b6f89097c58',
      roomId: '!private-cos:atum.example',
      storeGeneration: 1,
      profileDigest: 'a'.repeat(64)
    }
  }
}

const room = (over: Partial<MatrixRoom> = {}): MatrixRoom => ({
  id: '!private-cos:atum.example',
  name: 'Chief of Staff',
  membership: 'invite',
  encrypted: false,
  roomType: MATRIX_COMPANY_PRIVATE_COS_ROOM_TYPE,
  roomVersion: '11',
  companyPrivateCos: {
    v: 1,
    classification: 'company_private_cos',
    companyId: COMPANY,
    membershipIncarnation: INCARNATION,
    executorId: EXECUTOR
  },
  joinRule: 'invite',
  historyVisibility: 'joined',
  participants: [
    { userId: OWNER, membership: 'invite' },
    { userId: AGENT, membership: 'invite' }
  ],
  powerLevels: powerLevels(),
  ...over
})

const props = (over: Partial<ComponentProps<typeof PrivateCosAutoJoin>> = {}) => ({
  accountKey: 'account',
  activeMember: true,
  companyId: COMPANY,
  rooms: [room()],
  state,
  onAccept: vi.fn(async () => {}),
  onReject: vi.fn(async () => {}),
  onVerified: vi.fn(async () => {}),
  ...over
})

const joined = (value: MatrixRoom): MatrixRoom => ({
  ...value,
  membership: 'join',
  participants: value.participants?.map(participant => ({ ...participant, membership: 'join' }))
})

describe('private Chief of Staff automatic invitation admission', () => {
  it('shows the bound private assistant handle below its display name in the people row', () => {
    const key=teamSpaceKey('test-handles',COMPANY)
    $companyPrivateCos.setKey(key,state)
    bindMatrixHandleOwner(OWNER)
    rememberMatrixHandle(AGENT,'wendy_bot')
    const view=render(<I18nProvider configClient={null} initialLocale="en"><PrivateCosMemberRow
      accountKey="test-handles" companyId={COMPANY} name="Wendy" principal={EXECUTOR} /></I18nProvider>)
    try { expect(screen.getByText('@wendy_bot')).toBeTruthy() }
    finally {
      view.unmount()
      $companyPrivateCos.setKey(key,undefined as never)
      resetMatrixHandleContactsForTest()
      resetMatrixHandlesForTest()
    }
  })

  it('joins by bound room id, then verifies the full plain room without prompting', async () => {
    const invited = room({
      companyPrivateCos: undefined,
      joinRule: undefined,
      historyVisibility: undefined,
      participants: undefined,
      powerLevels: undefined,
      roomVersion: undefined
    })
    const value = props({ rooms: [invited] })
    const view = render(<PrivateCosAutoJoin {...value} />)

    await waitFor(() => expect(value.onAccept).toHaveBeenCalledExactlyOnceWith(invited.id))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()

    view.rerender(<PrivateCosAutoJoin {...value} rooms={[joined(room())]} />)
    await waitFor(() => expect(value.onVerified).toHaveBeenCalledExactlyOnceWith(invited.id))
    expect(value.onReject).not.toHaveBeenCalled()
  })

  it.each([
    ['wrong marker', room({ companyPrivateCos: undefined })],
    ['wrong company', room({ companyPrivateCos: { ...room().companyPrivateCos!, companyId: '00000000-0000-4000-8000-33576889ad39' } })],
    ['stale incarnation', room({ companyPrivateCos: { ...room().companyPrivateCos!, membershipIncarnation: '00000000-0000-4000-8000-33576889ad39' } })],
    ['encrypted room', room({ encrypted: true })]
  ])('joins the bound %s look-alike, then rejects and hides it after full-state verification', async (_name, candidate) => {
    const value = props({ rooms: [candidate] })
    const view = render(<PrivateCosAutoJoin {...value} />)

    await waitFor(() => expect(value.onAccept).toHaveBeenCalledExactlyOnceWith(candidate.id))
    expect(companyPrivateCosInvitation(state, COMPANY, true, [candidate])?.id).toBe(candidate.id)

    view.rerender(<PrivateCosAutoJoin {...value} rooms={[joined(candidate)]} />)
    await waitFor(() => expect(value.onReject).toHaveBeenCalledExactlyOnceWith(candidate.id))
    expect(value.onVerified).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it.each(MATRIX_COMPANY_PRIVATE_COS_PROTECTED_STATE)(
    'refuses a room whose effective %s state power is editable at zero',
    async eventType => {
      const unsafe = powerLevels()
      unsafe.events[eventType] = 0
      const value = props({ rooms: [joined(room({ powerLevels: unsafe }))] })

      render(<PrivateCosAutoJoin {...value} />)
      await waitFor(() => expect(value.onReject).toHaveBeenCalledOnce())
      expect(value.onVerified).not.toHaveBeenCalled()
    }
  )

  it('uses state_default when a protected event override is absent', async () => {
    const effective = powerLevels()
    delete effective.events['m.room.avatar']
    const value = props({ rooms: [joined(room({ powerLevels: effective }))] })

    render(<PrivateCosAutoJoin {...value} />)
    await waitFor(() => expect(value.onVerified).toHaveBeenCalledOnce())
    expect(value.onReject).not.toHaveBeenCalled()
  })
})
