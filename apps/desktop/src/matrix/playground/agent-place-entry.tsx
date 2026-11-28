import '../../styles.css'

import { createRoot } from 'react-dom/client'

import { AtumMainHeaderSurface } from '@/app/atum/shell-surface'
import { I18nProvider } from '@/i18n'

import type { MatrixAgentView, MatrixRoom, MatrixSnapshot } from '../../../shared/matrix'
import { MATRIX_ASSISTANT_ROOM_TYPE } from '../../../shared/matrix-assistant-room'
import type { WorkAgentPlans } from '../../../shared/matrix-work'
import type { WorkRelayMachine } from '../../../shared/matrix-work-relay'
import { AgentPlaceFor } from '../agent-place-icon'
import { MatrixAppearance } from '../appearance'
import { MatrixProfileAvatar } from '../profile-avatar'
import { MatrixRosterConversations } from '../roster-conversations'

/**
 * The place icon beside assistant names (agent-place.ts), dev only, on fixture data: the real roster
 * and the real header layout leaf with four cloud assistants, one on an Atum model (the cloud), one
 * on a Claude plan through the Mac mini, one through a MacBook Air, one whose only Mac (a Mac Studio)
 * is off. The full playground cannot load in a
 * plain browser (relay-entry.tsx says why), so the screenshots come from here (agent-place-fixture.html).
 */
const OWNER = '@owner:atum.invalid'
const MINI: WorkRelayMachine = { id: 'svc-mini', name: 'Mac mini', kind: 'mac-mini', online: true }
const AIR: WorkRelayMachine = { id: 'svc-air', name: 'MacBook Air', kind: 'laptop', online: true }

const agent = (principal: string, name: string, title: string): MatrixAgentView => ({
  principal,
  userId: `@${principal}:atum.invalid`,
  name,
  title,
  isDefault: false,
  ready: true,
  hermes: 'ready',
  atumModel: true,
  answering: 'cloud'
})

const AGENTS = [
  agent('sky', 'Sky', 'Research'),
  agent('rin', 'Rin', 'Engineering'),
  agent('lan', 'Lan', 'Writing'),
  agent('kai', 'Kai', 'Design')
]

const PLANS: Record<string, WorkAgentPlans> = {
  sky: { published: true, plans: {}, selection: null },
  rin: {
    published: true,
    plans: { claude: { state: 'connected' } },
    selection: { provider: 'atum-work', plan: 'claude', model: 'claude-opus', revision: 1 },
    machines: { claude: [MINI, { ...AIR, online: false }] }
  },
  lan: {
    published: true,
    plans: { codex: { state: 'connected' } },
    selection: { provider: 'atum-work', plan: 'codex', model: 'gpt-sol', revision: 1 },
    machines: { codex: [AIR] }
  },
  // Its only Mac is off: the turn waits or falls back, and the icon is dimmed as in the picker.
  kai: {
    published: true,
    plans: { antigravity: { state: 'connected' } },
    selection: { provider: 'atum-work', plan: 'antigravity', model: 'gemini', revision: 1 },
    machines: { antigravity: [{ id: 'svc-studio', name: 'Mac Studio', kind: 'mac-studio', online: false }] }
  }
}

const room = (each: MatrixAgentView, at: number, text: string): MatrixRoom => ({
  id: `!${each.principal}:atum.invalid`,
  name: each.name ?? each.principal,
  membership: 'join',
  encrypted: true,
  roomType: MATRIX_ASSISTANT_ROOM_TYPE,
  agentPrincipal: each.principal,
  assistant: true,
  lastActiveAt: at,
  preview: { kind: 'text', text, own: false, at },
  participants: [
    { userId: OWNER, membership: 'join' },
    { userId: each.userId, membership: 'join' }
  ]
})

const SNAPSHOT = {
  state: 'ready',
  identity: { userId: OWNER, deviceId: 'OWNER' },
  ownProfile: { userId: OWNER, displayName: 'Owner', avatarMxc: null },
  agents: AGENTS,
  rooms: [room(AGENTS[0]!, 3, 'Three sources agree on the date.'), room(AGENTS[1]!, 2, 'The tests pass on the branch.'), room(AGENTS[2]!, 1, 'Draft two is in Drive.'), room(AGENTS[3]!, 0, 'Two layouts to compare.')],
  roomId: '!rin:atum.invalid'
} as unknown as MatrixSnapshot

;(window as unknown as { atumMatrix: unknown }).atumMatrix = {
  command: async () => null,
  work: { readAgentPlans: async (principal: string) => PLANS[principal] ?? null }
}

function Header({ who }: { who: MatrixAgentView }) {
  return (
    <AtumMainHeaderSurface data-agent-place-fixture-header={who.principal}>
      <div className="flex min-w-0 flex-1 items-center gap-2.5" data-matrix-header-identity>
        <button
          aria-describedby={`place-${who.principal}`}
          className="atum-header-identity -ms-1.5 flex min-w-0 items-center gap-2.5 rounded-lg px-1.5 py-0.5"
          type="button"
        >
          <MatrixProfileAvatar
            className="size-[22px] shrink-0 rounded-lg text-xs"
            id={who.principal}
            name={who.name ?? ''}
            target={{ kind: 'agent', principal: who.principal }}
          />
          <span className="max-w-full shrink-0 truncate [font:var(--ak-t-headline)]">{who.name}</span>
          <AgentPlaceFor accountUserId={OWNER} agent={who} className="-ms-1" labelId={`place-${who.principal}`} />
          <span className="truncate text-[0.8125rem] text-(--atum-ink-faint)">{who.title}</span>
        </button>
      </div>
    </AtumMainHeaderSurface>
  )
}

createRoot(document.getElementById('root')!).render(
  <I18nProvider configClient={null} initialLocale="en">
    <MatrixAppearance />
    <main className="atum-shell atum-window-ground flex h-dvh min-h-0 gap-6 overflow-hidden p-6 text-(--atum-ink)">
      <aside className="w-72 shrink-0 overflow-hidden rounded-xl border border-(--atum-line) px-2 py-2" data-agent-place-fixture-roster>
        <MatrixRosterConversations
          assistantOpening={false}
          cloudOnly
          fail={() => undefined}
          onOpen={() => undefined}
          openAgentChat={() => undefined}
          openAssistant={() => undefined}
          snapshot={SNAPSHOT}
        />
      </aside>
      <section className="flex min-w-0 flex-1 flex-col gap-3" data-agent-place-fixture-headers>
        {AGENTS.map(each => (
          <div className="overflow-hidden rounded-xl border border-(--atum-line)" key={each.principal}>
            <Header who={each} />
          </div>
        ))}
      </section>
    </main>
  </I18nProvider>
)
