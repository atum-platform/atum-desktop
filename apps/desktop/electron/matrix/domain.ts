import { AGENT_HOMES_CLOUD_ONLY } from '../../shared/agent-home-cloud-only'
import type { MatrixDomainIdentity } from '../../shared/matrix'

import type { NativeGrant } from './authorization'
import { currentIanaTimeZone, TIME_ZONE_REQUEST_HEADER } from './time-zone'

/** One named resource, no renderer-selected URL and no token-bearing redirects. */
export async function readDomainIdentity(resource: string, grant: NativeGrant): Promise<MatrixDomainIdentity | null> {
  const response = await fetch(`${resource}/me`, {
    headers: { Authorization: `Bearer ${grant.accessToken}` },
    redirect: 'error',
    signal: AbortSignal.timeout(10_000)
  })

  if (response.status === 401) {
    await response.body?.cancel()

    return null
  }

  if (!response.ok || !response.headers.get('content-type')?.startsWith('application/json')) {
    await response.body?.cancel()
    throw new Error('matrix_domain_unavailable')
  }

  const data = (await readDomainJson(response)) as Partial<MatrixDomainIdentity>

  if (
    data?.issuer !== grant.issuer ||
    data.subject !== grant.subject ||
    typeof data.principal !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data.principal)
  ) {
    throw new Error('matrix_domain_invalid')
  }

  return { issuer: data.issuer, subject: data.subject, principal: data.principal }
}

/**
 * The active Cloud disclosure's version, from the native domain base's `/cloud/disclosure`
 * (the same route the device service reads as `cloud-disclosure` in `device/cloud-agent.ts`).
 * Provisioning runs before that device service is ready, so this reads the route directly.
 * `undefined` when the read fails or answers outside the contract: sign-in then provisions
 * exactly as before and never blocks on consent discovery.
 */
export async function readCloudDisclosureVersion(
  resource: string,
  grant: NativeGrant,
  cloudOnly: boolean = AGENT_HOMES_CLOUD_ONLY
): Promise<number | undefined> {
  const first = await readCloudDisclosureVersionOnce(resource, grant)

  // Cloud-only S0: both callers create an assistant, and a body without the version is the
  // Mac-first provisioning. One blip on this small read must not quietly put a new assistant on a
  // Mac, so it is read once more before falling back.
  return first === undefined && cloudOnly ? readCloudDisclosureVersionOnce(resource, grant) : first
}

async function readCloudDisclosureVersionOnce(resource: string, grant: NativeGrant): Promise<number | undefined> {
  try {
    const response = await fetch(`${resource}/cloud/disclosure`, {
      headers: { Authorization: `Bearer ${grant.accessToken}` },
      redirect: 'error',
      signal: AbortSignal.timeout(5_000)
    })

    if (!response.ok || !response.headers.get('content-type')?.startsWith('application/json')) {
      await response.body?.cancel()

      return undefined
    }

    const data = (await readDomainJson(response, 2_048)) as { kind?: unknown; version?: unknown } | null

    return data?.kind === 'cloud' &&
      Number.isSafeInteger(data.version) &&
      (data.version as number) >= 1 &&
      (data.version as number) <= 2 ** 31 - 1
      ? (data.version as number)
      : undefined
  } catch {
    return undefined
  }
}

/**
 * First sign-in: the platform creates this person's default assistant account and
 * starter Protons if they are missing. It never takes an identity from the client
 * and every step is idempotent, so a failure is simply retried by the next setup.
 *
 * The body carries the Cloud disclosure version this build shows at sign-in (read from
 * `/cloud/disclosure`); `{}` keeps the Mac-first behaviour when that read is unavailable.
 * The request carries this Mac's current IANA zone through the same validated header as the
 * roster read, so the platform can seed the assistant before that later report; no valid zone
 * means no header.
 *
 * The production Shell that predates this build accepts only an exactly empty body and refuses
 * `{disclosureVersion}` with a 4xx. That refusal is not an error: the same request is retried
 * once with `{}`, which is today's Mac-first provisioning, so an old and a new Shell both work.
 */
export async function ensureDomainAssistant(
  resource: string,
  grant: NativeGrant
): Promise<{ agentPrincipal: string; matrixUser: string } | null> {
  const disclosureVersion = await readCloudDisclosureVersion(resource, grant)
  const timeZone = currentIanaTimeZone()

  const post = (body: string) =>
    fetch(`${resource}/assistant`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${grant.accessToken}`,
        'Content-Type': 'application/json',
        ...(timeZone ? { [TIME_ZONE_REQUEST_HEADER]: timeZone } : {})
      },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(20_000)
    })

  let response = await post(disclosureVersion === undefined ? '{}' : JSON.stringify({ disclosureVersion }))

  // The current production Shell rejects the versioned body (`400`/`422`) until it ships the
  // consent-aware route. Retry exactly once with the old empty body, which it still accepts.
  if (disclosureVersion !== undefined && (response.status === 400 || response.status === 422)) {
    await response.body?.cancel()
    response = await post('{}')
  }

  if (response.status === 401) {
    await response.body?.cancel()

    return null
  }

  if (!response.ok || !response.headers.get('content-type')?.startsWith('application/json')) {
    await response.body?.cancel()
    throw new Error('matrix_assistant_unavailable')
  }

  const data = (await readDomainJson(response)) as { agentPrincipal?: unknown; matrixUser?: unknown }

  if (
    typeof data?.agentPrincipal !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data.agentPrincipal) ||
    typeof data.matrixUser !== 'string' ||
    !/^@[^:]+:.+$/.test(data.matrixUser)
  ) {
    throw new Error('matrix_domain_invalid')
  }

  return { agentPrincipal: data.agentPrincipal, matrixUser: data.matrixUser }
}

/** Bounded response reader shared by the named domain operations. */
export async function readDomainJson(response: Response, maximum = 16_384): Promise<unknown> {
  const reader = response.body?.getReader()

  if (!reader) {
    throw new Error('matrix_domain_invalid')
  }

  let length = 0
  const chunks: Uint8Array[] = []

  try {
    while (true) {
      const { done, value } = await reader.read()

      if (done) {
        break
      }

      length += value.byteLength

      if (length > maximum) {
        throw new Error('matrix_domain_invalid')
      }

      chunks.push(value)
    }

    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } finally {
    await reader.cancel().catch(() => {})
  }
}
