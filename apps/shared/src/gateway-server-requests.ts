/** Translate native Hermes peer requests at the retained Atum event/UI boundary.
 * The native request owns settlement/cancellation; no second waiter or approval policy lives here.
 */
import type { GatewayEvent } from './gateway-events'
import type { ServerRequest } from './json-rpc-channel'

interface PeerRequest {
  request: ServerRequest
  method: string
  params: Record<string, unknown>
  alias: string
  answers: Record<string, string | null>
  questions: Array<{ qid: string; question: string; choices?: string[]; multi_select?: boolean }>
}

const METHODS = new Set(['approval', 'clarify', 'sudo', 'secret', 'atum.apps.list', 'atum.apps.open',
  'atum.store', 'atum.agents', 'atum.agent_tasks', 'atum.routines', 'atum.chats', 'atum.mac',
  'atum.workspace.fetch', 'atum.advisory.search', 'atum.awareness.retrieve', 'atum.device',
  'word.document', 'cron.delivery.request', 'heartbeat.gate.request', 'heartbeat.off.request'])

export class GatewayServerRequests {
  private readonly emit: (event: GatewayEvent) => void
  private readonly requests = new Map<string, PeerRequest>()
  private readonly aliases = new Map<string, PeerRequest>()

  constructor(emit: (event: GatewayEvent) => void) {
    this.emit = emit
  }

  clear(): void { this.requests.clear(); this.aliases.clear() }

  receive(incoming: ServerRequest): boolean {
    const { id, method, params } = incoming

    if (this.requests.has(id)) {return true}

    if (!METHODS.has(method)) {
      return false
    }

    const request: PeerRequest = { request: incoming, method, params,
      alias: String(id),
      answers: params.answers && typeof params.answers === 'object' ? { ...params.answers as Record<string, string | null> } : {},
      questions: method === 'clarify' && Array.isArray(params.questions) ? params.questions : [] }

    this.requests.set(id, request)
    this.publish(request)

    return true
  }

  private publish(request: PeerRequest): void {
    const question = request.questions.find(item => !(item.qid in request.answers))

    if (request.method === 'clarify' && !question) {
      this.finish(request, { answers: request.answers, outcome: 'submitted' })

      return
    }

    const alias = question ? `${request.alias}${request.questions.indexOf(question).toString(16)}` : request.alias
    this.aliases.set(alias, request)
    this.emit({ type: request.method.endsWith('.request') ? request.method : `${request.method}.request`,
      session_id: typeof request.params.session_id === 'string' ? request.params.session_id : undefined,
      payload: { ...request.params, ...(question ?? {}), request_id: alias } } as GatewayEvent)
  }

  /** Resolve a retained *.respond call using a native response frame. Undefined means legacy server. */
  respond(method: string, params: Record<string, unknown>): Record<string, unknown> | undefined {
    const alias = typeof params.request_id === 'string' ? params.request_id : ''
    const request = this.aliases.get(alias)

    if (!request || method !== `${request.method.replace(/\.request$/, '')}.respond`) {
      // A cancelled/disconnected native prompt must never fall back to a legacy
      // RPC on a replacement account's connection, especially with a secret.
      if (alias.startsWith('srq-') && method.endsWith('.respond')) {throw new Error('server_request_stale')}

      return undefined
    }

    if (params.session_id !== undefined && params.session_id !== request.params.session_id) {
      throw new Error('server_request_session_mismatch')
    }

    this.aliases.delete(alias)

    if (request.method === 'approval') {
      this.finish(request, { choice: params.choice ?? 'deny', all: params.all === true })
    } else if (request.method === 'clarify') {
      const question = request.questions.find(item => !(item.qid in request.answers))

      if (question) {request.answers[question.qid] = typeof params.answer === 'string' ? params.answer : null}
      // The old UI clears its current card after the respond promise resolves.
      setTimeout(() => { if (this.requests.has(request.request.id)) {this.publish(request)} }, 0)
    } else {
      const value = params.password ?? params.value ?? params.answer ?? params.result ?? ''
      this.finish(request, { value: typeof value === 'string' ? value : JSON.stringify(value) })
    }

    return request.method === 'approval' ? { resolved: 1 } : { status: 'ok' }
  }

  cancel(id: unknown): void {
    const request = typeof id === 'string' ? this.requests.get(id) : undefined

    if (!request) {return}

    for (const [alias, item] of this.aliases) {
      if (item !== request) {continue}
      this.aliases.delete(alias)
      this.emit({ type: `${request.method.replace(/\.request$/, '')}.expire`,
        session_id: String(request.params.session_id ?? ''),
        payload: { request_id: alias } } as unknown as GatewayEvent)
    }

    this.requests.delete(request.request.id)
  }

  private finish(request: PeerRequest, result: Record<string, unknown>): void {
    this.requests.delete(request.request.id)

    for (const [alias, item] of this.aliases) {if (item === request) {this.aliases.delete(alias)}}
    request.request.respond(result)
  }
}
