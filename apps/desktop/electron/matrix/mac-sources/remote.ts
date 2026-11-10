import { parseMacSourcesRequest, scanRequest } from '../../../../../packages/device-protocol/mac-sources'
import type { DeviceGrant } from '../device/contracts'

import { scanResult } from './scan'
import type { MacSourcesExecutionContext } from './service'

type Source = 'messages' | 'browser' | 'location'
export interface SourceAuthorityQuery {
  ownerPrincipal: string
  agentPrincipal: string
  gate: Source
  expectedRevision: number | null
}
export interface RemoteMacSourcesDependencies {
  /** Disabled until disclosure + X1 activation. No local preference can enable this. */
  enabled(): boolean
  allowed?(source: Source): boolean
  /** Account generation included; captured around every await. */
  scope(): string | null
  ownerPrincipal(grant: DeviceGrant): string | null
  /** Trusted adapter to 0427; never place a service-role credential in desktop. */
  authority(query: SourceAuthorityQuery, signal: AbortSignal): Promise<unknown>
  request(payload: unknown, context: MacSourcesExecutionContext, signal: AbortSignal): Promise<string>
}

export function grantSourcePosture(grant: DeviceGrant): MacSourcesExecutionContext {
  const background = grant.occurrenceId !== undefined || grant.originKind === 'schedule'

  // A device origin was matched against this Mac's own assertion log during grant admission.
  return { background, mayPrompt: !background && grant.originKind === 'device' }
}

function authorityRevision(value: unknown, query: SourceAuthorityQuery): number | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {return null}
  const row = value as Record<string, unknown>

  return Object.keys(row).sort().join(',') === 'agentPrincipal,allowed,gate,ownerPrincipal,profile,revision' &&
    row.profile === 'atum.agent-source-authority/1' && row.ownerPrincipal === query.ownerPrincipal &&
    row.agentPrincipal === query.agentPrincipal && row.gate === query.gate && row.allowed === true &&
    Number.isSafeInteger(row.revision) && Number(row.revision) >= 0 &&
    (query.expectedRevision === null || row.revision === query.expectedRevision) ? Number(row.revision) : null
}

export class RemoteMacSourcesService {
  constructor(private readonly deps: RemoteMacSourcesDependencies) {}
  async request(args: Record<string, unknown>, grant: DeviceGrant, signal: AbortSignal): Promise<string> {
    const denied = JSON.stringify({ error: 'disabled' })
    const scope = this.deps.scope()
    const current = () => !signal.aborted && this.deps.enabled() && scope !== null && this.deps.scope() === scope

    if (!current()) {return denied}
    const posture = grantSourcePosture(grant)
    const scan = args.mode === 'scan'

    if (scan && (grant.occurrenceId === undefined || !posture.background)) {return denied}

    if (!scan && args.mode !== 'read') {return denied}
    let payload = scan ? scanRequest(args.operationRef) : args.request
    const parsed = parseMacSourcesRequest(payload)

    if (!parsed || (posture.background && parsed.op === 'messages.read')) {return denied}

    if (parsed.op === 'location.current') {payload = { op: 'location.current', precision: 'city' }}
    const gate: Source = parsed.op.startsWith('messages.') ? 'messages' : parsed.op === 'browser.history' ? 'browser' : 'location'
    const locallyAllowed = () => this.deps.allowed?.(gate) !== false

    if (!locallyAllowed()) {return denied}
    const ownerPrincipal = this.deps.ownerPrincipal(grant)

    if (!ownerPrincipal) {return denied}
    const query: SourceAuthorityQuery = { ownerPrincipal, agentPrincipal: grant.agentPrincipal, gate, expectedRevision: null }

    try {
      const revision = authorityRevision(await this.deps.authority(query, signal), query)

      if (revision === null || !current() || !locallyAllowed()) {return denied}
      const output = await this.deps.request(payload, posture, signal)

      if (!current() || !locallyAllowed()) {return denied}
      const release = { ...query, expectedRevision: revision }

      if (authorityRevision(await this.deps.authority(release, signal), release) === null || !current() || !locallyAllowed()) {return denied}
      const result = scan ? JSON.stringify(scanResult(grant.targetDeviceServiceId, JSON.parse(output), args.cursor)) : output

      return Buffer.byteLength(result, 'utf8') <= 96 * 1024 ? result : JSON.stringify({ error: 'unavailable' })
    } catch { return denied }
  }
}
