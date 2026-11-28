import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { $betaFeatures } from '@/store/beta-features'

import { SkillsRow } from './skills-popover'

// Radix's popover measures its anchor; jsdom has no ResizeObserver.
vi.stubGlobal('ResizeObserver', class {
  observe() {}
  unobserve() {}
  disconnect() {}
})

afterEach(() => {
  cleanup()
  $betaFeatures.set({ profile: null, granted: false })
})

function openSkills(onFindMore = vi.fn()) {
  render(<SkillsRow onFindMore={onFindMore} skills={['web-search', 'reminders']} />)
  fireEvent.click(window.document.querySelector<HTMLElement>('[data-assistant-card-skills]')!)

  return onFindMore
}

describe("the assistant card's skills", () => {
  it('lists the skills it has and finds more for a beta account', async () => {
    $betaFeatures.set({ profile: 'card-test', granted: true })
    const onFindMore = openSkills()

    expect(await screen.findByText('Web search')).toBeTruthy()
    const findMore = screen.getByRole('button', { name: 'Find more skills' })

    expect((findMore as HTMLButtonElement).disabled).toBe(false)
    expect(findMore.hasAttribute('data-assistant-card-skills-coming-soon')).toBe(false)
    fireEvent.click(findMore)
    expect(onFindMore).toHaveBeenCalledOnce()
  })

  it('keeps the skills listed but greys "Find more skills" as Coming soon without beta features', async () => {
    $betaFeatures.set({ profile: 'card-test', granted: false })
    const onFindMore = openSkills()

    expect(await screen.findByText('Reminders')).toBeTruthy()
    const findMore = screen.getByRole('button', { name: 'Find more skills: Coming soon' })

    expect(findMore.textContent).toBe('Find more skillsComing soon')
    expect((findMore as HTMLButtonElement).disabled).toBe(true)
    expect(findMore.hasAttribute('data-assistant-card-skills-coming-soon')).toBe(true)
    fireEvent.click(findMore)
    expect(onFindMore).not.toHaveBeenCalled()
  })
})
