// RETIRED legacy commerce (pre-Matrix app): its Proton sale is removed and the platform switched its wallet spending and rewards off on 2026-10-05; see atum-platform docs/archive/legacy-desktop-checkout.
import { translateNow } from '@/i18n'
import { $atumHiring, refreshAtumHiring } from '@/store/atum-hiring'
import { $atumAccountScopeId } from '@/store/atum-messaging'
import { storeBridge } from '@/store/atum-store-catalog'

import { type AtumExecutionTask, parseExecutionTask } from '../../../shared/atum-hiring'

import { $atumAgents } from './agents'
import { $atumAssistantDirectory, captureAtumAssistantDirectoryScope, isAtumAssistantDirectoryScopeCurrent, refreshAtumAssistantDirectory } from './assistant-directory'

/** Hired offerings always start on managed execution; custom profiles retain
 * their selected provider. The account-bound roster supplies the local mapping.
 */
export async function isAtumHiredProfile(profileId: string): Promise<boolean> {
  if (!$atumAccountScopeId.get()) { return false }

  // The roster is advisory for provider selection. An outage must not prevent
  // unrelated local/BYOK chats; retained known hires still use managed execution.
  // Private instructions and paid authority are checked by the server at send.
  if ($atumHiring.get().state !== 'ready') { await refreshAtumHiring().catch(() => null) }
  const agent = $atumAgents.get().find(row => row.id === profileId || row.localProfileId === profileId)

  const hiring = $atumHiring.get()

  return Boolean(hiring.accountId === $atumAccountScopeId.get() && agent?.hostedId && hiring.hires.some(hire => hire.assistant_id === agent.hostedId))
}

type GatewayRequest = <T>(method: string, params: Record<string, unknown>) => Promise<T>
interface BindingStatus { managed: boolean; can_bind: boolean; agent_id: string; conversation_id: string; task: AtumExecutionTask | null }

/** Follow the actual session's identity, including background queued submits.
 * Resumed tasks already carry their public pin; new tasks bind before inference.
 */
export async function bindAtumHiredTask(sessionId: string, request: GatewayRequest): Promise<void> {
  const scope = captureAtumAssistantDirectoryScope()

  if (!scope.accountId) { return }

  const check = () => {
    if (!isAtumAssistantDirectoryScopeCurrent(scope)) { throw new Error(translateNow('atum.managedModel.trainingCancelled')) }
  }

  const status = await request<BindingStatus>('training.status', { session_id: sessionId })
  check()

  if (!status.managed || status.task || !status.can_bind) { return }
  let agent = $atumAgents.get().find(row => row.identityId === status.agent_id && row.hostedId)

  if (!agent) {
    await refreshAtumAssistantDirectory()
    check()
    agent = $atumAgents.get().find(row => row.identityId === status.agent_id && row.hostedId)
  }

  if (!agent?.hostedId) { return }
  const hiring = $atumHiring.get()
  const directory = $atumAssistantDirectory.get()

  // The server forbids hiring its default assistant. Trust that account-bound
  // identity, not the local profile flag or a failed/missing hiring endpoint.
  // This also keeps first chat working against deployments predating hiring.
  if (directory.accountId === scope.accountId && directory.state === 'ready' &&
      directory.entries.some(row => row.id === agent.hostedId && row.identityId === status.agent_id && row.isDefault && row.status === 'active') &&
      !hiring.hires.some(hire => hiring.accountId === scope.accountId && hire.assistant_id === agent.hostedId)) { return }

  // Ordinary managed profiles have no private employee source to bind. Unknown
  // rosters and known hires still consult hosted authority before inference.
  if (hiring.accountId === scope.accountId && hiring.state === 'ready' && !hiring.hires.some(hire => hire.assistant_id === agent.hostedId)) { return }
  const bridge = storeBridge()

  if (!bridge?.startAgentTask) { throw new Error(translateNow('atum.managedModel.trainingUnavailable')) }
  const raw = await bridge.startAgentTask(agent.hostedId, status.conversation_id, null, scope.accountId)
  check()

  if (!raw) { return }
  const task = parseExecutionTask(raw)

  if (task.assistant_id !== agent.hostedId || task.assistant_identity_id !== status.agent_id || task.conversation_id !== status.conversation_id) {
    throw new Error(translateNow('atum.managedModel.trainingUnverified'))
  }

  const bound = parseExecutionTask(await request('training.bind', { session_id: sessionId, task }))
  check()

  if (JSON.stringify(bound) !== JSON.stringify(task)) { throw new Error(translateNow('atum.managedModel.trainingUnverified')) }
}
