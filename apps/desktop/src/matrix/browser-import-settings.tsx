import { useCallback, useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { NoticeBand } from '@/components/ui/error-state'
import { useI18n } from '@/i18n'

import type { MatrixSnapshot } from '../../shared/matrix'
import type {
  MatrixBrowserImportBridge,
  MatrixBrowserImportLast,
  MatrixBrowserImportOutcome,
  MatrixBrowserImportReason,
  MatrixBrowserImportStatus
} from '../../shared/matrix-browser-import'
import { matrixBrowserImportCopy } from '../../shared/matrix-browser-import-copy'

import { matrixPrimaryAgentName, matrixRosterAgentName } from './roster-model'
import { SettingsRow, SettingsSection } from './settings-row'

/** Reasons that are the situation, not a fault: the person is told and nothing is shown as broken. */
const CALM_REASONS = new Set<MatrixBrowserImportReason>([
  'busy',
  'chrome_not_found',
  'no_computer',
  'nothing_to_import',
  'signed_out',
  'unsupported'
])

/**
 * Settings › Connections › Browser logins: one button. Importing reads Chrome on this Mac, asks the person once
 * (macOS may first ask for Chrome's Keychain secret), and hands the primary assistant the sign-ins of the sites
 * they use. There is nothing to choose: no browser, no profile, no sites, no agent. Everything that decides what
 * is imported lives in main; this only starts it and says how it went, in counts and closed words.
 */
export function MatrixBrowserImportSettings({
  bridge = window.atumBrowserImport,
  snapshot
}: {
  bridge?: MatrixBrowserImportBridge
  snapshot: MatrixSnapshot
}) {
  const { locale, t } = useI18n()
  const words = matrixBrowserImportCopy[locale]
  const [status, setStatus] = useState<MatrixBrowserImportStatus | null>(null)
  const [outcome, setOutcome] = useState<MatrixBrowserImportOutcome | null>(null)
  const [running, setRunning] = useState(false)
  const mounted = useRef(false)
  const starting = useRef(false)
  const generation = useRef(0)

  const refresh = useCallback(async () => {
    const token = ++generation.current

    try {
      const next = bridge ? await bridge.status() : null

      if (mounted.current && generation.current === token) {
        setStatus(next)
      }
    } catch {
      if (mounted.current && generation.current === token) {
        setStatus(previous => previous ?? { state: 'unavailable' })
      }
    }
  }, [bridge])

  useEffect(() => {
    mounted.current = true
    void refresh()
    // An import can finish while Settings is away (the Touch ID waits as long as the person does).
    const focus = () => void refresh()
    window.addEventListener('focus', focus)

    return () => {
      mounted.current = false
      generation.current += 1
      window.removeEventListener('focus', focus)
    }
  }, [refresh])

  if (!bridge || !status || status.state === 'unavailable') {
    return null
  }

  const agentName = (principal?: string) => {
    const agent = principal ? snapshot.agents?.find(each => each.principal === principal) : undefined

    return agent
      ? matrixRosterAgentName(agent, t.matrixShell.assistantName)
      : matrixPrimaryAgentName(snapshot, t.matrixShell.assistantName)
  }

  const start = async () => {
    // A second click while the first is still waiting on the person must not start a second import.
    if (starting.current) {
      return
    }

    starting.current = true
    setRunning(true)
    setOutcome(null)

    try {
      const result = await bridge.run()

      if (mounted.current) {
        setOutcome(result)
      }
    } catch {
      if (mounted.current) {
        setOutcome({ outcome: 'unavailable', reason: 'failed' })
      }
    } finally {
      starting.current = false

      if (mounted.current) {
        setRunning(false)
        void refresh()
      }
    }
  }

  const busy = running || status.state === 'running'
  const imported: MatrixBrowserImportLast | undefined = outcome?.outcome === 'imported' ? outcome : status.last
  const failed = outcome && outcome.outcome !== 'imported'

  const notice =
    outcome?.outcome === 'declined'
      ? words.declined
      : outcome?.outcome === 'unavailable'
        ? words.reasons[outcome.reason]
        : null

  // Nothing broke when the person said no, or there is nothing to import: those are information, not failures.
  const tone = outcome?.outcome === 'unavailable' && !CALM_REASONS.has(outcome.reason) ? 'failure' : 'notice'

  return (
    <SettingsSection
      data-matrix-browser-import
      tip={words.tip(agentName())}
      title={words.title}
    >
      <SettingsRow
        control={
          <Button aria-busy={busy} disabled={busy} onClick={() => void start()} size="sm" variant="secondary">
            {busy ? words.working : words.button}
          </Button>
        }
        help={words.rowHelp(agentName())}
        title={words.rowTitle}
      />
      {imported && !failed && (
        <SettingsRow
          className="atum-settings-row-quiet"
          data-matrix-browser-import-result
          help={imported.skippedSiteCount > 0 ? words.leftOut : undefined}
          role="status"
          title={words.imported(agentName(imported.agentPrincipal), imported.siteCount)}
        />
      )}
      {notice && (
        <NoticeBand data-matrix-browser-import-notice role="status" tone={tone}>
          {notice}
        </NoticeBand>
      )}
    </SettingsSection>
  )
}
