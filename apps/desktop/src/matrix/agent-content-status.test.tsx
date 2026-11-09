import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider, type Locale } from '@/i18n'
import { $appViewOverlayCount } from '@/store/app-view-overlay'

import type { MatrixAgentContentView, MatrixAgentView } from '../../shared/matrix'

import { agentContentCopy } from './agent-content-copy'
import { AgentContentDetails } from './agent-content-status'

const agent: MatrixAgentView = {
  principal: 'private-principal',
  userId: '@alfred:test',
  name: 'Alfred',
  isDefault: false,
  ready: true,
  hermes: 'ready',
  atumModel: true,
  readiness: { phase: 'ready', since: 1 }
}

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function setup(content?: MatrixAgentContentView, locale: Locale = 'en', isDefault = false) {
  function Details() {
    const [open, setOpen] = useState(false)

    return (
      <>
        {content && <button onClick={() => setOpen(true)}>{agentContentCopy[locale].title('Alfred')}</button>}
        <AgentContentDetails
          agent={{ ...agent, content, isDefault }}
          name="Alfred"
          onOpenChange={setOpen}
          open={open}
        />
      </>
    )
  }

  return render(
    <I18nProvider configClient={null} initialLocale={locale}>
      <Details />
    </I18nProvider>
  )
}

function details(locale: Locale = 'en') {
  fireEvent.click(screen.getByRole('button', { name: agentContentCopy[locale].title('Alfred') }))

  return within(screen.getByRole('dialog', { name: agentContentCopy[locale].title('Alfred') }))
}

describe('current agent content, not execution readiness', () => {
  it('does not claim an absent check succeeded and retains promoted primary content', () => {
    const view = setup()
    expect(screen.queryByRole('button')).toBeNull()
    view.unmount()
    setup({ state: 'complete' }, 'en', true)
    expect(details().getByRole('status').textContent).toBe(agentContentCopy.en.states.complete)
  })

  it.each(['en', 'vi', 'ja', 'zh', 'zh-hant'] as const)('uses localized closed states and counts in %s', locale => {
    setup(
      {
        state: 'complete',
        persona: 'matches',
        skills: { declared: 3, installedNow: 1, receiptReset: false, installed: 2, bundled: 1 },
        checkedAt: 42
      },
      locale
    )
    const copy = agentContentCopy[locale]
    const panel = details(locale)
    expect(panel.getByRole('status').textContent).toBe(copy.states.complete)
    expect(panel.getByText(copy.skills).nextElementSibling?.textContent).toBe('3')
    expect(panel.getByText(copy.counts.installed).nextElementSibling?.textContent).toBe('2')
    expect(panel.getByText(copy.personas.matches)).toBeTruthy()
    expect(panel.getByText(copy.help)).toBeTruthy()
    expect(screen.getByRole('dialog').querySelector('time')?.dateTime).toBe(new Date(42).toISOString())
    expect(panel.queryByText(copy.lastCounts)).toBeNull()
    expect(panel.getAllByRole('button')).toHaveLength(1)

    expect(screen.getByRole('dialog').textContent).not.toMatch(/private-principal|@alfred|sha256/)
  })

  it.each(['checking', 'error'] as const)(
    'labels retained counts as the last completed check, not current success (%s)',
    state => {
      setup({ state, skills: { declared: 2, installedNow: 0, receiptReset: false, installed: 2 }, checkedAt: 42 })
      const panel = details()
      expect(panel.getByRole('status').textContent).toBe(agentContentCopy.en.states[state])
      expect(panel.getByText(agentContentCopy.en.lastCounts)).toBeTruthy()
      expect(panel.queryByText(agentContentCopy.en.states.complete)).toBeNull()
    }
  )

  it('keeps checking with no completed counts honest', () => {
    setup({ state: 'checking' })
    const panel = details()
    expect(panel.queryByText(agentContentCopy.en.skills)).toBeNull()
    expect(panel.queryByText(agentContentCopy.en.lastCounts)).toBeNull()
    expect(screen.getByRole('dialog').querySelector('time')).toBeNull()
  })

  it('distinguishes kept changes, missing and refused skills, without offering replacement', () => {
    setup({
      state: 'incomplete',
      persona: 'differs',
      skills: {
        declared: 6,
        installedNow: 0,
        receiptReset: true,
        different: 1,
        suppressed: 1,
        unavailable: 1,
        unsupported: 1,
        missing: 1,
        blocked: 1
      }
    })
    const panel = details()

    for (const state of ['different', 'suppressed', 'unavailable', 'unsupported', 'missing', 'blocked'] as const) {
      expect(panel.getByText(agentContentCopy.en.counts[state]).nextElementSibling?.textContent).toBe('1')
    }

    expect(panel.getByText(agentContentCopy.en.personas.differs)).toBeTruthy()
    expect(panel.getByText(agentContentCopy.en.receiptReset)).toBeTruthy()
    expect(panel.getAllByRole('button')).toHaveLength(1)
  })

  it('holds the existing native-view overlay only while the details are open', () => {
    const view = setup({ state: 'differs' })
    expect($appViewOverlayCount.get()).toBe(0)
    details()
    expect($appViewOverlayCount.get()).toBeGreaterThan(0)
    view.unmount()
    expect($appViewOverlayCount.get()).toBe(0)
  })
})
