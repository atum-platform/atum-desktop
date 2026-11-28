import { setTimeout } from 'node:timers/promises'

import { z } from 'zod'

import { workLearningSessionId, workLearningThread } from '../../../shared/work-question'

import type { OwnerSdkHost } from './matrix'

type LearningResult =
  | { status: 'started'; threadId: string }
  | { status: 'standalone' | 'unavailable' | 'running' }

const modelSelectionSchema = z.object({
  instanceId: z.string().trim().min(1).max(256),
  model: z.string().trim().min(1).max(256),
  options: z.array(z.object({
    id: z.string().trim().min(1).max(128),
    value: z.union([z.string().trim().min(1).max(256), z.boolean()])
  })).max(24).optional()
})

function boundedText(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= limit
}

export async function submitWorkLearning(value: unknown, port: {
  owner(): OwnerSdkHost | undefined
  primary(): string | undefined
  agent(principal: string): Promise<string | null>
  server(): string | undefined
  document(value: unknown): string | undefined
  current(): boolean
}): Promise<LearningResult> {
  const standalone = { status: 'standalone' } as const
  const unavailable = { status: 'unavailable' } as const

  if (!port.current() || !value || typeof value !== 'object') {return unavailable}
  const { threadId, requestId, text, modelSelection, document } = value as Record<string, unknown>
  const model = modelSelectionSchema.safeParse(modelSelection)

  if (typeof threadId !== 'string' || typeof requestId !== 'string' ||
      !workLearningSessionId.test(requestId) || !model.success ||
      typeof text !== 'string') {return unavailable}

  const bound = workLearningThread(threadId)

  if (!bound && !workLearningSessionId.test(threadId)) {return unavailable}
  const principal = bound?.agent ?? port.primary()
  const server = port.server()
  const owner = port.owner()

  if (!principal || !server || !owner) {return standalone}

  if (!workLearningSessionId.test(principal) || !boundedText(text, 24_000) ||
      Buffer.byteLength(text) > 24_000) {return unavailable}

  const agent = await port.agent(principal).catch(() => null)

  if (!port.current()) {return unavailable}

  if (!agent) {return standalone}

  const room = await owner.command({ kind: 'findAssistantRoom', ownerId: owner.userId, agentId: agent })
    .catch(() => undefined)

  if (!port.current()) {return unavailable}

  if (typeof room !== 'string') {return standalone}

  const path = document === undefined ? undefined : port.document(document)

  if (document !== undefined && !path) {return unavailable}
  const session = bound?.session ?? threadId
  const target = `work-learning-${principal}-${session}`

  const { options, ...selection } = model.data


  const relayModel = { ...selection,
    ...(options ? { options: options.map(({ id, value }) => ({ id, value })) } : {}) }


  const fallback = bound ? standalone : unavailable
  const deadline = Date.now() + 45_000


  const waitForReceipt = async (): Promise<LearningResult> => {
    const event = await owner.command({
      kind: 'sendWorkQuestion', roomId: room, agentId: agent, question: text, requestId,
      threadId: session, transactionId: `atum-work-learning-${requestId}`,
      learning: { server, followup: Boolean(bound), model: relayModel,
        ...(path ? { document: path } : {}) }
    }).catch(() => undefined)

    if (typeof event !== 'string' || !event.startsWith('$')) {return fallback}

    while (port.current() && Date.now() < deadline) {
      const answer = await owner.command({
        kind: 'readWorkAnswer', roomId: room, agentId: agent, eventId: event, requestId
      }).catch(() => undefined) as { learning?: { threadId?: unknown; runId?: unknown; status?: unknown } } | undefined

      if (!port.current()) {return unavailable}

      if (answer?.learning?.threadId === target && boundedText(answer.learning.runId, 255)) {
        return { status: 'started', threadId: target }
      }

      if (answer?.learning?.status === 'standalone') {return standalone}

      if (answer?.learning?.status === 'busy') {return { status: 'running' }}

      if (answer?.learning?.status === 'unavailable') {return fallback}
      await setTimeout(500)
    }

    return fallback
  }

  const timeout = new AbortController()

  try {
    const result = await Promise.race([
      waitForReceipt(),
      setTimeout(45_000, fallback, { signal: timeout.signal })
    ])

    return port.current() ? result : unavailable
  } finally {
    timeout.abort()
  }
}
