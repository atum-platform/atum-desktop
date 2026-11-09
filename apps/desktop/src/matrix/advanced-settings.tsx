import { useEffect, useState } from 'react'

import { NoticeBand } from '@/components/ui/error-state'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { type Locale, useI18n } from '@/i18n'
import { ChevronRight } from '@/lib/icons'

import type { MatrixSnapshot } from '../../shared/matrix'
import type { MatrixPageId } from '../../shared/matrix-pages'

import { MatrixDeviceIsolationSetting } from './device-isolation-setting'
import { MatrixKeepAwakeSettings } from './keep-awake-settings'
import { MatrixPeerIdentityPanel } from './peer-identity-panel'
import { primaryAgent } from './room-agent'
import { matrixRosterAgentName } from './roster-model'
import { useSecurityCopy } from './security-copy'
import { SettingsSection } from './settings-row'
import { workplacePageText } from './workplace'
import { WORKPLACE_DEVELOPER_PAGES } from './workplace-nav'

interface AdvancedSettingsCopy {
  /** The pane's name in the navigation and its title. */
  title: string
  /** The pane's one line. */
  help: string
  assistant: string
  /** The one section that lists every page of the assistant's own tools. */
  expert: string
}

const copy: Record<Locale, AdvancedSettingsCopy> = {
  en: {
    title: 'Advanced',
    help: 'Everything your assistant can do, in detail.',
    assistant: 'Assistant',
    expert: 'For developers'
  },
  vi: {
    title: 'Nâng cao',
    help: 'Mọi điều trợ lý làm được, chi tiết hơn.',
    assistant: 'Trợ lý',
    expert: 'Dành cho nhà phát triển'
  },
  ja: {
    title: '詳細',
    help: 'アシスタントにできることを、詳しく。',
    assistant: 'アシスタント',
    expert: '開発者向け'
  },
  zh: {
    title: '高级',
    help: '助手能做的一切，更详细。',
    assistant: '助手',
    expert: '面向开发者'
  },
  'zh-hant': {
    title: '進階',
    help: '助理能做的一切，更詳細。',
    assistant: '助理',
    expert: '開發者專用'
  }
}

export function useAdvancedSettingsCopy(): AdvancedSettingsCopy {
  return copy[useI18n().locale]
}

/** Settings › Advanced is there when this Mac can open an assistant's own pages. */
export function matrixAdvancedSettingsAvailable(snapshot: MatrixSnapshot): boolean {
  return Boolean(
    window.atumKeepAwake || snapshot.deviceIsolation || (window.atumMatrix?.pages && (snapshot.agents?.length ?? 0) > 0)
  )
}

const rowControl =
  '-me-2 h-7 w-auto min-w-0 gap-1 border-transparent! bg-transparent! px-2 text-(--atum-ink) shadow-none! hover:bg-(--atum-hover)! data-[state=open]:bg-(--atum-hover)!'

/**
 * Settings › Advanced, the last pane: every page an assistant has on this Mac (what was the
 * rail's Workplace), one row each with one line of help. A row closes Settings and opens the
 * page in the window, as a side trip whose back control returns here. With more than one
 * assistant, the first row says whose pages these are.
 */
export function MatrixAdvancedSettings({
  onOpenPage,
  snapshot
}: {
  onOpenPage?(page: MatrixPageId, agentPrincipal: string): void
  snapshot: MatrixSnapshot
}) {
  const { locale, t } = useI18n()
  const words = copy[locale]
  const securityCopy = useSecurityCopy()
  const [failed, setFailed] = useState(false)
  const agents = snapshot.agents ?? []
  const fallback = primaryAgent(snapshot)?.principal ?? agents[0]?.principal
  const [chosen, setChosen] = useState<string | undefined>(fallback)
  // The chosen assistant can go away (removed on another Mac): fall back to the primary one.
  const principal = agents.some(agent => agent.principal === chosen) ? chosen : fallback

  useEffect(() => {
    if (chosen !== principal) {
      setChosen(principal)
    }
  }, [chosen, principal])

  const pages = Boolean(principal && onOpenPage && window.atumMatrix?.pages)

  const row = (page: MatrixPageId) => {
    const { title, help } = workplacePageText(page, locale)

    return (
      <button
        className="atum-settings-row atum-settings-link"
        data-matrix-advanced-page={page}
        key={page}
        onClick={() => {
          if (principal) {
            onOpenPage?.(page, principal)
          }
        }}
        type="button"
      >
        <span className="atum-settings-row-text">
          <span className="atum-settings-row-title">{title}</span>
          <span className="atum-settings-row-help">{help}</span>
        </span>
        <ChevronRight aria-hidden className="atum-settings-chevron" />
      </button>
    )
  }

  return (
    <div data-matrix-advanced-settings>
      {window.atumKeepAwake && (
        <SettingsSection>
          <MatrixKeepAwakeSettings />
        </SettingsSection>
      )}
      {snapshot.deviceIsolation && (
        <SettingsSection>
          <MatrixDeviceIsolationSetting
            locale={locale}
            onChange={async value => {
              if (!snapshot.identity) {
                return
              }
              setFailed(false)
              await window.atumMatrix.command({ kind: 'deviceIsolation', identity: snapshot.identity, value })
            }}
            onFailure={() => setFailed(true)}
            value={snapshot.deviceIsolation.value}
            writable={snapshot.deviceIsolation.writable && Boolean(snapshot.identity)}
          />
          {failed && <NoticeBand tone="failure">{securityCopy.error}</NoticeBand>}
          <MatrixPeerIdentityPanel snapshot={snapshot} />
        </SettingsSection>
      )}
      {pages && <p className="atum-settings-help">{words.help}</p>}
      {pages && agents.length > 1 && (
        <SettingsSection>
          <div className="atum-settings-row">
            <span className="min-w-0 flex-1">{words.assistant}</span>
            <Select onValueChange={setChosen} value={principal}>
              <SelectTrigger aria-label={words.assistant} className={rowControl} size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                {agents.map(agent => (
                  <SelectItem key={agent.principal} value={agent.principal}>
                    {matrixRosterAgentName(agent, t.matrixShell.assistantName)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </SettingsSection>
      )}
      {pages && <SettingsSection title={words.expert}>{WORKPLACE_DEVELOPER_PAGES.map(row)}</SettingsSection>}
    </div>
  )
}
