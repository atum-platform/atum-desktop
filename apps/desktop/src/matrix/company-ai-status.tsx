import { useStore } from '@nanostores/react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { AtumAssistantAvatar } from '@/app/atum/assistant-avatar'
import { Switch } from '@/components/ui/switch'
import { useI18n } from '@/i18n'

import { matrixCompanyBoardCopy } from '../../shared/matrix-company-board-copy'

import { type CompanyAIView, companyDesktopAdapter } from './company-desktop-adapter'
import { $companyAIStatuses, companySpaceScope, publishCompanyAIStatus } from './company-space-store'

export function CompanyAIAvatar({
  className,
  name,
  principal
}: {
  className: string
  name: string
  principal: string
}) {
  return (
    <AtumAssistantAvatar
      className={className}
      id={principal}
      name={name}
      rosterAvatar
    />
  )
}

export interface CompanyAIStatusProps {
  accountKey: string
  companyId: string
  manage?: boolean
}

export type CompanyAIAvailability = 'ready' | 'preparing' | 'unavailable' | 'off'

/**
 * What the platform's computed state (`company_ai_view`) lets people do with the Chief of Staff now.
 * Only `ready` means it is in the channels and answers; anything else must not be offered as a mention
 * target or listed as a member, or a question goes to a bot that never replies.
 */
export function companyAIAvailability(view: CompanyAIView): CompanyAIAvailability {
  if (!view.enabled) {
    return 'off'
  }

  return view.state === 'ready' ? 'ready' : view.state === 'preparing' ? 'preparing' : 'unavailable'
}

/** The one short line for a Chief of Staff that can't answer yet; none when it can. */
export function companyAIAvailabilityLine(
  availability: CompanyAIAvailability,
  copy: ReturnType<typeof matrixCompanyBoardCopy>
): string | undefined {
  return availability === 'off'
    ? copy.companyAIOff
    : availability === 'preparing'
      ? copy.chiefNotReady
      : availability === 'unavailable'
        ? copy.chiefUnavailable
        : undefined
}

/** Only a state the owner should act on is worth a line: a working Chief of Staff says nothing. */
function problemCopy(view: CompanyAIView, copy: ReturnType<typeof matrixCompanyBoardCopy>): string | undefined {
  if (!view.enabled) {
    return copy.companyAIOff
  }

  return view.state === 'paused'
    ? copy.chiefPaused
    : view.state === 'attention'
      ? copy.chiefAttention
      : undefined
}

/** Reads the company's Chief of Staff view; no company (a room outside Team Space) reads nothing. */
export const COMPANY_AI_RECHECK_MS = 15_000

/**
 * While someone is reaching for a Chief of Staff that can't answer yet, look again every 15 s (and at
 * once, if the last look is older), so one that has just become ready is offered without reopening
 * the channel. Stops when they stop waiting or it is ready.
 */
export function useCompanyAIRecheck(waiting: boolean, reload: () => void): void {
  const lastLook = useRef(0)

  useEffect(() => {
    if (!waiting) {
      return
    }

    const look = () => {
      lastLook.current = Date.now()
      reload()
    }

    if (Date.now() - lastLook.current >= COMPANY_AI_RECHECK_MS) {
      look()
    }

    const timer = setInterval(look, COMPANY_AI_RECHECK_MS)

    return () => clearInterval(timer)
  }, [reload, waiting])
}

/**
 * The company's Chief of Staff view. `refreshKey` is a caller's change signal (for a channel's
 * presentation binding, its joined members): each new value reads the view again, and `fresh` says
 * a read started after the latest change (and the latest account, company or reload) has answered.
 * Until then a caller that must fail closed treats the cached view as unknown.
 */
export function useCompanyAIStatus(
  accountKey: string,
  companyId: string | undefined,
  refreshKey = ''
): {
  view?: CompanyAIView
  loading: boolean
  failed: boolean
  fresh: boolean
  reload(): void
} {
  const statuses = useStore($companyAIStatuses)
  const key = companyId ? companySpaceScope(accountKey, companyId) : undefined
  const [loading, setLoading] = useState(Boolean(key && !statuses[key]))
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [freshFor, setFreshFor] = useState<string>()
  const generation = useRef(0)
  const requestKey = [accountKey, companyId ?? '', attempt, refreshKey].join('\u0000')

  useEffect(() => {
    const adapter = companyDesktopAdapter()
    const request = ++generation.current
    const asked = [accountKey, companyId ?? '', attempt, refreshKey].join('\u0000')

    if (!adapter || !companyId) {
      setLoading(false)
      setFailed(false)

      return
    }

    setLoading(true)
    setFailed(false)
    void adapter
      .readAI(companyId)
      .then(view => {
        if (generation.current === request && view.companyId === companyId) {
          publishCompanyAIStatus(accountKey, view)
          setFreshFor(asked)
        }
      })
      .catch(() => {
        if (generation.current === request) {
          publishCompanyAIStatus(accountKey, null)
          setFailed(true)
        }
      })
      .finally(() => {
        if (generation.current === request) {
          setLoading(false)
        }
      })

    return () => {
      generation.current += 1
    }
  }, [accountKey, attempt, companyId, refreshKey])

  return {
    view: key ? statuses[key] : undefined,
    loading,
    failed,
    fresh: freshFor === requestKey,
    reload: useCallback(() => setAttempt(value => value + 1), [])
  }
}

/**
 * The one owner switch for Company AI, in the company settings where the owner
 * can act. It draws a state line only when something is wrong; a ready Chief of
 * Staff is a channel member and a sender, not a header badge.
 */
export function CompanyAIStatus({ accountKey, companyId, manage = false }: CompanyAIStatusProps) {
  const { locale } = useI18n()
  const copy = matrixCompanyBoardCopy(locale)
  const { failed, loading, reload, view } = useCompanyAIStatus(accountKey, companyId)
  const [saving, setSaving] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)

  if (loading && !view) {
    return null
  }

  if (!view) {
    return failed ? (
      <button className="text-xs font-medium text-(--atum-ink-muted)" onClick={reload} type="button">
        {copy.retry}
      </button>
    ) : null
  }

  const problem = problemCopy(view, copy)

  const toggle = async (enabled: boolean) => {
    const adapter = companyDesktopAdapter()

    if (!adapter || saving) {
      return
    }

    setSaving(true)
    setSaveFailed(false)

    try {
      const next = await adapter.configureAI(companyId, {
        schemaVersion: 1,
        requestId: globalThis.crypto.randomUUID(),
        expectedRevision: view.revision,
        enabled
      })

      publishCompanyAIStatus(accountKey, next)
    } catch {
      setSaveFailed(true)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className={manage ? 'flex items-center justify-between gap-4' : 'flex min-w-0 items-center gap-2'}
      data-company-ai-status
    >
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-(--atum-ink)">{copy.companyAI}</span>
        {problem && (
          <span className="block text-xs text-(--atum-ink-muted)" data-company-ai-state={view.state}>
            {problem}
          </span>
        )}
      </span>
      {manage && view.canManage && (
        <Switch
          aria-label={copy.companyAI}
          checked={view.enabled}
          disabled={saving}
          onCheckedChange={enabled => void toggle(enabled)}
          size="xs"
        />
      )}
      {saveFailed && (
        <span className="sr-only" role="alert">
          {copy.unavailable}
        </span>
      )}
    </div>
  )
}
