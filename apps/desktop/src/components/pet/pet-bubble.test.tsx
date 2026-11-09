/**
 * The pet's bubble: status moods while she works, and what she actually said
 * once a turn lands.
 */

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { $petActivity, $petMotion, $petReplyByAgent, sayPetReply } from '@/store/pet'

import { PetBubble } from './pet-bubble'

beforeEach(() => {
  $petReplyByAgent.set({})
  $petActivity.set({})
  $petMotion.set(null)
})

afterEach(cleanup)

describe('status moods', () => {
  it('says nothing at plain idle', () => {
    const { container } = render(<PetBubble />)

    expect(container.innerHTML).toBe('')
  })

  it('speaks up when the turn is blocked on you', () => {
    $petActivity.set({ awaitingInput: true })
    render(<PetBubble />)

    expect(screen.getByText('Your turn')).toBeTruthy()
  })

  it('says nothing while the agent is merely working', () => {
    // The sprite already runs while tools run. Ten random phrasings rotating
    // every 2.6s added noise and no information, so the bubble stays shut.
    $petActivity.set({ busy: true })
    const { container } = render(<PetBubble />)

    expect(container.innerHTML).toBe('')
  })

  it('says nothing while the agent is reasoning', () => {
    $petActivity.set({ busy: true, reasoning: true })
    const { container } = render(<PetBubble />)

    expect(container.innerHTML).toBe('')
  })

  it('reports a failure, which is a real interaction', () => {
    $petActivity.set({ error: true })
    render(<PetBubble />)

    expect(screen.getByText('Something broke')).toBeTruthy()
  })
})

describe('her voice', () => {
  it('says what she was given', () => {
    $petReplyByAgent.set({ default: 'Put the notes in your project folder.' })
    render(<PetBubble />)

    expect(screen.getByText('Put the notes in your project folder.')).toBeTruthy()
  })

  it('outranks a status mood', () => {
    // "working…" is filler; an actual answer is the point.
    $petActivity.set({ busy: true })
    $petReplyByAgent.set({ default: 'Done — two files changed.' })
    render(<PetBubble />)

    expect(screen.getByText('Done — two files changed.')).toBeTruthy()
  })

  it('wears the Atum glass rather than a bespoke surface', () => {
    $petReplyByAgent.set({ default: 'Ready when you are.' })
    render(<PetBubble />)

    expect(screen.getByText('Ready when you are.').className).toContain('atum-pet-glass')
  })
})

describe('sayPetReply', () => {
  it('collapses whitespace so a wrapped reply stays one line', () => {
    sayPetReply('  Done.\n\n  Two   files changed. ', 'default')

    expect($petReplyByAgent.get().default).toBe('Done. Two files changed.')
  })

  it('ignores an empty reply rather than showing a blank bubble', () => {
    sayPetReply('   \n ', 'default')

    expect($petReplyByAgent.get().default).toBeUndefined()
  })

  it('keeps each assistant’s reply to itself', () => {
    sayPetReply('Mine.', 'marketing')

    expect($petReplyByAgent.get().marketing).toBe('Mine.')
    expect($petReplyByAgent.get().default).toBeUndefined()
  })
})
