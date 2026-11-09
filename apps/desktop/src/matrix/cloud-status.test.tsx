import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { I18nProvider } from '@/i18n'

import type { MatrixAgentView, MatrixSnapshot } from '../../shared/matrix'

import { cloudRoomAgent, LinkedDocumentNotice } from './cloud-status'

const agent: MatrixAgentView = {
  principal: 'agent',
  userId: '@agent:test',
  ready: true,
  isDefault: false,
  hermes: 'ready',
  atumModel: true
}

const room = {
  id: '!room:test',
  name: 'T',
  membership: 'join' as const,
  encrypted: true,
  assistant: true,
  agentPrincipal: agent.principal
}

const snapshot: MatrixSnapshot = {
  state: 'ready',
  identity: { userId: '@owner:test', deviceId: 'MAC' },
  rooms: [room],
  roomId: room.id,
  messages: [],
  error: null,
  agents: [agent]
}

const page = (children: React.ReactNode, locale: 'en' | 'vi' | 'ja' | 'zh' | 'zh-hant' = 'en') => (
  <I18nProvider configClient={null} initialLocale={locale}>
    {children}
  </I18nProvider>
)

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'atumMatrix')
})

describe('cloud route', () => {
  it('uses roster answering, never Mac readiness or another room, as the cloud fact', () => {
    expect(cloudRoomAgent(snapshot, room)).toBeUndefined()
    const cloud = { ...snapshot, agents: [{ ...agent, ready: false, answering: 'cloud' as const }] }
    expect(cloudRoomAgent(cloud, room)?.principal).toBe(agent.principal)
    expect(cloudRoomAgent(cloud, { ...room, agentPrincipal: 'other' })).toBeUndefined()
    expect(cloudRoomAgent(cloud, { ...room, assistant: false })).toBeUndefined()
  })

  it('is not the cloud’s chat while this Mac holds the agent’s term under the saved policy', () => {
    const answering = {
      ...snapshot,
      agents: [{ ...agent, answering: 'cloud' as const, macRole: 'answering' as const }]
    }
    const standby = { ...snapshot, agents: [{ ...agent, answering: 'cloud' as const, macRole: 'standby' as const }] }

    expect(cloudRoomAgent(answering, room)).toBeUndefined()
    // A standby Mac does not answer: the cloud (or another Mac) does, so the chat stays the cloud route's.
    expect(cloudRoomAgent(standby, room)?.principal).toBe(agent.principal)
  })

  it('says only why a linked document pauses a cloud assistant, never where it answers', () => {
    Object.assign(window, { atumMatrix: {} })
    const cloud = { ...snapshot, agents: [{ ...agent, ready: false, answering: 'cloud' as const }] }
    const linked = { name: 'Draft.docx' } as MatrixSnapshot['linkedDocument']
    const view = render(page(<LinkedDocumentNotice room={room} snapshot={cloud} />, 'vi'))
    // No linked document: nothing at all.
    expect(view.container.textContent).toBe('')
    view.rerender(page(<LinkedDocumentNotice room={room} snapshot={{ ...cloud, linkedDocument: linked }} />, 'vi'))
    expect(view.container.textContent).toMatch(/Word/)
    expect(view.container.textContent).not.toMatch(/đám mây|Mac này|Trả lời trên/i)
    // A local assistant has its own path for linked documents.
    view.rerender(page(<LinkedDocumentNotice room={room} snapshot={{ ...snapshot, linkedDocument: linked }} />, 'vi'))
    expect(view.container.textContent).toBe('')
  })
})
