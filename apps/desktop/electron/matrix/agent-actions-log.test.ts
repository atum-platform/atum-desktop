import { describe, expect, it } from 'vitest'

import type { MatrixAgentView } from '../../shared/matrix'

import { MatrixAgentActionsLog } from './agent-actions-log'

const agent = (principal: string, extra: Partial<MatrixAgentView> = {}): MatrixAgentView => ({
  principal,
  userId: `@${principal}:test`,
  name: 'Secret Name',
  isDefault: false,
  ready: true,
  hermes: 'ready',
  atumModel: true,
  ...extra
})

function log() {
  const lines: string[] = []

  return { lines, actions: new MatrixAgentActionsLog(line => lines.push(line)) }
}

describe('what the window offers per assistant, in the log', () => {
  it('says once per assistant what it offers, and again only when that changes', () => {
    const { lines, actions } = log()
    const local = agent('895ac081aaaa')
    const cloud = agent('c10dc10dbbbb', { ready: false, answering: 'cloud' })

    actions.observe([local, cloud])
    actions.observe([local, cloud])
    expect(lines).toEqual([
      '[Matrix] agent actions agent=895ac081 place=local ready=1 group=offered photo=offered move=offered',
      '[Matrix] agent actions agent=c10dc10d place=cloud ready=0 group=hidden photo=offered move=hidden'
    ])

    // A local assistant not ready yet is listed in the group picker as not ready: blocked, not hidden.
    // Canonical owner photo edits remain available independently of host readiness.
    actions.observe([{ ...local, ready: false }, cloud])
    expect(lines.at(-1)).toBe(
      '[Matrix] agent actions agent=895ac081 place=local ready=0 group=blocked photo=offered move=hidden'
    )
    expect(lines).toHaveLength(3)
  })

  it('says which Mac role a cloud-route assistant has here, so a missing Group action can be read from the log', () => {
    const { lines, actions } = log()
    const raymond = agent('89761133cccc', { answering: 'cloud', macRole: 'answering' })

    actions.observe([raymond])
    actions.observe([{ ...raymond, macRole: 'standby' }])
    expect(lines).toEqual([
      '[Matrix] agent actions agent=89761133 place=cloud ready=1 group=offered photo=offered move=hidden mac=answering',
      '[Matrix] agent actions agent=89761133 place=cloud ready=1 group=hidden photo=offered move=hidden mac=standby'
    ])
  })

  it('carries no name, user or room, only the principal’s first 8 characters', () => {
    const { lines, actions } = log()
    actions.observe([agent('0123456789abcdef')])
    expect(lines[0]).not.toMatch(/Secret|@|!|0123456789/)
    expect(lines[0]).toContain('agent=01234567')
  })

  it('forgets an assistant that leaves (or a signed-out account), so it is said again if it returns', () => {
    const { lines, actions } = log()
    const each = agent('aaaaaaaa1111')
    actions.observe([each])
    actions.observe(undefined)
    actions.observe([each])
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe(lines[1])
  })
})
