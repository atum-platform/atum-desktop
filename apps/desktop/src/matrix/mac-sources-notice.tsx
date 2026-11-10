import { useStore } from '@nanostores/react'
import { atom, map } from 'nanostores'
import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { NoticeBand } from '@/components/ui/error-state'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { X } from '@/lib/icons'

import type { MatrixAgentSourceGate, MatrixAgentSourcesBridge } from '../../shared/matrix-agent-sources'
import { matrixKnowledgeSourcesCopy, type MatrixKnowledgeSourcesCopy } from '../../shared/matrix-knowledge-sources-copy'

import { openMatrixConnections } from './connections-request'
import { matrixSourceList } from './mac-reach-rows'
import { useNoticePresented } from './notice-presented'
import { SettingsTip } from './settings-row'

/**
 * The sources the band named when it first appeared, per account on this Mac. Main drops `notice`
 * as soon as it is presented; the band keeps its words until the owner hides it, so a notice that
 * counts after one second never vanishes mid-sentence. Process-local: the next launch has no notice.
 */
const $shownNotices = map<Record<string, readonly MatrixAgentSourceGate[]>>({})
const $hiddenNotices = atom<ReadonlySet<string>>(new Set())
const presentedScopes = new Set<string>()
/** Accounts whose notice this window has already asked main about; a chat switch never re-asks. */
const checkedScopes = new Set<string>()

/** Tests only: a fresh window. */
export function resetMatrixMacSourcesNotice(): void {
  $shownNotices.set({})
  $hiddenNotices.set(new Set())
  presentedScopes.clear()
  checkedScopes.clear()
}

const NAME_OF: Partial<Record<MatrixAgentSourceGate, keyof MatrixKnowledgeSourcesCopy['names']>> = {
  messages: 'messages',
  browser: 'browser',
  location: 'location',
  folders: 'folders',
  google: 'google',
  team_spaces: 'teamSpaces'
}

/** "Messages, Browser and Location": only the sources that are on, in the window's language. */
export function matrixNoticeSources(
  sources: readonly MatrixAgentSourceGate[],
  copy: MatrixKnowledgeSourcesCopy,
  locale: string
): string {
  const names = [...new Set(sources)].flatMap(source => {
    const key = NAME_OF[source]

    return key ? [copy.names[key]] : []
  })

  return names.length ? matrixSourceList(names, locale) : ''
}

/**
 * U1 §3: the one-time band above an assistant's composer, for accounts that existed before cloud
 * assistants read Mac sources. One line, a (?) with the detail, Settings and ×. Never modal, never
 * blocks typing, `role="status"`. Showing it is recorded (presented); × and Settings only hide it.
 */
export function MatrixMacSourcesNotice({
  bridge = window.atumMatrix?.agentSources,
  onSettings = openMatrixConnections,
  scope
}: {
  bridge?: MatrixAgentSourcesBridge
  onSettings?: () => void
  /** The account on this Mac; a notice shown for one account never answers for another. */
  scope: string
}) {
  const { locale } = useI18n()
  const copy = matrixKnowledgeSourcesCopy[locale]
  const shown = useStore($shownNotices)[scope]
  const hidden = useStore($hiddenNotices).has(scope)
  const [presented, setPresented] = useState(() => presentedScopes.has(scope))
  const live = useRef(true)

  useEffect(() => {
    live.current = true

    if (!bridge || hidden) {
      return () => {
        live.current = false
      }
    }

    const read = () =>
      void bridge.read().then(
        view => {
          const sources = view.notice?.sources ?? []

          if (live.current && sources.length && !$shownNotices.get()[scope]) {
            $shownNotices.setKey(scope, sources)
          }
        },
        () => undefined
      )

    if (!checkedScopes.has(scope)) {
      checkedScopes.add(scope)
      read()
    }

    const unsubscribe = bridge.subscribe?.(read)

    return () => {
      live.current = false
      unsubscribe?.()
    }
  }, [bridge, hidden, scope])

  const line = shown ? matrixNoticeSources(shown, copy, locale) : ''
  const visible = Boolean(bridge && line && !hidden)

  useNoticePresented(visible && !presented && Boolean(bridge?.presented), () => {
    presentedScopes.add(scope)
    setPresented(true)
    void bridge?.presented?.().catch(() => {
      presentedScopes.delete(scope)
      setPresented(false)
    })
  })

  if (!visible) {
    return null
  }

  const hide = () => $hiddenNotices.set(new Set([...$hiddenNotices.get(), scope]))

  return (
    <NoticeBand data-matrix-mac-sources-notice role="status" tone="notice">
      <span className="flex flex-wrap items-center gap-x-(--ak-s2) gap-y-1">
        <span className="min-w-0 flex-[1_1_16rem]">{copy.notice.line(line)}</span>
        <span className="ms-auto flex shrink-0 items-center gap-1">
          <SettingsTip label={copy.sectionTip} />
          <Button
            data-matrix-mac-sources-notice-settings
            onClick={() => {
              hide()
              onSettings()
            }}
            size="sm"
            variant="text"
          >
            {copy.notice.settings}
          </Button>
          <Tip label={copy.notice.dismiss}>
            <Button aria-label={copy.notice.dismiss} onClick={hide} size="icon-xs" variant="ghost">
              <X />
            </Button>
          </Tip>
        </span>
      </span>
    </NoticeBand>
  )
}
