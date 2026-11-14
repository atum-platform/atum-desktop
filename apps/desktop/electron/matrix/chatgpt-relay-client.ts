import { randomUUID } from 'node:crypto'

import { readDomainJson } from './domain'
import type { MatrixProviderConnectionModel } from './provider-connections'

export const MATRIX_CHATGPT_RELAY_PROFILE = 'atum.chatgpt-relay/1' as const

export interface MatrixChatGptRelaySnapshot {
  revision: number
  state: 'disabled' | 'enabled' | 'carried'
  deviceServiceId?: string
  selectedAt?: number
  models: readonly MatrixProviderConnectionModel[]
}

type Action = 'status' | 'enable' | 'disable'
interface Answer { status: number; value: unknown }
interface Scope { accountKey: string; generation: number }
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u
const EFFORTS = ['low', 'medium', 'high'] as const

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function parse(value: unknown): MatrixChatGptRelaySnapshot | undefined {
  if (!record(value) || value.profile !== MATRIX_CHATGPT_RELAY_PROFILE ||
      !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 ||
      !['disabled', 'enabled'].includes(String(value.state)) || !Array.isArray(value.models) || value.models.length > 64) {
    return
  }
  const models: MatrixProviderConnectionModel[] = []
  for (const item of value.models) {
    if (!record(item) || typeof item.id !== 'string' || !MODEL.test(item.id) ||
        typeof item.displayName !== 'string' || item.displayName.length < 1 || item.displayName.length > 120 ||
        !Array.isArray(item.efforts) || item.efforts.length > 3 ||
        !item.efforts.every(effort => EFFORTS.includes(effort as typeof EFFORTS[number])) ||
        !EFFORTS.includes(item.defaultEffort as typeof EFFORTS[number]) ||
        !Number.isSafeInteger(item.contextBudget) || Number(item.contextBudget) < 1 ||
        !Number.isSafeInteger(item.outputBudget) || Number(item.outputBudget) < 1) {
      return
    }
    models.push({ id: item.id, displayName: item.displayName,
      efforts: item.efforts as Array<typeof EFFORTS[number]>, defaultEffort: item.defaultEffort as typeof EFFORTS[number],
      contextBudget: Number(item.contextBudget), outputBudget: Number(item.outputBudget) })
  }
  if (value.state === 'enabled') {
    if (typeof value.deviceServiceId !== 'string' || !UUID.test(value.deviceServiceId) ||
        !Number.isSafeInteger(value.selectedAt) || models.length < 1) {
      return
    }
    return { revision: Number(value.revision), state: 'enabled', deviceServiceId: value.deviceServiceId,
      selectedAt: Number(value.selectedAt), models }
  }
  if (Object.keys(value).some(key => !['profile', 'revision', 'state', 'models'].includes(key)) || models.length) {
    return
  }
  return { revision: Number(value.revision), state: 'disabled', models: [] }
}

export async function requestMatrixChatGptRelay(resource: string, accessToken: string, action: Action,
  signal: AbortSignal, body?: unknown): Promise<Answer> {
  const route = action === 'status' ? 'chatgpt-relay' : `chatgpt-relay/${action}`
  const response = await fetch(`${resource}/${route}`, { method: action === 'status' ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json',
      ...(action === 'status' ? {} : { 'Content-Type': 'application/json' }) },
    ...(action === 'status' ? {} : { body: JSON.stringify(body) }), cache: 'no-store', credentials: 'omit',
    redirect: 'error', signal })
  // Let account.s1Request refresh the domain bearer once; other failures remain connectivity failures.
  if (response.status === 401) {
    await response.body?.cancel()
    throw new Error('matrix_s1_authentication')
  }
  if (!response.headers.get('content-type')?.startsWith('application/json')) {
    await response.body?.cancel(); return { status: response.status, value: null }
  }
  try { return { status: response.status, value: await readDomainJson(response, 256 * 1024) } }
  catch { return { status: response.status, value: null } }
}

export class MatrixChatGptRelay {
  private owner: Scope | null = null
  private snapshot?: MatrixChatGptRelaySnapshot
  private carried = false

  constructor(private readonly options: { scope(): Scope | null; call(action: Action, signal: AbortSignal, body?: unknown): Promise<Answer>; changed(): void }) {}

  activate(owner: Scope | null): void {
    if (owner?.accountKey === this.owner?.accountKey && owner?.generation === this.owner?.generation) {
      return
    }
    this.owner = owner; this.snapshot = undefined; this.carried = false
  }

  markCarried(): void {
    this.carried = true
    this.snapshot = { revision: this.snapshot?.revision ?? 0, state: 'carried', models: [] }
    this.options.changed()
  }

  view() { return this.snapshot }

  async refresh(): Promise<MatrixChatGptRelaySnapshot | undefined> {
    const scope = this.options.scope()
    if (this.carried) return this.snapshot
    if (!scope) {
      return
    }
    const answer = await this.options.call('status', AbortSignal.timeout(20_000)).catch(() => undefined)
    if (this.carried) return this.snapshot
    const next = answer?.status === 200 ? parse(answer.value) : undefined
    if (!next || scope.accountKey !== this.options.scope()?.accountKey || scope.generation !== this.options.scope()?.generation) {
      return
    }
    this.snapshot = next; this.options.changed(); return next
  }

  async enable(deviceServiceId: string, models: readonly MatrixProviderConnectionModel[]): Promise<boolean> {
    if (this.carried || !this.options.scope() || !UUID.test(deviceServiceId) || models.length < 1) {
      return false
    }
    const answer = await this.options.call('enable', AbortSignal.timeout(20_000), {
      profile: MATRIX_CHATGPT_RELAY_PROFILE, requestId: randomUUID(), deviceServiceId, models
    })
    const next = answer.status === 200 ? parse(answer.value) : undefined
    if (!next || next.state !== 'enabled' || next.deviceServiceId !== deviceServiceId) {
      return false
    }
    this.snapshot = next; this.options.changed(); return true
  }

  async disable(): Promise<boolean> {
    const current = this.snapshot ?? await this.refresh()
    if (!current || current.state !== 'enabled') {
      return true
    }
    const answer = await this.options.call('disable', AbortSignal.timeout(20_000), {
      profile: MATRIX_CHATGPT_RELAY_PROFILE, requestId: randomUUID(), expectedRevision: current.revision
    })
    const next = answer.status === 200 ? parse(answer.value) : undefined
    if (!next || next.state !== 'disabled') {
      return false
    }
    this.snapshot = next; this.options.changed(); return true
  }
}
