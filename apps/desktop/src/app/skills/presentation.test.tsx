// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { notifyError } from '@/store/notifications'
import type { SkillInfo, ToolsetInfo } from '@/types/hermes'

import { type SkillsPageClient, SkillsPresentation } from './presentation'

vi.mock('@/store/notifications', () => ({ notifyError: vi.fn() }))
vi.mock('@/components/chat/code-editor-surface', () => ({
  CodeEditorSurface: ({
    initialValue,
    onChange,
    onSave
  }: {
    initialValue: string
    onChange: (value: string) => void
    onSave?: () => void
  }) => (
    <textarea
      aria-label="SKILL.md"
      defaultValue={initialValue}
      onChange={event => onChange(event.target.value)}
      onKeyDown={event => event.key === 'Enter' && (event.metaKey || event.ctrlKey) && onSave?.()}
    />
  )
}))

const skill = (overrides: Partial<SkillInfo> = {}): SkillInfo => ({
  category: 'writing',
  description: 'Draft polished prose',
  enabled: true,
  name: 'writer',
  provenance: 'bundled',
  ...overrides
})

const toolset = (overrides: Partial<ToolsetInfo> = {}): ToolsetInfo => ({
  configured: true,
  description: 'Search the web',
  enabled: true,
  label: 'Web Search',
  name: 'web',
  tools: ['web_search'],
  ...overrides
})

function client(overrides: Partial<SkillsPageClient> = {}): SkillsPageClient {
  return {
    getSkills: vi.fn().mockResolvedValue([skill(), skill({ category: 'coding', name: 'reviewer' })]),
    getToolsets: vi.fn().mockResolvedValue([toolset()]),
    toggleSkill: vi.fn().mockResolvedValue(undefined),
    toggleToolset: vi.fn().mockResolvedValue(undefined),
    ...overrides
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void

  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })

  return { promise, reject, resolve }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('SkillsPresentation', () => {
  it('shows an injected hub only when supported and refreshes installed truth on return', async () => {
    const api = client()
    render(
      <SkillsPresentation
        client={api}
        renderHub={(query, refresh) => <button onClick={refresh}>Hub fixture {query}</button>}
      />
    )
    await screen.findByText('writer')
    fireEvent.click(screen.getByRole('button', { name: /browse hub/i }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'jupyter' } })
    fireEvent.click(screen.getByRole('button', { name: 'Hub fixture jupyter' }))
    await waitFor(() => expect(api.getSkills).toHaveBeenCalledTimes(2))
    fireEvent.click(screen.getAllByRole('button', { name: /^skills/i })[0])
    await waitFor(() => expect(api.getSkills).toHaveBeenCalledTimes(3))
    expect(screen.queryByText(/Hub fixture/)).toBeNull()
  })

  it('lists searchable installed capabilities and exposes only the first-path tabs', async () => {
    render(<SkillsPresentation client={client()} />)

    expect(await screen.findByText('writer')).toBeTruthy()
    expect(screen.getByText('Draft polished prose')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /^skills/i }).length).toBeGreaterThan(0)
    expect(screen.getAllByRole('button', { name: /^tools/i }).length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: /mcp/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /hub/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /install|configure|edit|archive/i })).toBeNull()

    fireEvent.change(screen.getByRole('textbox', { name: /search skills/i }), { target: { value: 'coding' } })
    expect((await screen.findAllByText('reviewer')).length).toBeGreaterThan(0)
    expect(screen.queryByText('writer')).toBeNull()

    fireEvent.click(screen.getAllByRole('button', { name: /^tools/i })[0])
    fireEvent.change(screen.getByRole('textbox', { name: /search tools/i }), { target: { value: '' } })
    expect(await screen.findByRole('switch', { name: 'Toggle Web Search toolset' })).toBeTruthy()
    expect(screen.getByText('web_search')).toBeTruthy()
  })

  it('keeps the existing desktop toolset curation and rolls back a failed toolset switch', async () => {
    const toggleToolset = vi.fn().mockRejectedValue(new Error('write failed'))
    render(
      <SkillsPresentation
        client={client({
          toggleToolset,
          getToolsets: vi.fn().mockResolvedValue([toolset(), toolset({ name: 'context_engine', label: 'Internal' })])
        })}
      />
    )
    await screen.findByText('writer')
    fireEvent.click(screen.getAllByRole('button', { name: /^tools/i })[0])
    expect(screen.queryByRole('switch', { name: /Internal/ })).toBeNull()
    const toggle = await screen.findByRole('switch', { name: 'Toggle Web Search toolset' })
    fireEvent.click(toggle)
    await waitFor(() => expect(toggleToolset).toHaveBeenCalledWith('web', false))
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'))
    expect(notifyError).toHaveBeenCalled()
  })

  it('optimistically toggles, rolls back a rejected write, and reports the error', async () => {
    const toggleSkill = vi.fn().mockRejectedValue(new Error('write failed'))
    render(<SkillsPresentation client={client({ toggleSkill })} />)

    const toggle = await screen.findByRole('switch', { name: 'writer' })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    fireEvent.click(toggle)

    await waitFor(() => expect(toggleSkill).toHaveBeenCalledWith('writer', false))
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'))
    expect(notifyError).toHaveBeenCalled()
  })

  it('serializes distinct toggles so config writes cannot race', async () => {
    const first = deferred<void>()
    const second = deferred<void>()

    const toggleSkill = vi
      .fn()
      .mockImplementation((name: string) => (name === 'writer' ? first.promise : second.promise))

    render(<SkillsPresentation client={client({ toggleSkill })} />)

    const writer = await screen.findByRole('switch', { name: 'writer' })
    const reviewer = screen.getByRole('switch', { name: 'reviewer' })
    fireEvent.click(writer)
    fireEvent.click(reviewer)

    await waitFor(() => expect(toggleSkill).toHaveBeenCalledTimes(1))
    expect(toggleSkill).toHaveBeenCalledWith('writer', false)

    await act(async () => first.resolve())
    await waitFor(() => expect(toggleSkill).toHaveBeenCalledWith('reviewer', false))
    await act(async () => second.resolve())
  })

  it('renders a retriable load error', async () => {
    const getSkills = vi.fn().mockRejectedValue(new Error('backend unavailable'))
    render(<SkillsPresentation client={client({ getSkills })} />)

    expect(await screen.findByText('backend unavailable')).toBeTruthy()
    const refresh = screen.getByRole('button', { name: /refresh skills/i })
    fireEvent.click(refresh)
    await waitFor(() => expect(getSkills).toHaveBeenCalledTimes(2))
  })

  it('drops late responses after close instead of corrupting the next page mount', async () => {
    const oldSkills = deferred<SkillInfo[]>()
    const oldToolsets = deferred<ToolsetInfo[]>()
    const first = client({ getSkills: () => oldSkills.promise, getToolsets: () => oldToolsets.promise })
    const close = vi.fn()
    const firstView = render(<SkillsPresentation client={first} onClose={close} />)

    fireEvent.click(screen.getByRole('button', { name: /close/i }))
    expect(close).toHaveBeenCalledOnce()
    firstView.unmount()
    render(
      <SkillsPresentation client={client({ getSkills: vi.fn().mockResolvedValue([skill({ name: 'new-skill' })]) })} />
    )

    await act(async () => {
      oldSkills.resolve([skill({ name: 'stale-skill' })])
      oldToolsets.resolve([toolset({ name: 'stale-tools' })])
    })

    expect((await screen.findAllByText('new-skill')).length).toBeGreaterThan(0)
    expect(screen.queryByText('stale-skill')).toBeNull()
  })

  it('keeps bundled skills read-only and offers learned controls only with the complete scoped client', async () => {
    const learned = skill({ name: 'learned-writer', provenance: 'agent' })

    const unavailable = render(
      <SkillsPresentation client={client({ getSkills: vi.fn().mockResolvedValue([learned]) })} />
    )

    await screen.findAllByText('learned-writer')
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
    unavailable.unmount()

    render(
      <SkillsPresentation
        client={client({
          archiveLearnedSkill: vi.fn(),
          editLearnedSkill: vi.fn(),
          getLearnedSkill: vi.fn(),
          getSkills: vi.fn().mockResolvedValue([skill(), learned])
        })}
      />
    )

    await screen.findByText('writer')
    fireEvent.click(screen.getAllByText('writer')[0])
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
    fireEvent.click(screen.getAllByText('learned-writer')[0])
    expect(await screen.findByRole('button', { name: 'Edit' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Archive' })).toBeTruthy()
    expect(screen.getByText('Changes apply to new sessions.')).toBeTruthy()
  })

  it('loads the full learned SKILL.md, saves it through the scoped client, and refreshes installed truth', async () => {
    const learned = skill({ name: 'learned-writer', provenance: 'agent' })
    const getSkills = vi.fn().mockResolvedValue([learned])

    const getLearnedSkill = vi.fn().mockResolvedValue({
      content: '---\nname: learned-writer\n---\nOriginal',
      id: 'learned-writer',
      kind: 'skill',
      label: 'Learned writer',
      ok: true
    })

    const editLearnedSkill = vi.fn().mockResolvedValue({ message: '', ok: true })
    render(
      <SkillsPresentation
        client={client({
          editLearnedSkill,
          getLearnedSkill,
          getSkills,
          archiveLearnedSkill: vi.fn().mockResolvedValue({ message: '', ok: true })
        })}
      />
    )

    await screen.findByRole('button', { name: 'Edit' })
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const editor = await screen.findByRole('textbox', { name: 'SKILL.md' })
    expect((editor as HTMLTextAreaElement).value).toContain('Original')
    fireEvent.change(editor, { target: { value: '---\nname: learned-writer\n---\nRevised' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(editLearnedSkill).toHaveBeenCalledWith('learned-writer', '---\nname: learned-writer\n---\nRevised')
    )
    await waitFor(() => expect(getSkills).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('textbox', { name: 'SKILL.md' })).toBeNull()
  })

  it('keeps the editor open with a recoverable error when a learned save is rejected', async () => {
    const learned = skill({ name: 'learned-writer', provenance: 'agent' })
    const editLearnedSkill = vi.fn().mockResolvedValue({ message: 'save unavailable', ok: false })
    render(
      <SkillsPresentation
        client={client({
          editLearnedSkill,
          getLearnedSkill: vi.fn().mockResolvedValue({
            content: 'Original',
            id: 'learned-writer',
            kind: 'skill',
            label: 'Learned writer',
            ok: true
          }),
          getSkills: vi.fn().mockResolvedValue([learned]),
          archiveLearnedSkill: vi.fn().mockResolvedValue({ message: '', ok: true })
        })}
      />
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    await screen.findByRole('textbox', { name: 'SKILL.md' })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect((await screen.findByRole('alert')).textContent).toContain('save unavailable')
    expect(screen.getByRole('textbox', { name: 'SKILL.md' })).toBeTruthy()
  })

  it('ignores a learned editor load after switching to Tools', async () => {
    const pending = deferred<Awaited<ReturnType<NonNullable<SkillsPageClient['getLearnedSkill']>>>>()
    render(
      <SkillsPresentation
        client={client({
          archiveLearnedSkill: vi.fn(),
          editLearnedSkill: vi.fn(),
          getLearnedSkill: vi.fn().mockReturnValue(pending.promise),
          getSkills: vi.fn().mockResolvedValue([skill({ name: 'learned-writer', provenance: 'agent' })])
        })}
      />
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    fireEvent.click(screen.getAllByRole('button', { name: /^tools/i })[0])
    await act(async () => {
      pending.resolve({ ok: true, id: 'learned-writer', kind: 'skill', label: 'Learned writer', content: 'Old load' })
      await pending.promise
    })
    expect(screen.queryByRole('textbox', { name: 'SKILL.md' })).toBeNull()
    expect(screen.getByRole('heading', { name: 'Web Search' })).toBeTruthy()
  })

  it('does not refresh the closed agent page after a delayed learned save', async () => {
    const pending = deferred<{ ok: boolean; message: string }>()
    const getSkills = vi.fn().mockResolvedValue([skill({ name: 'learned-writer', provenance: 'agent' })])
    const { unmount } = render(
      <SkillsPresentation
        client={client({
          archiveLearnedSkill: vi.fn(),
          editLearnedSkill: vi.fn().mockReturnValue(pending.promise),
          getLearnedSkill: vi.fn().mockResolvedValue({
            ok: true,
            id: 'learned-writer',
            kind: 'skill',
            label: 'Learned writer',
            content: 'Original'
          }),
          getSkills
        })}
      />
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    await screen.findByRole('textbox', { name: 'SKILL.md' })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    unmount()
    await act(async () => {
      pending.resolve({ ok: true, message: '' })
      await pending.promise
    })
    expect(getSkills).toHaveBeenCalledTimes(1)
  })

  it('requires recoverable archive confirmation, leaves cancel alone, and refreshes only after confirmation', async () => {
    const learned = skill({ name: 'learned-writer', provenance: 'agent' })
    const getSkills = vi.fn().mockResolvedValueOnce([learned]).mockResolvedValue([])
    const archiveLearnedSkill = vi.fn().mockResolvedValue({ message: '', ok: true })
    render(
      <SkillsPresentation
        client={client({
          archiveLearnedSkill,
          editLearnedSkill: vi.fn().mockResolvedValue({ message: '', ok: true }),
          getLearnedSkill: vi.fn(),
          getSkills
        })}
      />
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Archive' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Restorable via hermes curator restore.')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(archiveLearnedSkill).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Archive' }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Archive' }))
    await waitFor(() => expect(archiveLearnedSkill).toHaveBeenCalledWith('learned-writer'))
    await waitFor(() => expect(getSkills).toHaveBeenCalledTimes(2))
    expect(screen.queryByText('learned-writer')).toBeNull()
  })
})
