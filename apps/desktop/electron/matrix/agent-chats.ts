const AGENT = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu
const REQUEST_FIELDS = ['op', 'unreadOnly', 'sinceMs', 'limit', 'id', 'before', 'query'] as const
const REQUEST_BYTES = 4_096
const RESPONSE_BYTES = 24_576
const REQUEST_TIMEOUT_MS = 60_000

export interface MatrixAgentChatsBinding {
  accountKey: string
  generation: number
  agentPrincipal: string
  executorId: string
}

interface MatrixAgentChatsAccount {
  s1Request<T>(send: (accessToken: string, resource: string) => Promise<T>, signal: AbortSignal): Promise<T>
}

function sameBinding(left: MatrixAgentChatsBinding | null, right: MatrixAgentChatsBinding): boolean {
  return Boolean(
    left &&
      left.accountKey === right.accountKey &&
      left.generation === right.generation &&
      left.agentPrincipal === right.agentPrincipal &&
      left.executorId === right.executorId
  )
}

/** The gateway envelope also carries request_id and turn_id. Only the frozen
 * atum.agent-chats/1 body crosses the owner-token route; no tool argument can
 * name an owner, bearer, agent, executor, URL or other authority. */
function contractBody(payload: unknown): string {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('matrix_agent_chats_invalid')
  }

  const source = payload as Record<string, unknown>
  const body: Record<string, unknown> = {}

  for (const field of REQUEST_FIELDS) {
    if (Object.hasOwn(source, field)) {
      body[field] = source[field]
    }
  }

  let serialized: string

  try {
    serialized = JSON.stringify(body)
  } catch {
    throw new Error('matrix_agent_chats_invalid')
  }

  if (Buffer.byteLength(serialized, 'utf8') > REQUEST_BYTES) {
    throw new Error('matrix_agent_chats_invalid')
  }

  return serialized
}

async function boundedJsonText(response: Response): Promise<{ text: string; value: Record<string, unknown> }> {
  const reader = response.body?.getReader()

  if (!reader) {
    throw new Error('matrix_agent_chats_unavailable')
  }

  const chunks: Uint8Array[] = []
  let length = 0

  try {
    while (true) {
      const { done, value } = await reader.read()

      if (done) {
        break
      }

      length += value.byteLength

      if (length > RESPONSE_BYTES) {
        throw new Error('matrix_agent_chats_unavailable')
      }

      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }

  let text: string
  let value: unknown

  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
    value = JSON.parse(text)
  } catch {
    throw new Error('matrix_agent_chats_unavailable')
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('matrix_agent_chats_unavailable')
  }

  return { text, value: value as Record<string, unknown> }
}

/** One native POST to the platform's owner route. The response text remains the
 * platform's exact bounded JSON bytes so the Hermes tool validates the frozen
 * contract itself; this host neither reshapes chat content nor touches Matrix keys. */
export async function requestMatrixAgentChats(
  resource: string,
  accessToken: string,
  agentPrincipal: string,
  payload: unknown,
  signal: AbortSignal
): Promise<string> {
  signal.throwIfAborted()

  if (!AGENT.test(agentPrincipal)) {
    throw new Error('matrix_agent_chats_unavailable')
  }

  const body = contractBody(payload)
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)])
  let response: Response

  try {
    response = await fetch(`${resource}/chats`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'atum-agent': agentPrincipal
      },
      body,
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      signal: requestSignal
    })
  } catch {
    signal.throwIfAborted()
    throw new Error('matrix_agent_chats_unavailable')
  }

  if (response.status === 401) {
    await response.body?.cancel().catch(() => {})
    throw new Error('matrix_s1_authentication')
  }

  if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    await response.body?.cancel().catch(() => {})
    throw new Error('matrix_agent_chats_unavailable')
  }

  const answer = await boundedJsonText(response)
  signal.throwIfAborted()

  if (response.status === 200) {
    return answer.text
  }

  const expected = new Map<number, string>([
    [400, 'invalid'],
    [404, 'not_found'],
    [429, 'rate_limited'],
    [503, 'unavailable']
  ]).get(response.status)

  if (expected && Object.keys(answer.value).length === 1 && answer.value.error === expected) {
    return answer.text
  }

  throw new Error('matrix_agent_chats_unavailable')
}

/** Rechecks the exact account generation and enrolled agent/executor around the
 * owner-token await. A switched account or rotated host can never publish its
 * answer into the original Hermes session. */
export async function requestBoundMatrixAgentChats(input: {
  account: MatrixAgentChatsAccount
  binding: MatrixAgentChatsBinding
  current(): MatrixAgentChatsBinding | null
  payload: unknown
  signal: AbortSignal
}): Promise<string> {
  const live = () => {
    input.signal.throwIfAborted()

    if (!sameBinding(input.current(), input.binding)) {
      throw new Error('matrix_agent_chats_stale')
    }
  }

  live()

  const answer = await input.account.s1Request(
    (accessToken, resource) =>
      requestMatrixAgentChats(resource, accessToken, input.binding.agentPrincipal, input.payload, input.signal),
    input.signal
  )

  live()

  return answer
}
