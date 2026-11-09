import { atom } from 'nanostores'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const account = atom<string | null>(null)
const agents = atom<Array<{ id: string; identityId: string }>>([])
const groupCapabilities = vi.fn()
const listAssistants = vi.fn()
const claim = vi.fn()
const attach = vi.fn()
const onJob = vi.fn()
const onCancel = vi.fn()
const openGatewayForProfile = vi.fn()
const gatewayForProfile = vi.fn()
const refreshProfiles = vi.fn()

vi.mock('@/lib/atum-messaging-client', () => ({
  atumMessagingClient: () => ({ groupCapabilities, listAssistants })
}))
vi.mock('@/store/atum-messaging', () => ({ $atumAccountScopeId: account }))
vi.mock('@/app/atum/agents', () => ({ $atumAgents: agents }))
vi.mock('@/store/gateway', () => ({ gatewayForProfile, openGatewayForProfile }))
vi.mock('@/store/profile', () => ({ refreshProfiles }))

const bridge = {
  claim,
  attach,
  running: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
  cancelConversation: vi.fn(),
  onJob,
  onCancel
}

const advisoryJob = {
  job_id: '00000000-0000-4000-8000-b454f82c5857',
  runtime_session_id: 'runtime-stale',
  durable_session_id: 'stored-live',
  account_id: '00000000-0000-4000-8000-bd7662a5eeb4',
  request: {
    job_id: '00000000-0000-4000-8000-b454f82c5857',
    conversation_id: '00000000-0000-4000-8000-f6222a1106ee',
    source_message_id: '00000000-0000-4000-8000-a9703d75e616',
    target: { type: 'assistant' as const, id: '00000000-0000-4000-8000-f1d11edf5c5c' },
    context: {
      mode: 'private_advisory' as const,
      conversation_id: '00000000-0000-4000-8000-f6222a1106ee',
      audience_revision: 1,
      advisor: { kind: 'assistant' as const, id: '00000000-0000-4000-8000-f1d11edf5c5c' },
      context_revision: 1,
      invalidations: [],
      messages: [],
      watermark: { sequence: 1, message_id: '00000000-0000-4000-8000-a9703d75e616' }
    }
  }
}

beforeEach(() => vi.resetModules())

afterEach(() => {
  vi.useRealTimers()
  account.set(null)
  agents.set([])

  for (const mock of [groupCapabilities, listAssistants, claim, attach, onJob, onCancel, openGatewayForProfile, gatewayForProfile, refreshProfiles]) {
    mock.mockReset()
  }

  for (const mock of [bridge.running, bridge.complete, bridge.fail]) {mock.mockReset()}
  window.dispatchEvent(new Event('pagehide'))
})

it.each([
  ['missing profile', 'advisory_owned_assistant_unavailable', true],
  ['lost session', 'advisory_session_recovery_unavailable', true],
  ['gateway unavailable', 'gateway_unavailable', true]
] as const)('keeps %s recoverable without forking a new model turn', async (failure, code, retryable) => {
  agents.set(failure === 'missing profile' ? [] : [{ id: 'marketing', identityId: 'identity-marketing' }])
  listAssistants.mockResolvedValue([{ id: advisoryJob.request.target.id, identityId: 'identity-marketing', status: 'active' }])
  refreshProfiles.mockResolvedValue(undefined)

  if (failure === 'gateway unavailable') { openGatewayForProfile.mockRejectedValue(new Error(code)) }
  else { openGatewayForProfile.mockResolvedValue(undefined) }

  const request = vi.fn().mockRejectedValue(new Error('session_not_found'))
  gatewayForProfile.mockReturnValue({ request, onEvent: vi.fn(() => () => undefined) })
  let dispatch: ((job: typeof advisoryJob) => void) | undefined
  onJob.mockImplementation(callback => { dispatch = callback })
  attach.mockResolvedValue({ attached: 0 })
  Object.assign(window, { hermesDesktop: { advisoryRunner: bridge } })
  const { installPrivateAdvisoryRunner } = await import('./private-advisory-runner')
  installPrivateAdvisoryRunner()
  dispatch?.(advisoryJob)
  await vi.waitFor(() => expect(bridge.fail).toHaveBeenCalledWith(advisoryJob.job_id, code, retryable))
  expect(bridge.fail).toHaveBeenCalledTimes(1)
  expect(request.mock.calls.some(([method]) => method === 'session.create' || method === 'prompt.submit')).toBe(false)
})

it.each(['acknowledged', 'lost acknowledgement', 'cancelled'] as const)('recovers a durable reply without a duplicate prompt when publication is %s', async publication => {
  vi.useFakeTimers()
  account.set('00000000-0000-4000-8000-bd7662a5eeb4')
  refreshProfiles.mockImplementation(async () => agents.set([{ id: 'andy', identityId: 'identity-andy' }]))
  groupCapabilities.mockResolvedValue({ advisory: { enabled: true } })
  listAssistants.mockResolvedValue([{ id: advisoryJob.request.target.id, identityId: 'identity-andy', status: 'active' }])
  claim.mockResolvedValue({ claimed: false, replayed: false, jobId: null })
  openGatewayForProfile.mockResolvedValue(undefined)

  const request = vi.fn(async (method: string, params: { session_id?: string }) => {
    if (method === 'session.resume' && params.session_id === 'runtime-stale') {throw new Error('stale_runtime')}

    if (method === 'session.resume' && params.session_id === 'stored-live') {
      return {
        session_id: 'runtime-recovered', stored_session_id: 'stored-live', running: false,
        messages: [{ role: 'assistant', text: 'recovered canonical answer' }]
      }
    }

    throw new Error(`unexpected ${method}`)
  })

  gatewayForProfile.mockReturnValue({ request, onEvent: vi.fn(() => () => undefined) })
  let onJobCallback: ((job: typeof advisoryJob) => void) | undefined
  onJob.mockImplementation(callback => {
    onJobCallback = callback

    return () => undefined
  })
  let cancel: ((event: { jobId: string }) => void) | undefined
  onCancel.mockImplementation(callback => {
    cancel = callback

    return () => undefined
  })
  attach.mockImplementation(async () => {
    expect(onJob).toHaveBeenCalledTimes(1)
    expect(onCancel).toHaveBeenCalledTimes(1)
    onJobCallback?.(advisoryJob)

    return { attached: 1 }
  })
  Object.assign(window, { hermesDesktop: { advisoryRunner: bridge } })

  const { $privateAdvisoryTasks, installPrivateAdvisoryRunner } = await import('./private-advisory-runner')
  bridge.complete.mockImplementation(async () => {
    expect($privateAdvisoryTasks.get()[advisoryJob.job_id]?.state).toBe('publishing')

    if (publication === 'cancelled') {
      cancel?.({ jobId: advisoryJob.job_id })
    }

    if (publication !== 'acknowledged') {
      throw new Error('publication_ack_unavailable')
    }
  })
  installPrivateAdvisoryRunner()
  await vi.advanceTimersByTimeAsync(0)
  await vi.waitFor(() => expect(bridge.complete).toHaveBeenCalledWith(advisoryJob.job_id, 'recovered canonical answer'))

  expect(attach).toHaveBeenCalledTimes(1)
  expect(refreshProfiles).toHaveBeenCalledTimes(1)
  expect(claim).toHaveBeenCalledTimes(1)
  expect(bridge.running).toHaveBeenCalledWith(advisoryJob.job_id, 'runtime-recovered', 'stored-live', 'andy')
  expect(request.mock.calls.map(call => call[0])).toEqual(['session.resume', 'session.resume'])
  expect(request).not.toHaveBeenCalledWith('prompt.submit', expect.anything(), expect.anything())
  expect($privateAdvisoryTasks.get()[advisoryJob.job_id]?.state).toBe(
    publication === 'acknowledged' ? 'completed' : publication === 'cancelled' ? 'cancelled' : 'publishing'
  )
  expect(bridge.fail).not.toHaveBeenCalled()
})

it('sends stop requests before cancelling the task releases its background gateway', async () => {
  vi.useFakeTimers()
  agents.set([{ id: 'marketing', identityId: 'identity-marketing' }])
  listAssistants.mockResolvedValue([{ id: advisoryJob.request.target.id, identityId: 'identity-marketing', status: 'active' }])

  const request = vi.fn(async (method: string) => {
    if (method === 'session.resume') {
      return { session_id: 'running-session', stored_session_id: 'stored-live', running: true, messages: [] }
    }

    return {}
  })

  gatewayForProfile.mockReturnValue({ request, onEvent: vi.fn(() => () => undefined) })
  let dispatch: ((job: typeof advisoryJob) => void) | undefined
  let cancel: ((event: { jobId: string }) => void) | undefined
  onJob.mockImplementation(callback => {dispatch = callback})
  onCancel.mockImplementation(callback => {cancel = callback})
  attach.mockResolvedValue({ attached: 0 })
  Object.assign(window, { hermesDesktop: { advisoryRunner: bridge } })

  const { $privateAdvisoryTasks, installPrivateAdvisoryRunner } = await import('./private-advisory-runner')
  installPrivateAdvisoryRunner()
  dispatch?.(advisoryJob)
  await vi.advanceTimersByTimeAsync(0)
  expect($privateAdvisoryTasks.get()[advisoryJob.job_id]?.state).toBe('running')

  const off = $privateAdvisoryTasks.listen(tasks => {
    if (tasks[advisoryJob.job_id]?.state === 'cancelled') {
      expect(request).toHaveBeenCalledWith('session.interrupt', { session_id: 'running-session' })
      expect(request).toHaveBeenCalledWith('session.close', { session_id: 'running-session' })
    }
  })

  cancel?.({ jobId: advisoryJob.job_id })
  expect($privateAdvisoryTasks.get()[advisoryJob.job_id]?.state).toBe('cancelled')
  off()
  await vi.advanceTimersByTimeAsync(0)
  expect(bridge.complete).not.toHaveBeenCalled()
})
