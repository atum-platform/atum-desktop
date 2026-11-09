// RETIRED legacy commerce (pre-Matrix app): its Proton sale is removed and the platform switched its wallet spending and rewards off on 2026-10-05; see atum-platform docs/archive/legacy-desktop-checkout.
import { createProfile, updateProfileSoul } from '@/hermes'
import { atumMessagingClient } from '@/lib/atum-messaging-client'
import { type AtumStoreItemWire, storeCopy } from '@/lib/atum-store-items'
import { $atumHireIntent, clearHireIntent, type HireIntent, readHireIntent, refreshAtumHiring, saveHireIntent } from '@/store/atum-hiring'
import { $atumAccountScopeId } from '@/store/atum-messaging'
import { refreshAtumStoreCatalog, storeBridge } from '@/store/atum-store-catalog'
import { refreshProfiles } from '@/store/profile'

import { $atumAgents, ATUM_AGENT_ID, ATUM_MANAGED_BY, talkToAtumAgent } from './agents'
import { captureAtumAssistantDirectoryScope, isAtumAssistantDirectoryScopeCurrent, recordAtumAssistantDirectoryEntry, refreshAtumAssistantDirectory } from './assistant-directory'
import { atumAssistantName } from './create-agent'
import { setupPortableAtumAgent, uploadPortableAtumAgent } from './portable-agent'

/** Confirming checkout creates one stable intent; retries always reuse it. */
function prepareAtumHire(item: AtumStoreItemWire, name: string, locale: string, assistantId: string | null = null): HireIntent {
  const accountId = $atumAccountScopeId.get()

  if (!accountId || item.kind !== 'agent' || item.source?.type !== 'cloud_agent' || item.offer?.billing_interval !== 'month') {
    throw new Error('offer_unavailable')
  }

  if (readHireIntent(accountId)) { throw new Error('hiring_pending') }

  const intent: HireIntent = { accountId, requestId: crypto.randomUUID(), profileId: `employee-${crypto.randomUUID()}`,
    assistantId, itemId: item.id, offerId: item.offer.id, offerVersion: item.offer.version, priceProtons: item.offer.price_protons,
    name: atumAssistantName(name || storeCopy(item.title, locale)), avatar: item.glyph }

  saveHireIntent(intent)

  return intent
}

// Web Locks serialize checkout across windows of this same desktop origin.
// The durable account intent survives renderer/app restarts and is re-read only
// after owning the lock. This is UI coordination; SQL remains payment authority.
export async function confirmAtumHire(item: AtumStoreItemWire, name: string, locale: string, assistantId: string | null = null): Promise<void> {
  const accountId = $atumAccountScopeId.get()

  if (!accountId || !navigator.locks) { throw new Error('hiring_storage_unavailable') }
  await navigator.locks.request(`atum-hiring:${accountId}`, async () => {
    if ($atumAccountScopeId.get() !== accountId) { throw new Error('hiring_account_changed') }
    prepareAtumHire(item, name, locale, assistantId)
    await finish()
  })
}

export async function completeAtumHire(consent = false): Promise<void> {
  const accountId = $atumAccountScopeId.get()

  if (!accountId || !navigator.locks) { throw new Error('hiring_storage_unavailable') }
  await navigator.locks.request(`atum-hiring:${accountId}`, async () => {
    if ($atumAccountScopeId.get() !== accountId) { throw new Error('hiring_account_changed') }
    const intent = readHireIntent(accountId)

    if (!intent) { await refreshAtumHiring();

 return }

    if (intent.needsConsent && !consent) { throw new Error('offer_changed') }
    saveHireIntent({ ...intent, needsConsent: false })
    await finish()
  })
}

async function finish(): Promise<void> {
  let intent = $atumHireIntent.get()
  const scope = captureAtumAssistantDirectoryScope()

  const check = () => {
    if (!intent || !scope.accountId || !isAtumAssistantDirectoryScopeCurrent(scope) ||
      intent.accountId !== scope.accountId || $atumHireIntent.get()?.requestId !== intent.requestId) { throw new Error('hiring_account_changed') }
  }

  check()

  if (!intent) { throw new Error('hiring_pending') }
  const bridge = storeBridge()

  if (!bridge?.hireAgent) { throw new Error('hiring_unavailable') }

  if (!intent.assistantId) {
    await refreshProfiles()
    check()
    let employee = $atumAgents.get().find(row => row.localProfileId === intent!.profileId)

    if (!employee) {
      // The persisted random profile key is the creation idempotency key. A
      // lost response is recovered by listing this exact key on the next try.
      await createProfile({ name: intent.profileId, display_name: intent.name, avatar: intent.avatar,
        managed_by: ATUM_MANAGED_BY, clone_from: ATUM_AGENT_ID, provider: 'atum-managed', model: 'binh-minh' })
      check()
      await refreshProfiles()
      check()
      employee = $atumAgents.get().find(row => row.localProfileId === intent!.profileId)
    }

    if (!employee?.identityId || !employee.isManaged || employee.isDefault) { throw new Error('hiring_identity_unavailable') }
    // Only the public name belongs in the portable profile. Paid instructions
    // are hydrated at the hosted provider boundary, never copied to SOUL.md.
    await updateProfileSoul(intent.profileId, `# ${intent.name}\n`)
    check()

    const registered = await atumMessagingClient().registerAssistant({ identityId: employee.identityId, displayName: intent.name,
      avatar: intent.avatar, isDefault: false, lifecycleRevision: employee.lifecycleRevision })

    check()

    if (registered.assistant.identityId !== employee.identityId || registered.assistant.status !== 'active') { throw new Error('hiring_identity_unavailable') }
    recordAtumAssistantDirectoryEntry(registered.assistant, scope.accountId, scope.generation)
    intent = { ...intent, assistantId: registered.assistant.id }
    saveHireIntent(intent)
  }

  const localAgent = $atumAgents.get().find(agent => agent.hostedId === intent!.assistantId)

  if (localAgent?.localProfileId && localAgent.definitionState === 'local_only') {
    await uploadPortableAtumAgent(localAgent)
    check()
  }

  const result = await bridge.hireAgent(intent.assistantId!, intent.offerId, intent.offerVersion, intent.requestId, true, intent.accountId)
  check()

  if (result.outcome === 'offer_changed') {
    if (!result.offer || result.offer.id !== intent.offerId) { throw new Error('offer_unavailable') }
    saveHireIntent({ ...intent, requestId: crypto.randomUUID(), offerVersion: result.offer.version,
      priceProtons: result.offer.price_protons, needsConsent: true })
    await refreshAtumStoreCatalog(true)
    throw new Error('offer_changed')
  }

  if (result.subscription?.assistant_id !== intent.assistantId || result.subscription.offer_id !== intent.offerId) {
    throw new Error('hiring_identity_unavailable')
  }

  clearHireIntent(intent)
  await Promise.allSettled([refreshAtumHiring(), refreshAtumStoreCatalog(true), refreshAtumAssistantDirectory()])
}

export async function openAtumHire(assistantId: string): Promise<void> {
  const scope = captureAtumAssistantDirectoryScope()
  const agent = $atumAgents.get().find(row => row.hostedId === assistantId)

  if (!agent) { throw new Error('hiring_identity_unavailable') }
  const profileId = agent.localProfileId || (agent.definitionState === 'setup' ? await setupPortableAtumAgent(agent) : null)

  if (!isAtumAssistantDirectoryScopeCurrent(scope) || !profileId) { throw new Error('hiring_identity_unavailable') }
  talkToAtumAgent(profileId)
}
