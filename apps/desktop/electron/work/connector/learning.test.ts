import { describe, expect, it, vi } from 'vitest'

import type { MatrixSdkCommand } from '../../../shared/matrix'

import { submitWorkLearning } from './learning'

const agent = '93c18c68-865e-4926-9bca-74df9917fd83'
const session = '0d407f2d-ff6c-441a-8d91-5c7227f57849'
const bound = `work-learning-${agent}-${session}`

const input = {
  requestId: 'ea00aa7e-6383-41f0-bf5e-1777cc94566e',
  threadId: session, text: 'Remember this format',
  modelSelection: { instanceId: 'codex', model: 'fixture' }
}

function fixture() {
  const command = vi.fn(async (request: MatrixSdkCommand): Promise<unknown> => {
    switch (request.kind) {
      case 'findAssistantRoom': return '!owner-dm:example.test'

      case 'sendWorkQuestion': return '$owner-event'

      case 'readWorkAnswer': return { learning: { threadId: bound, runId: 'accepted-run' } }

      default: throw new Error('Unexpected command')
    }
  })

  return {
    owner: () => ({ userId: '@owner:example.test', command }),
    primary: () => agent,
    server: () => 'work-aabbccdd',
    document: () => '/fixture/work/weekly-update.docx',
    agent: vi.fn(async () => '@assistant:example.test'),
    current: () => true,
    command
  }
}

describe('Work owner composer relay', () => {
  it('opens the verified native receipt with the document and chosen provider', async () => {
    const port = fixture()
    const document = { threadId: 'previous', runId: 'finished', artifactId: 'result' }
    expect(await submitWorkLearning({ ...input, document }, port)).toEqual({ status: 'started', threadId: bound })
    expect(port.command).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'sendWorkQuestion', roomId: '!owner-dm:example.test', agentId: '@assistant:example.test',
      threadId: session, learning: { server: 'work-aabbccdd', followup: false,
        model: input.modelSelection, document: '/fixture/work/weekly-update.docx' }
    }))
    expect(port.command).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'readWorkAnswer', eventId: '$owner-event', requestId: input.requestId
    }))
  })

  it('keeps the original assistant when the account primary changes', async () => {
    const port = { ...fixture(), primary: () => 'different-assistant' }
    const modelSelection = { instanceId: 'claude', model: 'override' }
    expect(await submitWorkLearning({ ...input, threadId: bound, modelSelection }, port))
      .toEqual({ status: 'started', threadId: bound })
    expect(port.agent).toHaveBeenCalledWith(agent)
    expect(port.command).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'sendWorkQuestion', learning: { server: 'work-aabbccdd', followup: true, model: modelSelection }
    }))
  })

  it('continues both drafts and bound threads locally when the relay loses reach', async () => {
    const port = { ...fixture(), server: () => undefined }
    expect(await submitWorkLearning(input, port)).toEqual({ status: 'standalone' })
    expect(await submitWorkLearning({ ...input, threadId: bound }, port)).toEqual({ status: 'standalone' })
    expect(port.command).not.toHaveBeenCalled()
  })

  it('uses the native local turn after the assistant explicitly declines its attachment', async () => {
    const port = fixture()
    port.command.mockResolvedValueOnce('!owner-dm:example.test')
      .mockResolvedValueOnce('$owner-event')
      .mockResolvedValueOnce({ learning: { status: 'standalone' } })
    expect(await submitWorkLearning({ ...input, threadId: bound }, port)).toEqual({ status: 'standalone' })
  })

  it('keeps the draft when Work reports an active run', async () => {
    const port = fixture()
    port.command.mockResolvedValueOnce('!owner-dm:example.test')
      .mockResolvedValueOnce('$owner-event')
      .mockResolvedValueOnce({ learning: { status: 'busy' } })
    expect(await submitWorkLearning({ ...input, threadId: bound }, port)).toEqual({ status: 'running' })
  })
})
