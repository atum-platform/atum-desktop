import { $actionPanelEpoch, $actionPanelOwner, panelOwnerKey } from '@/store/action-panel-owner'
import { contextLinkForScope } from '@/store/conversation-context-links'
import { documentContextForScope } from '@/store/document-context'
import { gatewayForProfile } from '@/store/gateway'
import { utf8CapturePrefix } from '@/store/surface-capture'
import { ownsActionPanel } from '@/store/windows'
import { $wordCompanion } from '@/store/word-companion'
import { wordBindingForTurn } from '@/store/word-turn-ledger'
import { $workbenchScope, resolveCaptureScope } from '@/store/workbench-tabs'

interface WordGatewayEvent {
  type?: string
  profile?: unknown
  session_id?: unknown
  payload?: unknown
}

/** A background, excluded, or stale conversation must never read or edit Word. */
export async function handleWordDocument(event: WordGatewayEvent, activeSessionId: () => string | null): Promise<boolean> {
  if (event.type !== 'word.document.request') {return false}
  const payload = event.payload as Record<string, unknown> | undefined
  const requestId = payload?.request_id
  const turnId = payload?.turn_id
  const profile = event.profile
  const sessionId = event.session_id

  if ([requestId, turnId, profile, sessionId].some(value => typeof value !== 'string' || !value || value.length > 256)) {return true}
  const gateway = gatewayForProfile(profile as string)

  if (!gateway) {return true}
  const pair = $wordCompanion.get()
  const scope = $workbenchScope.get()

  const current = () => {
    const owner = $actionPanelOwner.get()
    const latest = $wordCompanion.get()
    const linked = contextLinkForScope(scope).binding?.word
    const link = contextLinkForScope(scope)
    const bindingId = wordBindingForTurn(profile as string, sessionId as string, turnId as string)
    const item = documentContextForScope(scope)

    const automatic = pair && latest?.descriptor.id === pair.descriptor.id && pair.ownerKey === panelOwnerKey(owner) &&
      pair.epoch === $actionPanelEpoch.get() && resolveCaptureScope(pair.scopeKey) === resolveCaptureScope(scope)

    const automaticBindingId = automatic ? pair?.descriptor.id : undefined

    const automaticAllowed = link.mode === 'automatic' && item?.identity.path === pair?.descriptor.path &&
      item?.state !== 'refused' && item?.state !== 'unavailable'

    const linkedAllowed = link.mode === 'linked' && link.state === 'ready' && link.target?.kind === 'word'

    return Boolean(bindingId && owner?.profile === profile &&
      ownsActionPanel() && scope === $workbenchScope.get() &&
      activeSessionId() === sessionId && ((linkedAllowed && linked?.id === bindingId) || (automaticAllowed && automaticBindingId === bindingId)))
  }

  let result: Record<string, unknown> = { error: 'WORD_CONTEXT_CHANGED',
    message: 'This turn has no authorized Word binding. Start a new turn after linking a document, or use active document automatically. ' +
      'If document context was removed, ask the user to re-enable automatic context; never reopen a document to bypass removal.' }

  try {
    const bridge = window.hermesDesktop?.wordCompanion

    if (current() && bridge?.execute) {
      const bindingId = wordBindingForTurn(profile as string, sessionId as string, turnId as string)

      if (!bindingId) {throw new Error('WORD_CONTEXT_CHANGED')}

      const snapshot = await bridge.execute(bindingId, { profile: profile as string,
        request_id: requestId as string, session_id: sessionId as string, turn_id: turnId as string })

      if (current()) {
        const excerpt = utf8CapturePrefix(snapshot.text)
        result = { ...excerpt, revision: snapshot.revision, saved: snapshot.saved, applied: snapshot.applied,
          story: 'main text', character_count: snapshot.text.length,
          ...(snapshot.selection ? { selection: { ...utf8CapturePrefix(snapshot.selection.text, 4096),
            start: snapshot.selection.start, end: snapshot.selection.end } } : {}) }
      } else {result = { error: 'WORD_CONTEXT_CHANGED', message: 'The conversation changed during the operation. Inspect Word before another edit.' }}
    }
  } catch (error) {
    const code = String(error).match(/\bWORD_[A-Z_]+\b/u)?.[0] ?? 'WORD_UNAVAILABLE'

    const messages: Record<string, string> = {
      WORD_EDIT_UNCERTAIN: 'The edit may have occurred. Inspect the linked document; do not retry the same request.',
      WORD_DUPLICATE_NAME: 'Word has multiple open documents with this filename. Ask the user to close the other document before editing; never close or rename it automatically.',
      WORD_ACTIVATE_DOCUMENT: 'Ask the user to bring the linked document forward in Word before editing.',
      WORD_CONTENT_CHANGED: 'The snapshot is stale or already used. Read the current text and reassess before a new edit.',
      WORD_MIXED_FORMATTING: 'This target has mixed formatting. Use a smaller uniform target, or explain the limit; never flatten its formatting.',
      WORD_EDIT_UNSUPPORTED: 'This target contains protected or structural content, or the document has tracked changes enabled. Explain the limit; do not use an on-disk overwrite.'
    }

    result = { error: code, ...(messages[code] ? { message: messages[code] } : {}) }
  }

  await gateway.request('word.document.respond', { request_id: requestId, session_id: sessionId,
    turn_id: turnId, result: JSON.stringify(result) }).catch(() => undefined)

  return true
}
