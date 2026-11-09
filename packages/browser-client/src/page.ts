import { BrowserFailure } from './record'
import { runtimeConfiguration } from './configuration'
import { openAccount, signOutAccount } from './account'
import { CloudIntents } from './cloud-intents'
import { DomainHttpFailure } from './domain-oauth'
import { DomainGrant } from './domain-session'
import { IndexedDomainStore } from './domain-storage'
import { readableMessages, startBrowserRuntime } from './runtime'
import { BoundDevice } from './session'
import { acquireWriter, IndexedDeviceStore } from './storage'

// Authorization codes are protocol input only; scrub before any async work or network.
// Access/refresh/ID tokens are never accepted as URL input. No callback URL is logged.
const callback = location.pathname === '/callback' ? new URL(location.href) : undefined
if (location.search || location.hash || callback) history.replaceState(null, '', '/')

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const button = (id: string) => element<HTMLButtonElement>(id)
const notice = element('notice')
const rooms = element<HTMLSelectElement>('rooms')
const restoreKey = element<HTMLInputElement>('restore-key')
let device: BoundDevice | undefined
let runtime: ReturnType<typeof startBrowserRuntime> | undefined
let release: (() => void) | undefined
let busy = false
let usable = false
let empty = false
let domain: DomainGrant | undefined
let domainReady = false
let domainConnectable = false
let stagedId: string | undefined
let keyTimer: ReturnType<typeof setTimeout> | undefined
let cloud: CloudStatus | undefined
let cloudDisclosureVersion: number | undefined
const cloudIntents = new CloudIntents()

interface CloudTerms { durationMs: number; cardRequired: boolean; autoRenew: boolean; disclosureVersion: number; modelAliases: string[]; includedMicroProtons: number; includedComputeSeconds: number; includedStorageBytes: number; concurrentTasks: number }
interface CloudTrial { offerVersion: number; status: 'eligible' | 'declined' | 'preparing' | 'active' | 'expired'; startableNow: boolean; terms: CloudTerms; endsAt?: number }
interface CloudEnrollment { enrollmentId: string; state: string; trust: 'pending' | 'trusted' | 'recovery_needed' }
interface CloudAgent { agentPrincipal: string; readiness: string; executor: string | null; enrollment: CloudEnrollment | null }
interface CloudStatus { access: 'trial' | 'paid' | 'none'; trial: CloudTrial | null; walletForCloud: boolean; walletAvailable: number; agents: CloudAgent[]; scheduling: { available: boolean; reason?: string } }

const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value)
const object = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
function cloudStatus(value: unknown): CloudStatus {
  const root = object(value); const access = object(root?.access); const funding = object(root?.funding); const wallet = object(funding?.wallet); const scheduling = object(root?.scheduling)
  if (!root || !access || !['trial', 'paid', 'none'].includes(access.effective as string) || !funding || !wallet ||
      typeof wallet.usableForCloud !== 'boolean' || !integer(wallet.availableMicroProtons) || !scheduling || typeof scheduling.available !== 'boolean' || !Array.isArray(root.agents)) throw new BrowserFailure('operation_failed')
  const rawTrial = root.trial
  let trial: CloudTrial | null = null
  if (rawTrial !== null) {
    const candidate = object(rawTrial); const terms = object(candidate?.terms)
    if (!candidate || !terms || !integer(candidate.offerVersion) || !['eligible', 'declined', 'preparing', 'active', 'expired'].includes(candidate.status as string) ||
        typeof candidate.startableNow !== 'boolean' || !integer(terms.durationMs) || typeof terms.cardRequired !== 'boolean' || typeof terms.autoRenew !== 'boolean' ||
        !integer(terms.disclosureVersion) || !Array.isArray(terms.modelAliases) || terms.modelAliases.some(alias => typeof alias !== 'string') ||
        !integer(terms.includedMicroProtons) || !integer(terms.includedComputeSeconds) || !integer(terms.includedStorageBytes) || !integer(terms.concurrentTasks)) throw new BrowserFailure('operation_failed')
    trial = { offerVersion: candidate.offerVersion, status: candidate.status as CloudTrial['status'], startableNow: candidate.startableNow,
      terms: { durationMs: terms.durationMs, cardRequired: terms.cardRequired, autoRenew: terms.autoRenew, disclosureVersion: terms.disclosureVersion,
        modelAliases: terms.modelAliases as string[], includedMicroProtons: terms.includedMicroProtons, includedComputeSeconds: terms.includedComputeSeconds,
        includedStorageBytes: terms.includedStorageBytes, concurrentTasks: terms.concurrentTasks }, ...(integer(candidate.endsAt) ? { endsAt: candidate.endsAt } : {}) }
  }
  const agents = root.agents.map(item => {
    const agent = object(item); const enrollment = object(agent?.enrollment)
    if (!agent || !uuid(agent.agentPrincipal) || !['ready', 'starting', 'busy', 'offline', 'recovery_needed'].includes(agent.readiness as string) ||
        ![null, 'local', 'cloud'].includes(agent.executor as string | null) || (agent.enrollment !== null && (!enrollment || !uuid(enrollment.enrollmentId) ||
        !['pending', 'trusted', 'recovery_needed'].includes(enrollment.trust as string) || typeof enrollment.state !== 'string'))) throw new BrowserFailure('operation_failed')
    return { agentPrincipal: agent.agentPrincipal, readiness: agent.readiness as string, executor: agent.executor as string | null,
      enrollment: enrollment ? { enrollmentId: enrollment.enrollmentId as string, state: enrollment.state as string, trust: enrollment.trust as CloudEnrollment['trust'] } : null }
  })
  return { access: access.effective as CloudStatus['access'], trial, walletForCloud: wallet.usableForCloud, walletAvailable: wallet.availableMicroProtons, agents,
    scheduling: { available: scheduling.available, ...(typeof scheduling.reason === 'string' ? { reason: scheduling.reason } : {}) } }
}
function cloudReason(error: unknown): string {
  if (error instanceof DomainHttpFailure) return error.reason === 'unavailable' ? 'Cloud is unavailable. Retry this request when the service is ready.' : `Cloud request was refused: ${error.reason.replaceAll('_', ' ')}.`
  return failures[error instanceof BrowserFailure ? error.code : 'operation_failed']
}

const failures: Record<BrowserFailure['code'], string> = {
  configuration_required: 'This browser needs its account configuration. See the package runbook.',
  secure_context_required: 'Open this app over HTTPS or localhost in a browser with IndexedDB and Web Locks support.',
  device_busy: 'This device is open in another tab. Close that tab, then reload here.',
  recovery_needed: 'This saved device needs recovery. It has been preserved. Do not clear storage or create a replacement device; follow the runbook.',
  signed_out: 'Signed out. This device and its encrypted storage have been preserved.',
  operation_failed: 'The operation could not finish. Check your connection and retry.'
}

function message(text: string, error = false) {
  notice.textContent = text
  notice.toggleAttribute('data-error', error)
}

function controls() {
  button('login').disabled = busy || !empty
  for (const id of ['signout', 'create-key', 'restore']) button(id).disabled = busy || !usable
  rooms.disabled = busy || !usable
  restoreKey.disabled = busy || !usable
  button('setup').disabled = busy || !usable || !stagedId || !element<HTMLInputElement>('saved').checked
  button('discard').disabled = busy || !usable
  button('domain-connect').disabled = busy || !usable || !domainConnectable
  for (const id of ['domain-refresh', 'domain-assistant']) button(id).disabled = busy || !usable || !domainReady
  for (const id of ['cloud-refresh', 'drive-account', 'cloud-funding']) button(id).disabled = busy || !usable || !domainReady
  const eligible = cloud?.trial?.status === 'eligible'
  button('cloud-accept').disabled = busy || !usable || !domainReady || !eligible
  button('cloud-decline').disabled = busy || !usable || !domainReady || !eligible
  const selected = element<HTMLSelectElement>('cloud-agent').value
  const canEnroll = !!cloud && cloud.access !== 'none' && !!cloudDisclosureVersion && !!selected
  button('cloud-enroll').disabled = busy || !usable || !domainReady || !canEnroll
  const enrollment = cloud?.agents.find(agent => agent.agentPrincipal === selected)?.enrollment
  button('cloud-handoff').disabled = busy || !usable || !domainReady || enrollment?.state !== 'awaiting_trust'
  element<HTMLSelectElement>('cloud-agent').disabled = busy || !usable || !domainReady || !cloud?.agents.length
}

function clearKey() {
  clearTimeout(keyTimer)
  stagedId = undefined
  element<HTMLTextAreaElement>('recovery-key').value = ''
  element<HTMLInputElement>('saved').checked = false
  element('staged').hidden = true
  controls()
}

function fail(error: unknown) {
  const code = error instanceof BrowserFailure ? error.code : 'operation_failed'
  message(failures[code], true)
  controls()
}

async function endRuntime() {
  usable = false
  domainReady = false
  cloud = undefined
  cloudDisclosureVersion = undefined
  element('domain-result').textContent = ''
  element('cloud-result').textContent = ''
  clearKey()
  restoreKey.value = ''
  element('messages').replaceChildren()
  rooms.replaceChildren(new Option('Choose an encrypted room', ''))
  await runtime?.stop()
  runtime = undefined
  release?.()
  release = undefined
}

async function action(work: () => Promise<void>) {
  if (busy) return
  busy = true
  controls()
  try { await work() } catch (error) { fail(error) }
  finally { busy = false; controls() }
}

async function start() {
  runtime = startBrowserRuntime(device!, snapshot => {
    if (!usable) return
    element('identity').textContent = snapshot.identity ? `${snapshot.identity.userId} · ${snapshot.identity.deviceId}` : 'Signed out'
    element('security').textContent = `Recovery operation in this tab: ${snapshot.security?.recovery ?? 'idle'}`
    const options = snapshot.rooms.filter(room => room.encrypted && room.membership === 'join')
    const signature = JSON.stringify(options.map(room => [room.id, room.name]))
    if (rooms.dataset.signature !== signature) {
      rooms.replaceChildren(new Option('Choose an encrypted room', ''), ...options.map(room => new Option(room.name, room.id)))
      rooms.dataset.signature = signature
    }
    rooms.value = snapshot.roomId ?? ''
    element('messages').replaceChildren(...readableMessages(snapshot).map(item => {
      const li = document.createElement('li')
      const sender = document.createElement('small')
      sender.textContent = item.sender
      li.append(sender, document.createTextNode(item.body))
      return li
    }))
    message(snapshot.state === 'ready' ? 'Connected to your saved device.' : snapshot.state === 'error' ? 'The Matrix connection needs attention. Reload to retry this saved device.' : 'Connecting your device…', snapshot.state === 'error')
    if (snapshot.messages.some(item => item.decryptionFailed)) message('Some encrypted messages need your saved recovery key.', true)
  })
  usable = true
  try { await runtime.ready } catch {
    await endRuntime()
    throw new BrowserFailure('recovery_needed')
  }
  controls()
}

button('login').onclick = () => void action(async () => {
  const url = await device!.beginLogin()
  empty = false
  message('Continue sign-in with MAS…')
  location.assign(url.href)
})
button('signout').onclick = () => void action(async () => {
  usable = false
  domainReady = false
  domainConnectable = false
  clearKey()
  // Block admission durably before revocation. Stop even when the provider is offline.
  let confirmed = false
  try { confirmed = await signOutAccount(device!, domain) } finally { await endRuntime() }
  message(confirmed ? failures.signed_out : 'Signed out locally. Your device and encrypted storage are preserved. Server revocation could not be confirmed.', !confirmed)
  element('domain-notice').textContent = confirmed ? 'Account signed out.' : 'Account closed locally; server revocation unconfirmed.'
})
function domainFailure(error: unknown) {
  domainReady = domain?.isActive() ?? false
  domainConnectable = domain?.canConnect() ?? false
  element('domain-result').textContent = ''
  element('domain-notice').textContent = error instanceof BrowserFailure && error.code === 'signed_out'
    ? 'Account connection is signed out. Your Matrix device is preserved.'
    : 'The account connection needs attention. Your Matrix device and encrypted rooms are preserved.'
  controls()
}
function renderCloud(status: CloudStatus) {
  const trial = status.trial
  const terms = trial?.terms
  element('cloud-summary').textContent = `Access: ${status.access}. ${trial ? `Trial: ${trial.status}${trial.endsAt ? `, ends ${new Date(trial.endsAt).toLocaleString()}` : ''}.` : 'No trial offer is available.'}`
  element('cloud-terms').textContent = terms ? `Offer v${trial!.offerVersion}: ${terms.durationMs.toLocaleString()} ms; card required: ${terms.cardRequired ? 'yes' : 'no'}; automatic renewal: ${terms.autoRenew ? 'yes' : 'no'}; models: ${terms.modelAliases.join(', ')}; included model allowance: ${terms.includedMicroProtons.toLocaleString()} micro-Protons; compute: ${terms.includedComputeSeconds.toLocaleString()} seconds; storage: ${terms.includedStorageBytes.toLocaleString()} bytes; concurrent tasks: ${terms.concurrentTasks.toLocaleString()}.` : ''
  element<HTMLInputElement>('cloud-wallet').checked = status.walletForCloud
  element('cloud-funding-summary').textContent = `Wallet available: ${status.walletAvailable.toLocaleString()} micro-Protons. Wallet use for cloud: ${status.walletForCloud ? 'allowed' : 'not allowed'}.`
  element('cloud-scheduling').textContent = status.scheduling.available ? 'Scheduling is available.' : `Scheduling unavailable: ${status.scheduling.reason ?? 'unavailable'}.`
  const select = element<HTMLSelectElement>('cloud-agent'); const current = select.value
  select.replaceChildren(new Option('Choose an agent', ''), ...status.agents.map(agent => new Option(`${agent.agentPrincipal} · ${agent.readiness}${agent.enrollment ? ` · ${agent.enrollment.trust}` : ''}`, agent.agentPrincipal)))
  select.value = status.agents.some(agent => agent.agentPrincipal === current) ? current : ''
  const selected = status.agents.find(agent => agent.agentPrincipal === select.value)
  element('cloud-enrollment').textContent = selected?.enrollment ? `Cloud enrollment: ${selected.enrollment.state}; trust: ${selected.enrollment.trust}.` : selected ? 'No cloud enrollment for this agent.' : ''
}
async function refreshCloud() {
  const status = cloudStatus(await domain!.request({ resource: 'cloud-status' }))
  if (!usable || !domainReady) return
  cloud = status
  cloudDisclosureVersion = undefined
  try {
    const disclosure = object(await domain!.request({ resource: 'cloud-disclosure' }))
    if (disclosure?.kind === 'cloud' && integer(disclosure.version) && disclosure.version > 0) cloudDisclosureVersion = disclosure.version
  } catch {} // Status remains useful even while enrollment terms are unavailable.
  if (!usable || !domainReady) return
  renderCloud(status)
  element('cloud-notice').textContent = 'Cloud status refreshed.'
  element('cloud-notice').toggleAttribute('data-error', false)
}
function rememberCloudEnrollment(value:unknown) {
  const enrollment=object(object(value)?.enrollment)
  if(!uuid(enrollment?.enrollmentId)||!runtime||!domain)throw new BrowserFailure('operation_failed')
  runtime.rememberCloudEnrollment(enrollment.enrollmentId,{
    enrollments:()=>domain!.request({resource:'cloud-enrollments'}),roster:()=>domain!.request('agents')})
}
async function cloudAction(work: () => Promise<void>) {
  await action(async () => {
    try { await work() } catch (error) { element('cloud-notice').textContent = cloudReason(error); element('cloud-notice').toggleAttribute('data-error', true) }
  })
}
async function domainAction(work: () => Promise<void>) {
  await action(async () => { try { await work() } catch (error) { domainFailure(error) } })
}
button('domain-connect').onclick = () => void domainAction(async () => {
  const url = await domain!.beginLogin()
  domainConnectable = false
  clearKey()
  element('domain-notice').textContent = 'Continue the separate account sign-in with MAS…'
  location.assign(url.href)
})
button('domain-refresh').onclick = () => void domainAction(async () => {
  const value = await domain!.request('wallet') as { unit?: unknown; balances?: Record<string, unknown> } | null
  const balances = value?.balances
  const counts = balances && ['available', 'paid', 'earned', 'promo', 'held'].map(key => balances[key])
  if (value?.unit !== 'micro_proton' || !counts || counts.some(value => typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) ||
      counts[0] !== (counts[1] as number) + (counts[2] as number) + (counts[3] as number)) throw new BrowserFailure('operation_failed')
  if (!usable || !domainReady) return
  element('domain-result').textContent = `${Math.floor((counts[0] as number) / 1_000_000).toLocaleString()} Protons available · ${((counts[4] as number) / 1_000_000).toLocaleString()} held`
  element('domain-notice').textContent = 'Account connected. Balance refreshed.'
})
button('domain-assistant').onclick = () => void domainAction(async () => {
  await domain!.request('assistant')
  if (usable && domainReady) element('domain-notice').textContent = 'Your assistant is prepared. Hosted agent authorization remains a separate launch step.'
})
button('cloud-refresh').onclick = () => void cloudAction(refreshCloud)
button('drive-account').onclick = () => void cloudAction(async () => {
  await domain!.request({ resource: 'drive-account' })
  element('cloud-notice').textContent = 'Drive account request completed.'
  element('cloud-notice').toggleAttribute('data-error', false)
})
button('cloud-accept').onclick = () => void cloudAction(async () => {
  const trial = cloud?.trial
  if (!trial || trial.status !== 'eligible') throw new BrowserFailure('operation_failed')
  await domain!.request({ resource: 'cloud-trial', body: { requestId: cloudIntents.requestId(`trial:accept:${trial.offerVersion}:${trial.terms.disclosureVersion}`), operation: 'accept', offerVersion: trial.offerVersion, disclosureVersion: trial.terms.disclosureVersion } })
  await refreshCloud()
})
button('cloud-decline').onclick = () => void cloudAction(async () => {
  const trial = cloud?.trial
  if (!trial || trial.status !== 'eligible') throw new BrowserFailure('operation_failed')
  await domain!.request({ resource: 'cloud-trial', body: { requestId: cloudIntents.requestId(`trial:decline:${trial.offerVersion}`), operation: 'decline', offerVersion: trial.offerVersion } })
  await refreshCloud()
})
button('cloud-funding').onclick = () => void cloudAction(async () => {
  const walletForCloud = element<HTMLInputElement>('cloud-wallet').checked
  await domain!.request({ resource: 'cloud-funding', body: { requestId: cloudIntents.requestId(`funding:${walletForCloud}`), walletForCloud } })
  await refreshCloud()
})
element<HTMLSelectElement>('cloud-agent').onchange = () => { if (cloud) renderCloud(cloud); controls() }
button('cloud-enroll').onclick = () => void cloudAction(async () => {
  const disclosureVersion = cloudDisclosureVersion; const agentPrincipal = element<HTMLSelectElement>('cloud-agent').value
  if (!disclosureVersion || !agentPrincipal || !device) throw new BrowserFailure('operation_failed')
  const ownerDevice = device.identity().deviceId
  rememberCloudEnrollment(await domain!.request({ resource: 'cloud-enrollment', body: { requestId: cloudIntents.requestId(`enroll:${agentPrincipal}:${ownerDevice}:${disclosureVersion}`), kind: 'cloud', agentPrincipal, ownerDevice, disclosureVersion } }))
  await refreshCloud()
  element('cloud-notice').textContent = 'Cloud enrollment requested. It is not trusted until Matrix verification completes.'
  element('cloud-notice').toggleAttribute('data-error', false)
})
button('cloud-handoff').onclick = () => void cloudAction(async () => {
  const enrollment = cloud?.agents.find(agent => agent.agentPrincipal === element<HTMLSelectElement>('cloud-agent').value)?.enrollment
  if (!enrollment || !device) throw new BrowserFailure('operation_failed')
  rememberCloudEnrollment(await domain!.request({ resource: 'cloud-handoff', body: { enrollmentId: enrollment.enrollmentId, ownerDevice: device.identity().deviceId } }))
  await refreshCloud()
  element('cloud-notice').textContent = 'Verification window opened. Complete Matrix verification before cloud is trusted.'
  element('cloud-notice').toggleAttribute('data-error', false)
})
button('create-key').onclick = () => void action(async () => {
  clearKey()
  const key = await runtime!.createRecoveryKey()
  stagedId = key.id
  element<HTMLTextAreaElement>('recovery-key').value = key.key
  element('staged').hidden = false
  keyTimer = setTimeout(clearKey, 120000)
  message('Save this recovery key privately, then confirm below.')
})
element<HTMLInputElement>('saved').onchange = controls
button('setup').onclick = () => void action(async () => {
  const id = stagedId!
  clearKey()
  await runtime!.setUpRecovery(id)
  message('Recovery setup requested. Wait for Recovery: ready before leaving.')
})
button('discard').onclick = () => void action(async () => { clearKey(); await runtime!.discardRecovery() })
element<HTMLFormElement>('restore-form').onsubmit = event => {
  event.preventDefault()
  const key = restoreKey.value
  restoreKey.value = ''
  void action(async () => { await runtime!.restoreRecovery(key); message('Restoring recovery. Wait for Recovery: ready.') })
}
rooms.onchange = () => void action(async () => { if (rooms.value) await runtime!.selectRoom(rooms.value) })

// BFCache must not resurrect an old SDK after its writer lock was released.
addEventListener('pagehide', () => { usable = false; domainReady = false; domain?.closeAdmission(); clearKey(); restoreKey.value = ''; void endRuntime().catch(() => {}) })
addEventListener('pageshow', event => { if (event.persisted) location.reload() })

void action(async () => {
  if (!isSecureContext || !crypto.subtle || !navigator.locks || !indexedDB.databases) {
    throw new BrowserFailure('secure_context_required')
  }
  release = await acquireWriter(navigator.locks)
  try {
    const response = await fetch('/runtime-config.json', { cache: 'no-store', credentials: 'omit', redirect: 'error' })
    if (!response.ok) throw new BrowserFailure('configuration_required')
    const config = runtimeConfiguration(await response.json(), location.origin)
    const store = await IndexedDeviceStore.open()
    device = new BoundDevice(config.matrix, store, undefined, undefined, () => {
      usable = false
      domain?.closeAdmission()
      void endRuntime().then(() => message(failures.recovery_needed, true)).catch(() => message(failures.recovery_needed, true))
    })
    if (config.domain) {
      domain = new DomainGrant(config.domain, await IndexedDomainStore.open(), () => device!.identity())
      element('domain').hidden = false
    }
    const state = await openAccount(device, domain, start, callback)
    if (state.matrix === 'empty') { empty = true; message(config.launch ? 'Ready to sign in.' : 'Ready to sign in with a disposable local account.') }
    domainReady = state.domain === 'active'
    domainConnectable = usable && (state.domain === 'empty' || state.domain === 'attention' && domain?.canConnect() === true)
    if (state.domain === 'active') element('domain-notice').textContent = 'Account connected. Your Matrix device has its own separate sign-in.'
    else if (state.domain === 'attention') domainFailure(state.domainError)
    if (state.authorization) {
      clearKey()
      element('domain-notice').textContent = 'Your Matrix device is saved. Continue the separate account sign-in with MAS…'
      location.assign(state.authorization.href)
    }
  } catch (error) {
    await endRuntime()
    throw error
  }
})
