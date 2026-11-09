/**
 * Per-agent pet state: one pet per assistant, with the active agent's slice
 * exposed through the plain `$petInfo` / `$petActivity` / `$petUnread` views the
 * in-window surfaces already read.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import {
  $petActivity,
  $petActivityByAgent,
  $petInfo,
  $petInfoByAgent,
  $petUnread,
  $petUnreadByAgent,
  clearPetUnread,
  markPetUnread,
  petActivityFor,
  petInfoFor,
  petProfile,
  setPetActivity,
  setPetInfo,
  syncActivePetViews
} from './pet'
import { $activeGatewayProfile } from './profile'

const GIGI = { displayName: 'Gigi', enabled: true, slug: 'gigi' }
const FROG = { displayName: 'Codex Frog', enabled: true, slug: 'codex-frog' }

beforeEach(() => {
  $petInfoByAgent.set({})
  $petActivityByAgent.set({})
  $petUnreadByAgent.set({})
  $activeGatewayProfile.set('default')
  syncActivePetViews()
})

describe('agent keying', () => {
  it('uses the active profile key, which is never empty', () => {
    expect(petProfile()).toBe('default')

    $activeGatewayProfile.set('')
    expect(petProfile()).toBe('default')

    $activeGatewayProfile.set('marketing')
    expect(petProfile()).toBe('marketing')
  })
})

describe('per-agent pet info', () => {
  it('keeps each assistant on its own pet', () => {
    setPetInfo(GIGI, 'default')
    setPetInfo(FROG, 'marketing')

    expect(petInfoFor('default')).toEqual(GIGI)
    expect(petInfoFor('marketing')).toEqual(FROG)
  })

  it('reports a pet-less agent as disabled rather than throwing', () => {
    expect(petInfoFor('never-seen').enabled).toBe(false)
  })

  it('does not let one agent overwrite another', () => {
    setPetInfo(GIGI, 'default')
    setPetInfo(FROG, 'marketing')
    setPetInfo({ ...GIGI, scale: 0.9 }, 'default')

    expect(petInfoFor('marketing')).toEqual(FROG)
  })
})

describe('the active-agent view', () => {
  it('shows the pet of whichever assistant is active', () => {
    setPetInfo(GIGI, 'default')
    setPetInfo(FROG, 'marketing')

    expect($petInfo.get()).toEqual(GIGI)
  })

  it('follows a switch of assistant', () => {
    setPetInfo(GIGI, 'default')
    setPetInfo(FROG, 'marketing')

    $activeGatewayProfile.set('marketing')

    expect($petInfo.get()).toEqual(FROG)
    expect($petActivity.get()).toEqual({})
  })

  it('defaults writes to the active agent', () => {
    $activeGatewayProfile.set('marketing')
    setPetInfo(FROG)

    expect(petInfoFor('marketing')).toEqual(FROG)
    expect(petInfoFor('default').enabled).toBe(false)
  })
})

describe('per-agent activity', () => {
  it('merges flags into one agent without touching another', () => {
    setPetActivity({ busy: true }, 'default')
    setPetActivity({ awaitingInput: true }, 'marketing')
    setPetActivity({ reasoning: true }, 'default')

    expect(petActivityFor('default')).toEqual({ busy: true, reasoning: true })
    expect(petActivityFor('marketing')).toEqual({ awaitingInput: true })
  })

  it('republishes the active view when the active agent changes', () => {
    setPetActivity({ busy: true }, 'default')

    expect($petActivity.get()).toEqual({ busy: true })
  })

  it('leaves the active view alone when a background agent changes', () => {
    setPetActivity({ busy: true }, 'marketing')

    expect($petActivity.get()).toEqual({})
  })
})

describe('per-agent unread', () => {
  it('marks and clears one agent at a time', () => {
    markPetUnread('marketing')

    expect($petUnread.get()).toBe(false) // active agent is 'default'

    $activeGatewayProfile.set('marketing')
    expect($petUnread.get()).toBe(true)

    clearPetUnread('marketing')
    expect($petUnread.get()).toBe(false)
  })

  it('defaults to the active agent', () => {
    markPetUnread()

    expect($petUnreadByAgent.get().default).toBe(true)
  })
})
