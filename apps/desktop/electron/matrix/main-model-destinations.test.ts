import { describe, expect, it, vi } from 'vitest'

import { handleMatrixModelDestinationsRequest } from './main-model-destinations'
import type { MatrixModelDestinations } from './model-destinations'

const AGENT = '00000000-0000-4000-8000-bd7662a5eeb4'
const FOREIGN = '00000000-0000-4000-8000-b454f82c5857'
const CLOSED = '00000000-0000-4000-8000-f6222a1106ee'

function fixture() {
  const destinations = {
    read: vi.fn(async () => undefined),
    write: vi.fn(async () => true),
    writeSubscription: vi.fn(async () => true),
    cap: vi.fn(async () => true)
  } as unknown as MatrixModelDestinations

  // A closed agent is still in the roster but no longer open: main's gate must refuse it too.
  const agents = [
    { principal: AGENT, closed: false },
    { principal: CLOSED, closed: true }
  ]

  return {
    destinations,
    context: {
      destinations,
      closing: false,
      signedIn: true,
      open: (principal: string) => agents.some(agent => !agent.closed && agent.principal === principal)
    }
  }
}

describe('the model destinations IPC authority', () => {
  it('refuses a cap request for a foreign or closed agent exactly as read and write do', async () => {
    const { context, destinations } = fixture()

    const requests = [
      { action: 'read' },
      { action: 'write', destination: 'cloud', model: 'nguyet-thuc' },
      { action: 'writeSubscription', model: 'glm-5.2', effort: 'high' },
      { action: 'cap', dailyProtons: 250_000 }
    ] as const

    for (const principal of [FOREIGN, CLOSED]) {
      for (const request of requests) {
        await expect(
          handleMatrixModelDestinationsRequest({ ...request, agentPrincipal: principal }, context)
        ).rejects.toThrow('matrix_model_destinations_unavailable')
      }
    }

    expect(destinations.read).not.toHaveBeenCalled()
    expect(destinations.write).not.toHaveBeenCalled()
    expect(destinations.writeSubscription).not.toHaveBeenCalled()
    expect(destinations.cap).not.toHaveBeenCalled()
  })

  it('admits the open agent’s cap, so the refusal above is the principal and not the request shape', async () => {
    const { context, destinations } = fixture()

    await expect(
      handleMatrixModelDestinationsRequest({ action: 'cap', agentPrincipal: AGENT, dailyProtons: 250_000 }, context)
    ).resolves.toEqual({ status: 'saved' })
    expect(destinations.cap).toHaveBeenCalledWith(AGENT, 250_000)
  })

  it.each([
    ['opencode_go', 'glm-5.2'],
    ['chatgpt_plan', 'gpt-5.6-luna']
  ] as const)('admits the %s cloud subscription pick with its own model and effort', async (source, model) => {
    const { context, destinations } = fixture()
    const cloudChoiceSaved = vi.fn()

    await expect(
      handleMatrixModelDestinationsRequest(
        { action: 'writeSubscription', agentPrincipal: AGENT, source, model, effort: 'high' },
        { ...context, cloudChoiceSaved }
      )
    ).resolves.toEqual({ status: 'saved' })
    expect(destinations.writeSubscription).toHaveBeenCalledWith(AGENT, source, model, 'high')
    expect(cloudChoiceSaved).toHaveBeenCalledWith(AGENT)
  })

  it('refuses a malformed subscription model or effort before calling the platform', async () => {
    const { context, destinations } = fixture()

    for (const request of [
      { action: 'writeSubscription', source: 'opencode_go', model: 'glm 5.2', effort: 'high' },
      { action: 'writeSubscription', source: 'opencode_go', model: 'glm-5.2', effort: 'max' },
      { action: 'writeSubscription', model: 'glm-5.2' }
    ] as const) {
      await expect(
        handleMatrixModelDestinationsRequest({ ...request, agentPrincipal: AGENT }, context)
      ).rejects.toThrow('matrix_command_invalid')
    }

    expect(destinations.writeSubscription).not.toHaveBeenCalled()
  })
})
