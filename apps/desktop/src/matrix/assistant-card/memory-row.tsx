import './memory.css'

import { useCallback, useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { NoticeBand } from '@/components/ui/error-state'
import { Switch } from '@/components/ui/switch'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { ChevronRight, MoreHorizontal } from '@/lib/icons'

import {
  AGENT_MEMORY_CORRECTION_MAX,
  type AgentMemoryBridge,
  type AgentMemoryBrowse,
  type AgentMemoryCleanup,
  type AgentMemoryFact,
  type AgentMemoryRefusal,
  type AgentMemorySource,
  type AgentMemorySourceKind,
  type AgentMemoryStatus
} from '../../../shared/agent-memory'

import { type AgentMemoryCopy, useAgentMemoryCopy } from './memory-copy'

type Active = Extract<AgentMemoryStatus, { available: true }>
type StatusView = { state: 'loading' } | { state: 'failed' } | { state: 'ready'; status: AgentMemoryStatus }

/** Accepted-but-not-applied mutations are retried with the same operation ID on this schedule. */
export const AGENT_MEMORY_PENDING_RETRY_MS: readonly number[] = [2_000, 5_000, 15_000]

const newOperationId = () => globalThis.crypto.randomUUID()

/**
 * The assistant card's "Memory" row: On or Off at a glance, and, opened in place like Routines,
 * what this assistant remembers grouped by where it learned it. Correct and Forget report only
 * what main answered. Nothing shows when memory is not available for this assistant, and no
 * failure here reaches the chat.
 */
export function AgentMemoryRow({
  agentName,
  agentPrincipal,
  bridge
}: {
  agentName: string
  agentPrincipal: string
  bridge: AgentMemoryBridge
}) {
  const copy = useAgentMemoryCopy()
  const [view, setView] = useState<StatusView>({ state: 'loading' })
  const [open, setOpen] = useState(false)
  const generation = useRef(0)

  const read = useCallback(() => {
    const request = ++generation.current

    void bridge.status(agentPrincipal).then(
      result => {
        if (request === generation.current) {
          setView(result.ok ? { state: 'ready', status: result.status } : { state: 'failed' })
        }
      },
      () => {
        if (request === generation.current) {
          setView({ state: 'failed' })
        }
      }
    )
  }, [agentPrincipal, bridge])

  useEffect(() => {
    const requests = generation
    read()

    // A late answer for an unmounted or re-keyed row is ignored.
    return () => {
      requests.current++
    }
  }, [read])

  const adopt = useCallback((status: AgentMemoryStatus) => {
    generation.current++
    setView({ state: 'ready', status })
  }, [])

  // Not active for this assistant (or not allowed): the card stays as it was.
  if (view.state === 'ready' && !view.status.available) {
    return null
  }

  const active = view.state === 'ready' && view.status.available ? view.status : null
  const value = active ? (active.state === 'on' ? copy.on : copy.off) : view.state === 'failed' ? copy.retry : '…'

  return (
    <>
      <button
        aria-expanded={open}
        className="atum-settings-row atum-settings-link"
        data-assistant-card-memory={active?.state ?? view.state}
        onClick={() => {
          if (view.state === 'failed') {
            read()
          }

          setOpen(next => !next)
        }}
        type="button"
      >
        <span className="atum-settings-row-title min-w-0 flex-1">{copy.row}</span>
        <span className="atum-card-row-value">{value}</span>
        <ChevronRight aria-hidden className="atum-settings-chevron" data-open={open || undefined} />
      </button>
      {open && (
        <div className="atum-memory-panel" data-assistant-memory-panel>
          {view.state === 'failed' ? (
            <Problem copy={copy} onRetry={read} words={copy.offline} />
          ) : !active ? (
            <p className="atum-memory-quiet">{copy.loading}</p>
          ) : (
            <MemoryPanel
              agentName={agentName}
              agentPrincipal={agentPrincipal}
              bridge={bridge}
              copy={copy}
              key={active.scope}
              onStale={read}
              onStatus={adopt}
              status={active}
            />
          )}
        </div>
      )}
    </>
  )
}

function Problem({ copy, onRetry, words }: { copy: AgentMemoryCopy; onRetry?: () => void; words: string }) {
  return (
    <NoticeBand role="status" tone="notice">
      {words}
      {onRetry && (
        <>
          {' '}
          <Button onClick={onRetry} size="inline" variant="textStrong">
            {copy.retry}
          </Button>
        </>
      )}
    </NoticeBand>
  )
}

/** One mutation the person asked for. `operationId` is reused for every retry of it. */
interface Operation {
  operationId: string
  kind: 'forget' | 'correct'
  phase: 'running' | 'pending' | 'failed'
  attempt: number
  text?: string
}

type BrowseView = { state: 'loading' } | { state: 'failed' } | { state: 'ready'; data: AgentMemoryBrowse }

function sourceName(copy: AgentMemoryCopy, source: { kind: AgentMemorySourceKind; label?: string }) {
  return source.label?.trim() || copy.sourceKinds[source.kind]
}

function capital(words: string) {
  return words.charAt(0).toLocaleUpperCase() + words.slice(1)
}

export function cleanupWords(copy: AgentMemoryCopy, cleanup: AgentMemoryCleanup, date: (value: number) => string) {
  switch (cleanup.state) {
    case 'pending':
      return copy.forgetting

    case 'hidden':
      return copy.hidden

    case 'cleaned':
      return cleanup.backupExpiresAt !== undefined
        ? `${copy.cleaned} · ${copy.backupUntil(date(cleanup.backupExpiresAt))}`
        : copy.cleaned
  }
}

function MemoryPanel({
  agentName,
  agentPrincipal,
  bridge,
  copy,
  onStale,
  onStatus,
  status
}: {
  agentName: string
  agentPrincipal: string
  bridge: AgentMemoryBridge
  copy: AgentMemoryCopy
  onStale(): void
  onStatus(status: AgentMemoryStatus): void
  status: Active
}) {
  const { locale } = useI18n()
  const [view, setView] = useState<BrowseView>({ state: 'loading' })
  const [operations, setOperations] = useState<Record<string, Operation>>({})
  const [forgotten, setForgotten] = useState<Record<string, AgentMemoryCleanup>>({})
  const [editing, setEditing] = useState<{ handle: string; draft: string } | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [openFailed, setOpenFailed] = useState<string | null>(null)
  const [toggle, setToggle] = useState<{ busy: boolean; failed?: 'offline' | 'conflict'; retry?: () => void }>({ busy: false })
  const live = useRef(true)
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>())
  const statusRef = useRef(status)
  statusRef.current = status

  useEffect(() => {
    live.current = true
    const pending = timers.current

    return () => {
      live.current = false

      for (const timer of pending) {
        clearTimeout(timer)
      }

      pending.clear()
    }
  }, [])

  const date = (value: number) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(value)

  /** A refused scope or handle means the account or view moved on: read everything again. */
  const refused = (reason: AgentMemoryRefusal) => {
    if (reason === 'stale' || reason === 'unavailable') {
      onStale()

      return true
    }

    return false
  }

  const load = useCallback(() => {
    void bridge.browse(agentPrincipal, { scope: status.scope }).then(
      result => {
        if (!live.current) {
          return
        }

        if (result.ok) {
          setView({ state: 'ready', data: result.browse })
        } else if (!refused(result.reason)) {
          setView(previous => (previous.state === 'ready' ? previous : { state: 'failed' }))
        }
      },
      () => live.current && setView(previous => (previous.state === 'ready' ? previous : { state: 'failed' }))
    )
    // `refused` reads only stable props.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentPrincipal, bridge, status.scope])

  useEffect(() => {
    load()
  }, [load])

  const later = (run: () => void, ms: number) => {
    const timer = setTimeout(() => {
      timers.current.delete(timer)

      if (live.current) {
        run()
      }
    }, ms)

    timers.current.add(timer)
  }

  const setOperation = (key: string, next: Operation | null) =>
    setOperations(({ [key]: _previous, ...rest }) => (next ? { ...rest, [key]: next } : rest))

  /** Runs, or reruns with the same operation ID, one forget of a fact or a whole source. */
  const forget = (key: string, target: { kind: 'fact' | 'source'; handle: string }, operation?: Operation) => {
    const current: Operation = operation
      ? { ...operation, phase: 'running' }
      : { operationId: newOperationId(), kind: 'forget', phase: 'running', attempt: 0 }

    setOperation(key, current)

    void bridge.forget(agentPrincipal, { scope: status.scope, target, operationId: current.operationId }).then(
      result => {
        if (!live.current) {
          return
        }

        if (!result.ok) {
          if (!refused(result.reason)) {
            setOperation(key, { ...current, phase: 'failed' })
          }

          return
        }

        onStatus(result.status)

        if (result.cleanup.state === 'pending') {
          const delay = AGENT_MEMORY_PENDING_RETRY_MS[current.attempt]
          const next = { ...current, phase: delay === undefined ? ('failed' as const) : ('pending' as const), attempt: current.attempt + 1 }
          setOperation(key, next)

          if (delay !== undefined) {
            later(() => forget(key, target, next), delay)
          }

          return
        }

        setOperation(key, null)
        setConfirming(null)
        setForgotten(previous => ({ ...previous, [key]: result.cleanup }))
      },
      () => live.current && setOperation(key, { ...current, phase: 'failed' })
    )
  }

  const correct = (fact: AgentMemoryFact, text: string, operation?: Operation) => {
    const key = fact.handle

    const current: Operation = operation
      ? { ...operation, phase: 'running' }
      : { operationId: newOperationId(), kind: 'correct', phase: 'running', attempt: 0, text }

    setOperation(key, current)

    void bridge
      .correct(agentPrincipal, { scope: status.scope, handle: fact.handle, text: current.text ?? text, operationId: current.operationId })
      .then(
        result => {
          if (!live.current) {
            return
          }

          if (!result.ok) {
            if (result.reason === 'conflict') {
              setOperation(key, null)
              setEditing(null)
              setOpenFailed(null)
              setToggle(previous => ({ ...previous, failed: 'conflict' }))
              load()
            } else if (!refused(result.reason)) {
              setOperation(key, { ...current, phase: 'failed' })
            }

            return
          }

          onStatus(result.status)
          setEditing(null)

          if (result.outcome === 'pending') {
            const delay = AGENT_MEMORY_PENDING_RETRY_MS[current.attempt]
            const next = { ...current, phase: delay === undefined ? ('failed' as const) : ('pending' as const), attempt: current.attempt + 1 }
            setOperation(key, next)

            if (delay !== undefined) {
              later(() => correct(fact, text, next), delay)
            }

            return
          }

          setOperation(key, null)
          const updated = result.fact
          setView(previous =>
            previous.state === 'ready'
              ? {
                  state: 'ready',
                  data: {
                    ...previous.data,
                    sources: previous.data.sources.map(source => ({
                      ...source,
                      facts: source.facts.map(each => (each.handle === fact.handle ? updated : each))
                    }))
                  }
                }
              : previous
          )
        },
        () => live.current && setOperation(key, { ...current, phase: 'failed' })
      )
  }

  const setEnabled = (enabled: boolean, operationId = newOperationId(), revision = statusRef.current.revision) => {
    setToggle({ busy: true })

    void bridge.setEnabled(agentPrincipal, { scope: status.scope, revision, enabled, operationId }).then(
      result => {
        if (!live.current) {
          return
        }

        if (result.ok) {
          setToggle({ busy: false })
          onStatus(result.status)
        } else if (result.reason === 'conflict') {
          setToggle({ busy: false, failed: 'conflict' })
          onStale()
        } else if (!refused(result.reason)) {
          setToggle({ busy: false, failed: 'offline', retry: () => setEnabled(enabled, operationId, revision) })
        }
      },
      () => live.current && setToggle({ busy: false, failed: 'offline', retry: () => setEnabled(enabled, operationId, revision) })
    )
  }

  const openSource = (fact: AgentMemoryFact) => {
    setOpenFailed(null)

    void bridge.openSource(agentPrincipal, { scope: status.scope, handle: fact.handle }).then(
      result => {
        if (live.current && !result.ok && !(result.reason === 'stale' && refused(result.reason))) {
          setOpenFailed(fact.handle)
        }
      },
      () => live.current && setOpenFailed(fact.handle)
    )
  }

  const busy = Object.values(operations).some(each => each.phase !== 'failed')

  return (
    <>
      <div className="atum-memory-switch">
        <div className="min-w-0 flex-1">
          <span className="atum-settings-row-title">{copy.remembers}</span>
          <p className="atum-memory-quiet">{status.state === 'on' ? copy.onHelp(agentName) : copy.offHelp(agentName)}</p>
        </div>
        <Switch
          aria-label={copy.remembers}
          checked={status.state === 'on'}
          data-assistant-memory-switch
          disabled={toggle.busy}
          onCheckedChange={next => setEnabled(next)}
          size="xs"
        />
      </div>
      {toggle.failed === 'offline' && <Problem copy={copy} onRetry={toggle.retry} words={copy.changeFailed} />}
      {toggle.failed === 'conflict' && <Problem copy={copy} words={copy.changedElsewhere} />}
      {view.state === 'loading' ? (
        <p className="atum-memory-quiet">{copy.loading}</p>
      ) : view.state === 'failed' ? (
        <Problem copy={copy} onRetry={load} words={copy.offline} />
      ) : (
        <>
          {view.data.coverage === 'partial' && <Problem copy={copy} words={copy.partial} />}
          {view.data.sources.every(source => source.facts.length === 0) && view.data.receipts.length === 0 && (
            <p className="atum-memory-quiet" data-assistant-memory-empty>
              {copy.empty}
            </p>
          )}
          {view.data.sources
            .filter(source => source.facts.length > 0 || forgotten[`source:${source.handle}`])
            .map(source => (
              <SourceGroup
                busy={busy}
                confirming={confirming === source.handle}
                copy={copy}
                date={date}
                editing={editing}
                forgotten={forgotten}
                key={source.handle}
                onCancel={() => setConfirming(null)}
                onConfirm={() => forget(`source:${source.handle}`, { kind: 'source', handle: source.handle })}
                onCorrect={(fact, text) => correct(fact, text)}
                onEdit={setEditing}
                onForget={fact => forget(fact.handle, { kind: 'fact', handle: fact.handle })}
                onForgetAll={() => setConfirming(source.handle)}
                onOpen={openSource}
                onRetry={(key, operation) => {
                  const fact = source.facts.find(each => each.handle === key)

                  if (operation.kind === 'correct' && fact) {
                    correct(fact, operation.text ?? fact.text, operation)
                  } else if (key === `source:${source.handle}`) {
                    forget(key, { kind: 'source', handle: source.handle }, operation)
                  } else if (fact) {
                    forget(key, { kind: 'fact', handle: fact.handle }, operation)
                  }
                }}
                openFailed={openFailed}
                operations={operations}
                source={source}
              />
            ))}
          {view.data.more && <p className="atum-memory-quiet">{copy.more}</p>}
          {view.data.receipts.length > 0 && (
            <section aria-label={copy.forgotten} className="atum-memory-group" data-assistant-memory-receipts>
              <h4 className="atum-memory-group-title">{copy.forgotten}</h4>
              <ul className="atum-memory-list">
                {view.data.receipts.map(receipt => {
                  const name = sourceName(copy, { kind: receipt.sourceKind, label: receipt.sourceLabel })

                  return (
                    <li className="atum-memory-fact" data-cleanup={receipt.cleanup.state} key={receipt.key}>
                      <div className="atum-memory-fact-main">
                        <p className="atum-memory-text">
                          {receipt.target === 'source' ? copy.forgottenSource(name) : copy.forgottenFact(name)}
                        </p>
                        <p className="atum-memory-meta">{cleanupWords(copy, receipt.cleanup, date)}</p>
                      </div>
                    </li>
                  )
                })}
              </ul>
            </section>
          )}
        </>
      )}
    </>
  )
}

function SourceGroup({
  busy,
  confirming,
  copy,
  date,
  editing,
  forgotten,
  onCancel,
  onConfirm,
  onCorrect,
  onEdit,
  onForget,
  onForgetAll,
  onOpen,
  onRetry,
  openFailed,
  operations,
  source
}: {
  busy: boolean
  confirming: boolean
  copy: AgentMemoryCopy
  date(value: number): string
  editing: { handle: string; draft: string } | null
  forgotten: Record<string, AgentMemoryCleanup>
  onCancel(): void
  onConfirm(): void
  onCorrect(fact: AgentMemoryFact, text: string): void
  onEdit(next: { handle: string; draft: string } | null): void
  onForget(fact: AgentMemoryFact): void
  onForgetAll(): void
  onOpen(fact: AgentMemoryFact): void
  onRetry(key: string, operation: Operation): void
  openFailed: string | null
  operations: Record<string, Operation>
  source: AgentMemorySource
}) {
  const name = sourceName(copy, source)
  const key = `source:${source.handle}`
  const whole = forgotten[key]
  const operation = operations[key]
  const coverage = source.coverage === 'complete' ? undefined : copy.coverage[source.coverage]

  if (whole) {
    return (
      <section aria-label={capital(name)} className="atum-memory-group" data-assistant-memory-source={source.handle} data-cleanup={whole.state}>
        <h4 className="atum-memory-group-title">{capital(name)}</h4>
        <p className="atum-memory-text">{copy.forgottenSource(name)}</p>
        <p className="atum-memory-meta">{cleanupWords(copy, whole, date)}</p>
      </section>
    )
  }

  return (
    <section aria-label={capital(name)} className="atum-memory-group" data-assistant-memory-source={source.handle}>
      <div className="atum-memory-group-head">
        <h4 className="atum-memory-group-title">
          {capital(name)}
          {coverage && <span className="atum-memory-coverage"> · {coverage}</span>}
        </h4>
        {!confirming && !operation && (
          <Button disabled={busy} onClick={onForgetAll} size="inline" variant="text">
            {copy.forgetAll}
          </Button>
        )}
      </div>
      {confirming && !operation && (
        <div className="atum-memory-confirm" role="group">
          <p>{copy.forgetAllConfirm(name)}</p>
          <div className="atum-memory-actions">
            <Button onClick={onCancel} size="sm" variant="text">
              {copy.cancel}
            </Button>
            <Button data-assistant-memory-forget-all onClick={onConfirm} size="sm" variant="destructive">
              {copy.forget}
            </Button>
          </div>
        </div>
      )}
      {operation && (
        <p className="atum-memory-meta" data-operation={operation.phase}>
          {operation.phase === 'failed' ? copy.forgetFailed : copy.forgetting}
          {operation.phase === 'failed' && (
            <>
              {' '}
              <Button onClick={() => onRetry(key, operation)} size="inline" variant="textStrong">
                {copy.retry}
              </Button>
            </>
          )}
        </p>
      )}
      <ul className="atum-memory-list">
        {source.facts.map(fact => (
          <FactRow
            busy={busy || Boolean(operation)}
            copy={copy}
            date={date}
            draft={editing?.handle === fact.handle ? editing.draft : null}
            fact={fact}
            forgotten={forgotten[fact.handle]}
            key={fact.handle}
            onCancelEdit={() => onEdit(null)}
            onCorrect={text => onCorrect(fact, text)}
            onDraft={draft => onEdit({ handle: fact.handle, draft })}
            onEdit={() => onEdit({ handle: fact.handle, draft: fact.text })}
            onForget={() => onForget(fact)}
            onOpen={() => onOpen(fact)}
            onRetry={next => onRetry(fact.handle, next)}
            openFailed={openFailed === fact.handle}
            operation={operations[fact.handle]}
          />
        ))}
      </ul>
    </section>
  )
}

function FactRow({
  busy,
  copy,
  date,
  draft,
  fact,
  forgotten,
  onCancelEdit,
  onCorrect,
  onDraft,
  onEdit,
  onForget,
  onOpen,
  onRetry,
  openFailed,
  operation
}: {
  busy: boolean
  copy: AgentMemoryCopy
  date(value: number): string
  draft: string | null
  fact: AgentMemoryFact
  forgotten?: AgentMemoryCleanup
  onCancelEdit(): void
  onCorrect(text: string): void
  onDraft(draft: string): void
  onEdit(): void
  onForget(): void
  onOpen(): void
  onRetry(operation: Operation): void
  openFailed: boolean
  operation?: Operation
}) {
  // Forgotten words are not shown again, only where the forget stands.
  if (forgotten) {
    return (
      <li className="atum-memory-fact" data-assistant-memory-fact={fact.handle} data-cleanup={forgotten.state}>
        <div className="atum-memory-fact-main">
          <p className="atum-memory-text atum-memory-gone">{copy.forgotten}</p>
          <p className="atum-memory-meta">{cleanupWords(copy, forgotten, date)}</p>
        </div>
      </li>
    )
  }

  if (draft !== null) {
    const text = draft.trim()
    const saving = operation?.kind === 'correct' && operation.phase !== 'failed'

    return (
      <li className="atum-memory-fact" data-assistant-memory-fact={fact.handle} data-editing>
        <form
          className="atum-memory-edit"
          onSubmit={event => {
            event.preventDefault()

            if (text && text !== fact.text.trim() && !saving) {
              onCorrect(text)
            }
          }}
        >
          <label className="ak-field">
            <textarea
              aria-label={copy.correct}
              autoFocus
              disabled={saving}
              maxLength={AGENT_MEMORY_CORRECTION_MAX}
              onChange={event => onDraft(event.currentTarget.value)}
              rows={2}
              value={draft}
            />
          </label>
          <div className="atum-memory-actions">
            <Button disabled={saving} onClick={onCancelEdit} size="sm" type="button" variant="text">
              {copy.cancel}
            </Button>
            <Button disabled={saving || !text || text === fact.text.trim()} size="sm" type="submit">
              {saving ? copy.correcting : copy.save}
            </Button>
          </div>
          {operation?.kind === 'correct' && operation.phase === 'failed' && (
            <p className="atum-memory-meta">
              {copy.correctFailed}{' '}
              <Button onClick={() => onRetry(operation)} size="inline" type="button" variant="textStrong">
                {copy.retry}
              </Button>
            </p>
          )}
        </form>
      </li>
    )
  }

  const working = operation && operation.phase !== 'failed' ? operation.kind : fact.correcting ? 'correct' : undefined

  return (
    <li
      aria-busy={working ? true : undefined}
      className="atum-memory-fact"
      data-assistant-memory-fact={fact.handle}
      data-operation={operation?.phase}
    >
      <div className="atum-memory-fact-main">
        <p className="atum-memory-text">{fact.text}</p>
        <p className="atum-memory-meta">
          {working === 'forget' ? (
            copy.forgetting
          ) : working === 'correct' ? (
            copy.correcting
          ) : operation?.phase === 'failed' ? (
            <>
              {operation.kind === 'forget' ? copy.forgetFailed : copy.correctFailed}{' '}
              <Button onClick={() => onRetry(operation)} size="inline" variant="textStrong">
                {copy.retry}
              </Button>
            </>
          ) : (
            <>
              <span>{date(fact.learnedAt)}</span>
              {fact.canOpen && (
                <>
                  <span aria-hidden> · </span>
                  <Button data-assistant-memory-open onClick={onOpen} size="inline" variant="textStrong">
                    {copy.open}
                  </Button>
                </>
              )}
              {openFailed && <span> · {copy.openFailed}</span>}
            </>
          )}
        </p>
      </div>
      {!working && (
        <DropdownMenu>
          <Tip label={copy.actions}>
            <DropdownMenuTrigger asChild>
              <button
                aria-label={copy.actions}
                className="ak-iconbtn ak-iconbtn--sm"
                data-assistant-memory-actions
                disabled={busy}
                type="button"
              >
                <MoreHorizontal aria-hidden className="ak-icon ak-icon--sm" />
              </button>
            </DropdownMenuTrigger>
          </Tip>
          {/* Above the card sheet, as the card's Skills popover is. */}
          <DropdownMenuContent align="end" className="z-[140]">
            <DropdownMenuItem onSelect={onEdit}>{copy.correct}</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onForget} variant="destructive">
              {copy.forget}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </li>
  )
}
