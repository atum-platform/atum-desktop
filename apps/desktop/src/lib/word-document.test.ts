import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { $actionPanelEpoch, $actionPanelOwner, panelOwnerKey } from '@/store/action-panel-owner'
import { $atumShellEnabled, $railDestination } from '@/store/atum-shell'
import { resetDocumentContextForTests } from '@/store/document-context'
import { $wordCompanion, resetWordCompanionForTests } from '@/store/word-companion'
import { recordPendingWordTurn, resetWordTurnLedgerForTests, startWordTurn } from '@/store/word-turn-ledger'
import { assistantChatWorkbenchScopeKey, resetWorkbenchTabs, setWorkbenchScope } from '@/store/workbench-tabs'

const { respond } = vi.hoisted(() => ({ respond: vi.fn(async (_method: string, _params: Record<string, unknown>) => undefined) }))
vi.mock('@/store/gateway', async original => ({ ...await original<object>(), gatewayForProfile: () => ({ request: respond }) }))

import { handleWordDocument } from './word-document'

const owner = { version: 1 as const, backend_id: '00000000-0000-4000-8000-bd7662a5eeb4', agent_id: '00000000-0000-4000-8000-b454f82c5857', accountId: 'a', connectionId: 'c', profile: 'default', submission_dedup: true }
const event = { type: 'word.document.request', profile: 'default', session_id: 'live', payload: { request_id: 'request', turn_id: 'turn', find: 'untrusted forwarded arguments' } }
const execute = vi.fn(async () => ({ text: 'Unsaved Word content', saved: false, revision: 'revision' }))

beforeEach(() => {
  vi.clearAllMocks()
  $atumShellEnabled.set(true); $railDestination.set('chat'); $actionPanelOwner.set(owner)
  resetWorkbenchTabs(); resetDocumentContextForTests(); resetWordCompanionForTests()
  resetWordTurnLedgerForTests()
  const scope = assistantChatWorkbenchScopeKey('chat')
  setWorkbenchScope(scope)
  $wordCompanion.set({ descriptor: { id: 'pair', path: '/work/Live.docx', name: 'Live.docx' },
    ownerKey: panelOwnerKey(), epoch: $actionPanelEpoch.get(), scopeKey: scope })
  // The gateway's message.start bridges an already-recorded submit into this
  // turn. Tests use the same turn-level ledger instead of current UI state.
  recordPendingWordTurn('default', 'live', 'submission', { mode: 'automatic', revision: 'test', wordBindingId: 'pair' })
  startWordTurn('default', 'live', 'turn', 'submission')
  vi.stubGlobal('hermesDesktop', { wordCompanion: { execute } })
})
afterEach(() => vi.unstubAllGlobals())

it('forwards only a pending request reference and returns live text to the originating gateway', async () => {
  await handleWordDocument(event, () => 'live')
  expect(execute).toHaveBeenCalledWith('pair', { profile: 'default', request_id: 'request', session_id: 'live', turn_id: 'turn' })
  expect(respond).toHaveBeenCalledWith('word.document.respond', expect.objectContaining({
    request_id: 'request', session_id: 'live', result: expect.stringContaining('Unsaved Word content')
  }))
})

it('refuses a background session or profile before touching the bridge', async () => {
  await handleWordDocument(event, () => 'other')
  await handleWordDocument({ ...event, profile: 'other' }, () => 'live')
  expect(execute).not.toHaveBeenCalled()
})

it('refuses an unknown turn before touching the bridge', async () => {
  await handleWordDocument({ ...event, payload: { ...event.payload, turn_id: 'unknown' } }, () => 'live')
  await handleWordDocument(event, () => 'live')
  expect(execute).toHaveBeenCalledTimes(1)
})

it('does not let an explicit no-document turn use the current Word pair', async () => {
  startWordTurn('default', 'live', 'without-document')
  await handleWordDocument({ ...event, payload: { ...event.payload, turn_id: 'without-document' } }, () => 'live')
  expect(execute).not.toHaveBeenCalled()
  expect(respond.mock.calls[0][1].result).toContain('WORD_CONTEXT_CHANGED')
})

it('does not disclose a late read after an account change', async () => {
  execute.mockImplementationOnce(async () => {
    $actionPanelOwner.set({ ...owner, accountId: 'b' })

    return { text: 'private late text', saved: false, revision: 'revision' }
  })
  await handleWordDocument(event, () => 'live')
  expect(respond.mock.calls[0][1].result).not.toContain('private late text')
  expect(respond.mock.calls[0][1].result).toContain('WORD_CONTEXT_CHANGED')
})
