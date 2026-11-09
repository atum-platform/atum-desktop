import {
  buildGroupRoutingRequest,
  type GroupRoutingInput,
  selectGroupRoutingAgents
} from '../../../shared/room-participation/relevance'

interface RoutingScope {
  accountKey: string
  generation: number
}

export interface GroupRouterOptions {
  gateway: string
  scope: () => RoutingScope | null
  bearer: (refresh: boolean) => Promise<string | null>
  fetch?: typeof fetch
}

/** Native-only transport. Hermes and renderer callers never receive provider credentials. */
export class GroupRelevanceRouter {
  private decisions = new Map<string, { at: number; value: Promise<readonly string[]> }>()

  constructor(private readonly options: GroupRouterOptions) {}

  decide(target: {
    roomId: string
    eventId: string
    candidateIds: readonly string[]
    load: (signal: AbortSignal) => Promise<GroupRoutingInput>
    signal?: AbortSignal
  }): Promise<readonly string[]> {
    const owner = this.options.scope()

    if (!owner) {
      return Promise.reject(new Error('matrix_group_routing_account_changed'))
    }
    const ids = [...target.candidateIds].sort()
    const key = JSON.stringify([owner.accountKey, owner.generation, target.roomId, target.eventId, ids])
    const cached = this.decisions.get(key)

    if (cached) {
      return cached.value
    }

    for (const [id, decision] of this.decisions) {
      if (Date.now() - decision.at > 120_000 || this.decisions.size >= 256) {
        this.decisions.delete(id)
      }
    }

    const value = this.request(owner, target, ids).catch(error => {
      if (target.signal?.aborted) {
        throw target.signal.reason
      }

      if (
        error instanceof Error &&
        (error.message === 'matrix_agent_roster_unavailable' || /^matrix_group_routing_[a-z_]+$/.test(error.message))
      ) {
        throw error
      }

      throw new Error('matrix_group_routing_unavailable')
    })
    this.decisions.set(key, { at: Date.now(), value })
    // A lost response may leave a completed decision on the gateway. A later offer can
    // recover it through the same canonical key without causing another inference/charge.
    void value.catch(error => {
      const terminal =
        error instanceof Error &&
        [
          'matrix_group_routing_invalid',
          'matrix_group_routing_out_of_protons',
          'matrix_group_routing_too_large',
          'matrix_group_routing_account_changed',
          'matrix_group_routing_changed'
        ].includes(error.message)

      if (!terminal && this.decisions.get(key)?.value === value) {
        this.decisions.delete(key)
      }
    })

    return value
  }

  private async request(
    owner: RoutingScope,
    target: {
      roomId: string
      eventId: string
      load: (signal: AbortSignal) => Promise<GroupRoutingInput>
      signal?: AbortSignal
    },
    candidateIds: string[]
  ): Promise<readonly string[]> {
    const timeout = AbortSignal.timeout(25_000)
    const signal = target.signal ? AbortSignal.any([target.signal, timeout]) : timeout

    const current = () => {
      signal.throwIfAborted()
      const scope = this.options.scope()

      if (scope?.accountKey !== owner.accountKey || scope.generation !== owner.generation) {
        throw new Error('matrix_group_routing_account_changed')
      }
    }

    current()
    const input = await target.load(signal)
    current()

    if (JSON.stringify(input.agents.map(agent => agent.userId).sort()) !== JSON.stringify(candidateIds)) {
      throw new Error('matrix_group_routing_changed')
    }

    const { state, questions } = buildGroupRoutingRequest(input)

    const body = JSON.stringify({
      roomId: target.roomId,
      eventId: target.eventId,
      candidateIds,
      version: 1,
      state,
      questions
    })

    if (Buffer.byteLength(body) > 65_536) {
      throw new Error('matrix_group_routing_too_large')
    }
    let refreshed = false
    let bearer = await this.options.bearer(false)
    current()

    while (true) {
      if (!bearer) {
        throw new Error('matrix_group_routing_sign_in_required')
      }
      current()

      const response = await (this.options.fetch ?? fetch)(`${this.options.gateway.replace(/\/$/, '')}/v1/systemone`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
        body,
        signal,
        redirect: 'error'
      })

      current()

      if (response.status === 401 && !refreshed) {
        await response.body?.cancel()
        bearer = await this.options.bearer(true)
        refreshed = true
        current()

        continue
      }

      if (response.status === 202) {
        await response.body?.cancel()
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            clearTimeout(timer)
            reject(signal.reason)
          }

          const timer = setTimeout(() => {
            signal.removeEventListener('abort', abort)
            resolve()
          }, 1_000)

          signal.addEventListener('abort', abort, { once: true })

          if (signal.aborted) {
            abort()
          }
        })
        current()

        continue
      }

      if (!response.ok) {
        await response.body?.cancel()
        const code =
          response.status === 402
            ? 'matrix_group_routing_out_of_protons'
            : response.status === 409
              ? 'matrix_group_routing_changed'
              : response.status === 413
                ? 'matrix_group_routing_too_large'
                : 'matrix_group_routing_unavailable'
        throw new Error(code)
      }

      const text = await response.text()
      current()

      if (Buffer.byteLength(text) > 65_536) {
        throw new Error('matrix_group_routing_invalid')
      }
      let result: unknown

      try {
        result = JSON.parse(text)
      } catch {
        throw new Error('matrix_group_routing_invalid')
      }

      return Object.freeze(selectGroupRoutingAgents(input, result))
    }
  }
}
