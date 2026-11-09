import { installPrivateAdvisoryRunner } from '@/app/dm/private-advisory-runner'
import { atumAccountClient } from '@/lib/atum-account-client'
import { parseAtumArtifactRefs } from '@/lib/atum-artifacts'
import { atumMessagingClient } from '@/lib/atum-messaging-client'
import { clearAtumDmWorkspace, presentAtumDmArtifactIntent, setAtumDmWorkspaceAccount } from '@/store/atum-dm-workspace'
import { configureAtumMessagingComposition } from '@/store/atum-messaging'
import { clearSessionPreviewRegistry } from '@/store/preview'

let installed = false

function presentArtifactIntents(conversationId: string, resourceRefs: unknown): void {
  for (const ref of parseAtumArtifactRefs(resourceRefs)) {
    if (ref.presentation?.intent === 'open') {
      presentAtumDmArtifactIntent(conversationId, ref)
    }
  }
}

/**
 * The one renderer composition point for S2 account custody, S5 direct
 * messaging, S6 specialist chat, and the legacy S4 DM workspace adapter.
 * Feature stores depend inward on injected ports; they do not import siblings.
 */
export function installAtumMessagingComposition(): void {
  if (installed) {
    return
  }

  installed = true
  installPrivateAdvisoryRunner()
  configureAtumMessagingComposition({
    account: atumAccountClient,
    clearDependentState: clearAtumDmWorkspace,
    clearPreviewState: clearSessionPreviewRegistry,
    ensureSpecialistConversation: specialist => atumMessagingClient().ensureSpecialistConversation(specialist),
    presentArtifactIntents,
    setDependentAccount: setAtumDmWorkspaceAccount
  })
}
