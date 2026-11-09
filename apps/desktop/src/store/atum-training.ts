// RETIRED legacy commerce (pre-Matrix app): its Proton sale is removed and the platform switched its wallet spending and rewards off on 2026-10-05; see atum-platform docs/archive/legacy-desktop-checkout.
import { translateNow } from '@/i18n'
import type { AtumTrainingTask } from '@/lib/atum-store-items'
import { Codecs, persistentAtom } from '@/lib/persisted'

import { $atumAccountScopeId } from './atum-messaging'
import { storeBridge } from './atum-store-catalog'
import { $activeGatewayProfile, $freshSessionRequest, $newChatProfile, normalizeProfileKey } from './profile'

export interface TrainingIntent {
  intentId: string
  accountId: string
  assistantId: string
  assistantIdentityId: string
  profileId: string
  skillId: string
  /** Filled before any remote binding, so failed reads/restarts keep the exact task target. */
  conversationId: string | null
  task: AtumTrainingTask | null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

function validIntent(value: unknown): TrainingIntent | null {
  if (!value || typeof value !== 'object') { return null }
  const row = value as TrainingIntent

  if (![row.intentId, row.accountId, row.assistantId, row.assistantIdentityId].every(id => typeof id === 'string' && UUID.test(id)) ||
      typeof row.profileId !== 'string' || !row.profileId || typeof row.skillId !== 'string' || !row.skillId ||
      (row.conversationId !== null && typeof row.conversationId !== 'string')) { return null }

  const task = row.task === null ? null : publicTask(row.task)

  if (row.task !== null && (!task || task.assistant_id !== row.assistantId ||
      task.assistant_identity_id !== row.assistantIdentityId || task.skill_id !== row.skillId ||
      task.conversation_id !== row.conversationId)) { return null }

  return { intentId: row.intentId, accountId: row.accountId, assistantId: row.assistantId,
    assistantIdentityId: row.assistantIdentityId, profileId: row.profileId, skillId: row.skillId,
    conversationId: row.conversationId, task }
}

function publicTask(value: unknown): AtumTrainingTask | null {
  if (!value || typeof value !== 'object') { return null }
  const row = value as AtumTrainingTask

  if (![row.task_id, row.assistant_id, row.assistant_identity_id].every(id => typeof id === 'string' && UUID.test(id)) ||
      typeof row.conversation_id !== 'string' || !row.conversation_id || typeof row.skill_id !== 'string' || !row.skill_id) { return null }

  return { task_id: row.task_id, assistant_id: row.assistant_id, assistant_identity_id: row.assistant_identity_id,
    conversation_id: row.conversation_id, skill_id: row.skill_id }
}

// The new draft is window-owned. Reloading this window keeps its intent; a
// second window cannot accidentally apply it to a different conversation.
let windowKey: string = crypto.randomUUID()

try {
  windowKey = window.sessionStorage.getItem('atum.training.window') || crypto.randomUUID()
  window.sessionStorage.setItem('atum.training.window', windowKey)
} catch { /* Storage restrictions leave only this renderer's memory available. */ }

export const $atumTrainingIntent = persistentAtom<TrainingIntent | null>(
  `atum.desktop.trainingIntent.v1.${windowKey}`, null, Codecs.json(validIntent)
)

$atumAccountScopeId.listen(accountId => {
  const intent = $atumTrainingIntent.get()

  if (intent && intent.accountId !== accountId) { $atumTrainingIntent.set(null) }
})
$freshSessionRequest.listen(() => $atumTrainingIntent.set(null))
$newChatProfile.listen(profile => {
  const intent = $atumTrainingIntent.get()

  if (intent && normalizeProfileKey(profile ?? $activeGatewayProfile.get()) !== intent.profileId) {
    $atumTrainingIntent.set(null)
  }
})

export function prepareAtumTraining(intent: Omit<TrainingIntent, 'intentId' | 'conversationId' | 'task'>): void {
  if ($atumAccountScopeId.get() !== intent.accountId) { throw new Error('training_account_changed') }
  $atumTrainingIntent.set({ ...intent, intentId: crypto.randomUUID(), conversationId: null, task: null })
}

export function trainingIntentForSubmit(storedSessionId: string | null): TrainingIntent | null {
  const intent = $atumTrainingIntent.get()

  if (!intent || intent.accountId !== $atumAccountScopeId.get()) { return null }

  if (intent.conversationId && intent.conversationId !== storedSessionId) { return null }

  if (!intent.conversationId && storedSessionId) { return null }

  return intent
}

interface TrainingCapabilities { agent_id: string; conversation_id: string }
type GatewayRequest = <T>(method: string, params: Record<string, unknown>) => Promise<T>

/** No task is sent until its server-owned revision binding and local identity agree. */
export async function bindAtumTraining(intent: TrainingIntent, sessionId: string, request: GatewayRequest): Promise<void> {
  const current = () => $atumAccountScopeId.get() === intent.accountId && $atumTrainingIntent.get()?.intentId === intent.intentId

  if (!current()) { throw new Error(translateNow('atum.managedModel.trainingCancelled')) }
  const caps = await request<TrainingCapabilities>('context.capabilities', { session_id: sessionId })

  if (!current() || caps.agent_id !== intent.assistantIdentityId || !caps.conversation_id ||
      (intent.conversationId !== null && intent.conversationId !== caps.conversation_id)) {
    throw new Error(translateNow('atum.managedModel.trainingChanged'))
  }

  const pinned = { ...intent, conversationId: caps.conversation_id }
  $atumTrainingIntent.set(pinned)
  const bridge = storeBridge()

  if (!bridge?.startTrainingTask) { throw new Error(translateNow('atum.managedModel.trainingUnavailable')) }
  const task = publicTask(pinned.task ?? await bridge.startTrainingTask(intent.assistantId, caps.conversation_id, intent.skillId, intent.accountId))

  if (!current() || !task || task.assistant_id !== intent.assistantId || task.assistant_identity_id !== caps.agent_id ||
      task.skill_id !== intent.skillId || task.conversation_id !== caps.conversation_id) {
    throw new Error(translateNow('atum.managedModel.trainingUnverified'))
  }

  $atumTrainingIntent.set({ ...pinned, task })
  const bound = publicTask(await request('training.bind', { session_id: sessionId, task }))

  if (!bound || JSON.stringify(bound) !== JSON.stringify(task)) { throw new Error(translateNow('atum.managedModel.trainingUnverified')) }

  if (!current()) { throw new Error(translateNow('atum.managedModel.trainingCancelled')) }
}

export function completeAtumTrainingSubmit(intent: TrainingIntent): void {
  const current = $atumTrainingIntent.get()

  if (current?.intentId === intent.intentId) { $atumTrainingIntent.set(null) }
}
