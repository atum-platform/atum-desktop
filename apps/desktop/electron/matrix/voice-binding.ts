import type { MatrixEnrollment } from '../../shared/matrix'

import type { MatrixAgentRuntime } from './agent-runtime'
import type { MatrixHermesConnection, MatrixHermesRuntimeConfig } from './hermes-runtime'
import { matrixVoiceAudioPermission, MatrixVoiceScope } from './voice'

export function matrixVoiceFramePermission(input: {
  trustedContents: boolean
  currentConsent: boolean
  permission: string
  uiUrl: string
  details: { isMainFrame?: boolean; requestingUrl?: string; mediaTypes?: unknown; mediaType?: unknown }
}) {
  return (
    input.trustedContents &&
    input.currentConsent &&
    input.details.isMainFrame === true &&
    input.details.requestingUrl === input.uiUrl &&
    matrixVoiceAudioPermission(input.permission, input.details)
  )
}

export interface MatrixVoiceSource {
  authority(): string
  roomId(): string | undefined
  runtime(): MatrixHermesRuntimeConfig | undefined
  agent(roomId: string): MatrixAgentRuntime | undefined
  enrollment(agent: MatrixAgentRuntime): MatrixEnrollment
  blocked(agent: MatrixAgentRuntime): boolean
  verifyRoom(roomId: string, agent: MatrixAgentRuntime): Promise<void>
  connect(agent: MatrixAgentRuntime): Promise<MatrixHermesConnection | undefined>
  connection(agent: MatrixAgentRuntime): MatrixHermesConnection | undefined
}

/** The current private assistant room selects an existing native-owned Hermes
 * home. Neither a renderer URL nor a profile name can select another backend. */
export async function bindMatrixVoice(source: MatrixVoiceSource, roomId: unknown) {
  const authority = source.authority()
  const runtime = source.runtime()
  const agent = typeof roomId === 'string' && source.roomId() === roomId ? source.agent(roomId) : undefined
  const initial = agent && source.enrollment(agent)
  const identity = initial?.identity
  const denied = () => new Error('matrix_voice_unavailable')
  let boundConnection: MatrixHermesConnection | undefined

  if (!authority || !runtime || !agent || source.blocked(agent) || initial?.state !== 'ready' || !identity) {
    throw denied()
  }

  const isCurrent = () => {
    if (
      source.authority() !== authority ||
      source.runtime() !== runtime ||
      source.roomId() !== roomId ||
      source.agent(roomId as string) !== agent ||
      source.blocked(agent) ||
      (boundConnection !== undefined && source.connection(agent) !== boundConnection)
    ) {
      return false
    }

    const current = source.enrollment(agent)

    return (
      current.state === 'ready' &&
      Boolean(
        current.identity &&
        ['issuer', 'subject', 'principal', 'agentPrincipal', 'executorId', 'userId', 'deviceId'].every(
          field => current.identity![field as keyof typeof identity] === identity[field as keyof typeof identity]
        )
      )
    )
  }

  await source.verifyRoom(roomId as string, agent)

  if (!isCurrent()) {
    throw denied()
  }

  return {
    isCurrent,
    scope: new MatrixVoiceScope({
      isCurrent,
      forward: async request => {
        if (!isCurrent()) {
          throw denied()
        }

        const connection = boundConnection ?? (await source.connect(agent))

        if (!isCurrent() || !connection?.pages || source.connection(agent) !== connection) {
          throw denied()
        }

        boundConnection = connection

        const result = await connection.pages(request)

        if (!isCurrent() || source.connection(agent) !== connection) {
          throw denied()
        }

        return result
      }
    })
  }
}
