import type { AgentMemoryBridge, AgentMemoryBrowse, AgentMemoryStatus } from '../../../shared/agent-memory'

/** `?memory=off|offline|empty|none`: the assistant card's Memory row on fixture data, no network. */
export type PlaygroundMemoryMode = 'on' | 'off' | 'offline' | 'empty' | 'none'

export function playgroundMemoryMode(params: URLSearchParams): PlaygroundMemoryMode {
  const mode = params.get('memory')

  return mode === 'off' || mode === 'offline' || mode === 'empty' || mode === 'none' ? mode : 'on'
}

const SCOPE = 'playground-memory-scope'
const day = (offset: number) => Date.UTC(2026, 10, 11) - offset * 86_400_000

function listing(): AgentMemoryBrowse {
  return {
    scope: SCOPE,
    coverage: 'partial',
    more: false,
    sources: [
      {
        handle: 'playground-source-you',
        kind: 'assistant_chat',
        coverage: 'complete',
        facts: [
          { handle: 'playground-fact-tea', text: 'Prefers tea in the afternoon, never coffee after 3 pm.', learnedAt: day(1), canOpen: true },
          { handle: 'playground-fact-launch', text: 'Working on the Hà Nội launch in December.', learnedAt: day(3), canOpen: true, correcting: true }
        ]
      },
      {
        handle: 'playground-source-linh',
        kind: 'human_dm',
        label: 'Linh',
        coverage: 'complete',
        facts: [
          { handle: 'playground-fact-linh', text: 'Linh handles the supplier contracts.', learnedAt: day(2), canOpen: true },
          { handle: 'playground-fact-friday', text: 'Weekly sync with Linh is on Friday mornings.', learnedAt: day(6), canOpen: false }
        ]
      },
      {
        handle: 'playground-source-plan',
        kind: 'drive_file',
        label: 'Q4 plan',
        coverage: 'catching_up',
        facts: [{ handle: 'playground-fact-budget', text: 'Marketing budget for Q4 is set at 40% of spend.', learnedAt: day(4), canOpen: true }]
      }
    ],
    receipts: [
      {
        key: 'playground-receipt-team',
        target: 'source',
        sourceKind: 'human_group',
        sourceLabel: 'Team Hà Nội',
        cleanup: { state: 'hidden' }
      },
      {
        key: 'playground-receipt-fact',
        target: 'fact',
        sourceKind: 'human_dm',
        sourceLabel: 'Bảo',
        cleanup: { state: 'cleaned', backupExpiresAt: Date.UTC(2026, 11, 9) }
      }
    ]
  }
}

export function playgroundAgentMemory(mode: PlaygroundMemoryMode): AgentMemoryBridge {
  let status: AgentMemoryStatus = mode === 'none' ? { available: false } : { available: true, scope: SCOPE, state: mode === 'off' ? 'off' : 'on', revision: 1 }
  const tries = new Map<string, number>()

  return {
    status: async () => ({ ok: true, status }),
    setEnabled: async (_principal, input) => {
      status = { available: true, scope: SCOPE, state: input.enabled ? 'on' : 'off', revision: input.revision + 1 }

      return { ok: true, status }
    },
    browse: async () =>
      mode === 'offline'
        ? { ok: false, reason: 'offline' }
        : { ok: true, browse: mode === 'empty' ? { ...listing(), coverage: 'complete', sources: [], receipts: [] } : listing() },
    // A first forget is accepted but not applied yet, so "Forgetting…" and its retry show.
    forget: async (_principal, input) => {
      const attempt = (tries.get(input.operationId) ?? 0) + 1
      tries.set(input.operationId, attempt)

      return { ok: true, cleanup: attempt === 1 ? { state: 'pending' } : { state: 'hidden' }, status }
    },
    correct: async (_principal, input) => ({
      ok: true,
      outcome: 'done',
      fact: { handle: input.handle, text: input.text, learnedAt: Date.now(), canOpen: true },
      status
    }),
    openSource: async () => ({ ok: true })
  }
}
