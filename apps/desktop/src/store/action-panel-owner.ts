import { atom } from 'nanostores'

/** Stable backend-issued identities. A profile name is only a routing hint. */
export interface ActionPanelOwner {
  accountId: string
  connectionId: string
  backend_id: string
  agent_id: string
  profile: string
  version: 1
  submission_dedup: boolean
}

export const $actionPanelOwner = atom<ActionPanelOwner | null>(null)
export const $actionPanelEpoch = atom(0)
let provisional = crypto.randomUUID()
export const $panelDraftRevision = atom(0)
const drafts = new Map<string, string>()

export function panelOwnerKey(owner = $actionPanelOwner.get()): string {
  return owner ? [owner.accountId, owner.connectionId, owner.backend_id, owner.agent_id].map(encodeURIComponent).join(':') : `pending:${provisional}`
}

export function panelDraftKey(): string {
  const key = panelOwnerKey()

  if (!drafts.has(key)) {drafts.set(key, crypto.randomUUID())}

  return `atum-chat:${key}:draft:${drafts.get(key)}`
}

export function newPanelDraft(): void {
  drafts.set(panelOwnerKey(), crypto.randomUUID())
  $panelDraftRevision.set($panelDraftRevision.get() + 1)
}

export function invalidateActionPanelOwner(): void {
  provisional = crypto.randomUUID()
  $actionPanelOwner.set(null)
  $actionPanelEpoch.set($actionPanelEpoch.get() + 1)
}

export function validPanelCapabilities(value: unknown): value is Pick<ActionPanelOwner, 'backend_id' | 'agent_id' | 'version' | 'submission_dedup'> {
  if (!value || typeof value !== 'object') {return false}
  const data = value as Partial<ActionPanelOwner>
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

  return data.version === 1 && uuid.test(data.backend_id ?? '') && uuid.test(data.agent_id ?? '') && data.submission_dedup === true
}

export function adoptActionPanelOwner(owner: ActionPanelOwner): string {
  const previous = panelOwnerKey()
  const draft = drafts.get(previous)

  if (draft) {drafts.set(panelOwnerKey(owner), draft)}
  $actionPanelOwner.set(owner)

  return previous
}

let resolutionKey = ''

export function beginPanelOwnerResolution(key: string): void {
  if (key !== resolutionKey) {resolutionKey = key; invalidateActionPanelOwner()}
}

const ownersByProfile = new Map<string, ActionPanelOwner>()
$actionPanelOwner.listen(owner => {
  if (owner) {ownersByProfile.set([owner.accountId, owner.connectionId, owner.profile].join('\0'), owner)}
})

export function actionPanelOwnerForProfile(profile?: string): ActionPanelOwner | null {
  const current = $actionPanelOwner.get()

  if (!current) {return null}
  const requested = profile?.trim() || 'default'

  return requested === current.profile ? current : ownersByProfile.get([current.accountId, current.connectionId, requested].join('\0')) ?? null
}
