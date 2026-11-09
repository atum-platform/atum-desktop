import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { atom } from 'nanostores'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { projectSkillEntry } from '@/lib/atum-store-items'

const employee = '00000000-0000-4000-8000-95eb2692c90e'

const entry = projectSkillEntry({
  kind: 'skill', id: 'private-skill', title: { en: 'Research training' }, summary: { en: 'Research help' },
  detail: { description: { en: 'Research help' }, try_prompt: { en: 'Help me research' }, needs: [] },
  source: { type: 'cloud_skill' }, glyph: 'R', accent: 'blue', featured: false, sort_order: 1, hashes: [],
  offer: { id: '00000000-0000-4000-8000-676a3a34ff0f', version: 1, price_protons: 100 }
}, true)!

entry.trainedAssistantIds = [employee]
const tryAtumSkill = vi.fn()
vi.mock('./agents', () => ({ $atumAgents: atom([
  { id: 'employee-a', hostedId: employee, localProfileId: 'employee-a', title: 'An' },
  { id: 'employee-b', hostedId: '00000000-0000-4000-8000-951c747b3afc', localProfileId: 'employee-b', title: 'Bình' }
]) }))
vi.mock('./skills', () => ({
  $atumSkillRows: atom([{ entry, installedFor: ['employee-a'], assistants: [{ agentId: 'employee-a', action: 'idle' }] }]),
  loadAtumSkillPreview: vi.fn(async () => ({ files: [] })), removeAtumSkill: vi.fn(), tryAtumSkill
}))
const { SkillDetailDialog } = await import('./skill-detail-dialog')
afterEach(() => { cleanup(); vi.clearAllMocks() })

describe('protected training detail', () => {
  it('keeps adding the skill to another assistant reachable after the first one has it', () => {
    const onAdd = vi.fn()
    const onOpenChange = vi.fn()
    render(<I18nProvider configClient={null} initialLocale="en"><SkillDetailDialog entry={entry} onAdd={onAdd} onOpenChange={onOpenChange} open /></I18nProvider>)
    expect(screen.queryByText('Includes files')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Add to another assistant' }))
    expect(onAdd).toHaveBeenCalledWith(entry)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('starts the trained employee with the protected skill descriptor', () => {
    render(<I18nProvider configClient={null} initialLocale="en"><SkillDetailDialog entry={entry} onAdd={vi.fn()} onOpenChange={vi.fn()} open /></I18nProvider>)
    fireEvent.click(screen.getByRole('button', { name: 'Try' }))
    expect(tryAtumSkill).toHaveBeenCalledWith('Help me research', 'employee-a', entry)
  })
})
