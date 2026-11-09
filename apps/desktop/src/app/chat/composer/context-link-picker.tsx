import { useStore } from '@nanostores/react'
import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react'

import { ConsumerFileIcon } from '@/app/atum/consumer-file-icon'
import { Button } from '@/components/ui/button'
import { NoticeBand } from '@/components/ui/error-state'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { SearchField } from '@/components/ui/search-field'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { AppWindow, FileText, Loader2 } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { $actionPanelOwner } from '@/store/action-panel-owner'
import { $atumShellEnabled } from '@/store/atum-shell'
import {
  beginOtherAppsLink,
  cancelOtherAppsLink,
  closeContextPicker,
  linkPanelDocument,
  linkSavedDocument,
  linkWordDocument,
  openContextPicker,
  reconnectContextLink,
  useAutomaticContext as restoreAutomaticContext,
  showLinkedDocument
} from '@/store/context-link-actions'
import {
  $contextLinkError,
  $contextLinkOperationEpoch,
  $contextLinkPending,
  $contextPickerOpen,
  $conversationContextLink,
  canLinkConversation,
  contextLinkFenceCurrent,
  contextLinkOwnerFence,
  otherAppsLinkIntentForScope
} from '@/store/conversation-context-links'
import { documentContextForPanel } from '@/store/document-context'
import { $workbenchScope, $workbenchTabs, type WorkbenchTabRegistration } from '@/store/workbench-tabs'

import { type NativeOpenDocumentWindow, type NativeOpenDocumentWindows, officeKindForBundle } from '../../../../shared/skills-launcher'
import type { WordDocumentCandidate, WordDocumentInventory } from '../../../../shared/word-companion'

import { requestComposerFocus } from './focus'

interface PickerAnchor {
  height: number
  left: number
  top: number
  width: number
}

const PICKER_ANCHOR_EVENT = 'atum:context-link-picker-anchor'
let lastPickerAnchor: PickerAnchor | null = null

/** Keep the controlled picker attached to the initiating composer control. */
export function openContextLinkPickerFrom(origin?: HTMLElement): void {
  if (origin) {
    const rect = origin.getBoundingClientRect()
    lastPickerAnchor = { height: rect.height, left: rect.left, top: rect.top, width: rect.width }
    window.dispatchEvent(new CustomEvent<PickerAnchor>(PICKER_ANCHOR_EVENT, { detail: lastPickerAnchor }))
  }

  openContextPicker()
}

function fallbackAnchor(): PickerAnchor {
  return { height: 1, left: Math.max(8, window.innerWidth - 24), top: Math.max(8, window.innerHeight - 24), width: 1 }
}

type Candidate =
  | { id: string; kind: 'panel'; label: string; detail: string; tab: WorkbenchTabRegistration }
  | { id: string; kind: 'word'; label: string; detail: string; word: WordDocumentCandidate }
  | { id: string; kind: 'saved-file'; label: string; detail: string; window: NativeOpenDocumentWindow }

function panelCandidates(tabs: WorkbenchTabRegistration[], scopeKey: string): Candidate[] {
  return tabs.flatMap(tab => {
    const context = documentContextForPanel(tab, scopeKey, true)

    // The shared resolver includes text readers, images, and pane-native
    // documents. A preview's metadata alone never makes it a candidate.
    if (!context || context.state === 'unavailable' || context.state === 'refused') {return []}
    const label = context.identity.name
    const detail = context.identity.path

    return [{ id: `panel:${tab.viewKey ?? tab.id}`, kind: 'panel' as const, label, detail, tab }]
  })
}

function candidateMatches(candidate: Candidate, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase()

  return !needle || `${candidate.label} ${candidate.detail}`.toLocaleLowerCase().includes(needle)
}

function savedName(path: string, fallback: string): string {
  return path.split('/').filter(Boolean).at(-1) || fallback
}

/**
 * Conversation-owned target picker. Native inventory is deliberately loaded
 * only while this popover is open; it is metadata for the person, never model
 * context and never a desktop poller.
 */
export function ContextLinkPicker({ onSendWithoutDocument, sendWithoutDocumentDisabled = false }: { onSendWithoutDocument?: () => boolean; sendWithoutDocumentDisabled?: boolean }) {
  const { t } = useI18n()
  const scopeKey = useStore($workbenchScope)
  const tabs = useStore($workbenchTabs)
  const open = useStore($contextPickerOpen)
  const pending = useStore($contextLinkPending)
  const error = useStore($contextLinkError)
  const link = useStore($conversationContextLink)
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [word, setWord] = useState<WordDocumentCandidate[]>([])
  const [office, setOffice] = useState<NativeOpenDocumentWindow[]>([])
  const [nativeReason, setNativeReason] = useState<'permission' | 'unavailable' | null>(null)
  const [permission, setPermission] = useState<'automation' | 'accessibility'>('accessibility')
  const [loading, setLoading] = useState(false)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [anchor, setAnchor] = useState<PickerAnchor | null>(lastPickerAnchor)
  const allowed = canLinkConversation(scopeKey)
  const otherAppsIntent = otherAppsLinkIntentForScope(scopeKey)
  const defaultShow = otherAppsIntent?.show ?? true

  const panels = useMemo(() => panelCandidates(tabs, scopeKey), [scopeKey, tabs])

  const candidates = useMemo<Candidate[]>(() => [
    ...panels,
    ...word.map(item => ({ id: `word:${item.id}`, kind: 'word' as const, label: item.name, detail: item.path, word: item })),
    ...office.flatMap(item => {
      const kind = officeKindForBundle(item.app.bundleId)

      return kind && kind !== 'word'
        ? [{ id: `office:${item.id}`, kind: 'saved-file' as const, label: item.title, detail: item.hasSavedFile ? t.composer.savedFile : t.composer.chooseFile, window: item }]
        : []
    })
  ].filter(candidate => candidateMatches(candidate, query)), [office, panels, query, t.composer.chooseFile, t.composer.savedFile, word])

  useEffect(() => {
    if (!open) {return}
    let cancelled = false
    setLoading(true)
    setQuery('')

    void Promise.allSettled([
      window.hermesDesktop?.wordCompanion?.listDocuments?.() ?? Promise.resolve({ documents: [] }),
      window.hermesDesktop?.nativeApps?.listOpenDocumentWindows?.() ?? Promise.resolve({ windows: [] })
    ]).then(results => {
      if (cancelled) {return}
      const wordResult = results[0]
      const officeResult = results[1]

      const nextWord: WordDocumentInventory = wordResult.status === 'fulfilled'
        ? wordResult.value
        : { documents: [], reason: 'unavailable' }

      const nextOffice: NativeOpenDocumentWindows = officeResult.status === 'fulfilled'
        ? officeResult.value
        : { windows: [], reason: 'unavailable' }

      setPermission(nextWord.reason === 'permission' ? 'automation' : 'accessibility')
      setWord(nextWord.documents)
      setOffice(nextOffice.windows)
      setNativeReason(nextWord.reason === 'permission' || nextOffice.reason === 'permission'
        ? 'permission'
        : nextWord.reason === 'unavailable' || nextOffice.reason === 'unavailable' ? 'unavailable' : null)
      setLoading(false)
      window.requestAnimationFrame(() => inputRef.current?.focus())
    })

    return () => {cancelled = true}
  }, [open])

  useEffect(() => {
    const receive = (event: Event) => setAnchor((event as CustomEvent<PickerAnchor>).detail)
    window.addEventListener(PICKER_ANCHOR_EVENT, receive)

    return () => window.removeEventListener(PICKER_ANCHOR_EVENT, receive)
  }, [])

  useEffect(() => {
    if (open && !anchor) {setAnchor(lastPickerAnchor ?? fallbackAnchor())}
  }, [anchor, open])

  useEffect(() => {
    if (activeId && !candidates.some(candidate => candidate.id === activeId)) {setActiveId(null)}
  }, [activeId, candidates])

  const close = (cancelHandoff = true) => {
    if (cancelHandoff) {cancelOtherAppsLink()}
    closeContextPicker()
  }

  const run = (operation: () => Promise<boolean>) => {
    void operation().then(linked => {
      if (linked) {
        cancelOtherAppsLink()
        close(false)
        requestComposerFocus('main')
      }
    }).catch(() => undefined)
  }

  const select = async (candidate: Candidate, show: boolean): Promise<boolean> => {
    if (candidate.kind === 'panel') {
      return linkPanelDocument(candidate.tab, { show })
    }

    if (candidate.kind === 'word') {
      return linkWordDocument({ candidateId: candidate.word.id }, { show })
    }

    const kind = officeKindForBundle(candidate.window.app.bundleId)

    if (!kind || kind === 'word') {return false}
    const fence = contextLinkOwnerFence(scopeKey)
    const operation = $contextLinkOperationEpoch.get()
    const current = () => fence && contextLinkFenceCurrent(fence) && operation === $contextLinkOperationEpoch.get() && $contextPickerOpen.get()

    if (!current()) {return false}
    const bridge = window.hermesDesktop?.nativeApps
    let path = await bridge?.resolveOpenDocumentWindow?.(candidate.window.id)

    if (!current()) {return false}

    // A document title is never proof of a file. The chooser is deliberately
    // the user-facing fallback for unsaved/ambiguous Office windows.
    if (!path) {path = await bridge?.chooseFile(kind)}

    if (!path || !current()) {return false}

    return linkSavedDocument({ path, office: kind, appId: candidate.window.app.id, name: savedName(path, candidate.window.title) }, { show })
  }

  const move = (delta: number) => {
    if (!candidates.length) {return}
    const index = candidates.findIndex(candidate => candidate.id === activeId)
    const current = index < 0 ? (delta > 0 ? -1 : 0) : index
    setActiveId(candidates[(current + delta + candidates.length) % candidates.length]!.id)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowDown') {event.preventDefault(); move(1)}

    if (event.key === 'ArrowUp') {event.preventDefault(); move(-1)}

    if (event.key === 'Enter' && activeId && !event.nativeEvent.isComposing) {
      const candidate = candidates.find(item => item.id === activeId)

      if (candidate) {event.preventDefault(); run(() => select(candidate, !event.altKey && defaultShow))}
    }
  }

  return (
    <Popover onOpenChange={next => {
      if (!next) {close()}
    }} open={open}>
      <PopoverAnchor virtualRef={{ current: { getBoundingClientRect: () => {
        const position = anchor ?? fallbackAnchor()

        return new DOMRect(position.left, position.top, position.width, position.height)
      } } }} />
      <PopoverContent align="start" className="w-[min(26rem,calc(100vw-1rem))] p-0" onKeyDown={onKeyDown} side="top">
        <div className="border-b border-(--ui-stroke-tertiary) px-3 pt-3 pb-2">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-medium text-(--ui-text-primary)">{t.composer.chooseDocumentOrApp}</h2>
            {loading && <Loader2 aria-label={t.common.loading} className="size-3.5 animate-spin text-(--ui-text-tertiary)" />}
          </div>
          <SearchField
            aria-label={t.atum.workspace.launcherSearch}
            containerClassName="mt-2 w-full opacity-100"
            inputClassName="flex-1"
            inputRef={inputRef}
            onChange={setQuery}
            placeholder={t.atum.workspace.launcherSearch}
            value={query}
          />
        </div>
        {!allowed ? (
          <NoticeBand className="m-3" role="status">{t.composer.contextNotIncluded}</NoticeBand>
        ) : (
          <div className="max-h-80 overflow-y-auto p-1.5">
            {link.mode === 'removed' && (
              <NoticeBand className="m-2" role="status">
                <span>{t.composer.contextPausedDetail}</span>
                <Button className="mt-1" onClick={restoreAutomaticContext} size="xs" type="button" variant="ghost">{t.composer.useAutomaticContext}</Button>
              </NoticeBand>
            )}
            {link.mode !== 'automatic' && link.target && (
              <PickerSection label={t.composer.linked}>
                <CurrentTarget name={link.target.name} onSendWithoutDocument={onSendWithoutDocument} path={link.target.path} sendWithoutDocumentDisabled={sendWithoutDocumentDisabled} state={link.state} />
              </PickerSection>
            )}
            {panels.filter(candidate => candidateMatches(candidate, query)).length > 0 && (
              <PickerSection label={t.composer.inThisConversation}>
                {panels.filter(candidate => candidateMatches(candidate, query)).map(candidate => (
                  <CandidateRow active={candidate.id === activeId} candidate={candidate} key={candidate.id} onFocus={setActiveId} onLink={show => run(() => select(candidate, show && defaultShow))} pending={pending} />
                ))}
              </PickerSection>
            )}
            {(word.length > 0 || office.length > 0 || nativeReason) && (
              <PickerSection label={t.composer.openWindows}>
                {candidates.filter(candidate => candidate.kind !== 'panel').map(candidate => (
                  <CandidateRow active={candidate.id === activeId} candidate={candidate} key={candidate.id} onFocus={setActiveId} onLink={show => run(() => select(candidate, show && defaultShow))} pending={pending} />
                ))}
                {nativeReason === 'permission' && (
                  <div className="px-2 py-1.5">
                    <NoticeBand role="status">{t.composer.allowDocumentAccess}</NoticeBand>
                    <Button className="mt-1" onClick={() => void window.hermesDesktop?.nativeApps?.openArrangementSettings(permission)} size="xs" type="button" variant="ghost">
                      {t.composer.openSettings}
                    </Button>
                  </div>
                )}
              </PickerSection>
            )}
            {!candidates.length && !loading && <p className="px-2 py-4 text-center text-xs text-(--ui-text-tertiary)">{t.composer.noDocumentChoices}</p>}
            <div className="flex items-center">
              <button
                className="flex min-h-10 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left text-xs text-(--ui-text-secondary) hover:bg-(--ui-control-hover-background) focus-visible:bg-(--ui-control-hover-background) focus-visible:outline-none"
                data-context-link-other-apps
                onClick={() => {
                  if (beginOtherAppsLink(true)) {close(false)}
                }}
                type="button"
              >
                <AppWindow className="size-3.5 text-(--ui-text-tertiary)" />
                <span>{t.composer.otherApps}</span>
              </button>
              <Tip label={t.composer.linkOnly}>
                <Button aria-label={t.composer.linkOnly} onClick={() => {
                  if (beginOtherAppsLink(false)) {close(false)}
                }} size="xs" type="button" variant="ghost">
                  {t.composer.linkOnly}
                </Button>
              </Tip>
            </div>
          </div>
        )}
        {error && (
          <NoticeBand className="m-2" role="status">
            <span>{error.includes('SHOW') ? t.composer.linkedCouldNotShowBeside : t.composer.contextUnavailable}</span>
            {error.includes('SHOW') && link.mode === 'linked' && (
              <Button className="ms-1" onClick={() => run(showLinkedDocument)} size="xs" type="button" variant="ghost">{t.composer.showBeside}</Button>
            )}
            {!error.includes('SHOW') && link.mode === 'linked' && link.state === 'unavailable' && (
              <>
                <Button className="ms-1" onClick={() => run(reconnectContextLink)} size="xs" type="button" variant="ghost">{t.composer.reconnect}</Button>
                {onSendWithoutDocument && <Button className="ms-1" disabled={sendWithoutDocumentDisabled} onClick={() => onSendWithoutDocument()} size="xs" type="button" variant="ghost">{t.composer.sendWithoutDocument}</Button>}
              </>
            )}
          </NoticeBand>
        )}
      </PopoverContent>
    </Popover>
  )
}

function PickerSection({ children, label }: { children: ReactNode; label: string }) {
  return (
    <section className="py-1.5 first:pt-0">
      <h3 className="px-2 pb-1 text-[0.625rem] font-medium uppercase tracking-wide text-(--ui-text-tertiary)">{label}</h3>
      {children}
    </section>
  )
}

function CurrentTarget({ name, onSendWithoutDocument, sendWithoutDocumentDisabled, path, state }: { name: string; onSendWithoutDocument?: () => boolean; sendWithoutDocumentDisabled?: boolean; path: string; state: 'ready' | 'unavailable' }) {
  const { t } = useI18n()

  return (
    <div className="flex min-h-9 items-center gap-2 px-2 text-xs text-(--ui-text-secondary)">
      <ConsumerFileIcon className="size-3.5 shrink-0" isDirectory={false} name={name} />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{name}</span>
        <span className="block truncate text-[0.625rem] text-(--ui-text-tertiary)">{path}</span>
      </span>
      <span className="text-[0.625rem] text-(--ui-text-tertiary)">{state === 'ready' ? t.composer.linked : t.composer.unavailable}</span>
      {state === 'unavailable' && onSendWithoutDocument && (
        <Button disabled={sendWithoutDocumentDisabled} onClick={() => onSendWithoutDocument()} size="xs" type="button" variant="ghost">{t.composer.sendWithoutDocument}</Button>
      )}
    </div>
  )
}

function CandidateRow({ active, candidate, onFocus, onLink, pending }: {
  active: boolean
  candidate: Candidate
  onFocus: (id: string) => void
  onLink: (show: boolean) => void
  pending: boolean
}) {
  const { t } = useI18n()
  const name = candidate.label
  const label = candidate.kind === 'word' ? t.composer.liveWordText : candidate.kind === 'saved-file' ? t.composer.savedFile : t.composer.readWhenYouSend

  return (
    <div className={cn('group/context-link flex min-h-11 items-center gap-2 rounded-md px-2', active && 'bg-(--ui-control-hover-background)')}>
      <Button aria-label={`${name}. ${label}`} className="h-auto min-h-11 min-w-0 flex-1 justify-start gap-2 overflow-hidden py-2 text-left" disabled={pending} onClick={() => onLink(true)} onFocus={() => onFocus(candidate.id)} size="xs" type="button" variant="ghost">
        <ConsumerFileIcon className="size-3.5 shrink-0" isDirectory={false} name={name} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs text-(--ui-text-primary)">{name}</span>
          <span className="block truncate text-[0.625rem] text-(--ui-text-tertiary)">{label}</span>
        </span>
        <span className="max-w-32 shrink-0 whitespace-normal text-right text-[0.625rem] text-(--ui-text-tertiary)">{candidate.kind === 'panel' ? t.composer.linkAndShow : t.composer.linkAndShowBeside}</span>
      </Button>
      <Tip label={t.composer.linkOnly}>
        <Button aria-label={t.composer.linkOnly} className="shrink-0" data-context-link-only={candidate.id} disabled={pending} onClick={() => onLink(false)} size="xs" type="button" variant="ghost">
          {t.composer.linkOnly}
        </Button>
      </Tip>
    </div>
  )
}

/** Quiet composer action. The popover itself is mounted once beside the composer. */
export function ContextLinkComposerAction() {
  const { t } = useI18n()
  useStore($actionPanelOwner)
  useStore($atumShellEnabled)
  const scopeKey = useStore($workbenchScope)
  const allowed = canLinkConversation(scopeKey)

  return (
    <Tip label={t.composer.workWith} side="top">
      <Button
        aria-label={t.composer.workWith}
        className="inline-flex gap-1.5 text-(--ui-text-tertiary) hover:text-(--ui-text-primary)"
        disabled={!allowed}
        onClick={event => openContextLinkPickerFrom(event.currentTarget)}
        size="sm"
        type="button"
        variant="ghost"
      >
        <FileText className="size-3.5" />
        <span className="hidden min-[56rem]:inline">{t.composer.workWith}</span>
      </Button>
    </Tip>
  )
}
