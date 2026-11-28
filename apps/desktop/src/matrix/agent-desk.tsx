import './agent-desk.css'

import { type FormEvent, useEffect, useLayoutEffect, useRef, useState } from 'react'

import { AtumAtom } from '@/components/brand/atum-atom'
import { NoticeBand } from '@/components/ui/error-state'
import { Switch } from '@/components/ui/switch'
import { useI18n } from '@/i18n'
import { phosphorIcon } from '@/lib/phosphor-icon'

import type { MatrixAgentView, MatrixMessage, MatrixRoom, MatrixSnapshot } from '../../shared/matrix'
import type { MatrixHostAgentControl, MatrixHostDeskFiles, MatrixHostDeskSchedule } from '../../shared/matrix-agent-desk'
import { matrixAgentDeskText } from '../../shared/matrix-agent-desk-copy'
import type { MatrixReachMac } from '../../shared/matrix-agent-sources'
import { matrixAgentStatusText } from '../../shared/matrix-agent-status-copy'
import { matrixKnowledgeSourcesCopy } from '../../shared/matrix-knowledge-sources-copy'

import {
  matrixAgentDeskDevices,
  matrixAgentDeskMinutes,
  type MatrixAgentDeskNow,
  matrixAgentDeskNow,
  matrixAgentDeskSentFiles,
  matrixAgentDeskSteers,
  type MatrixProgressStep
} from './agent-desk-model'
import { useAssistantCardCopy } from './assistant-card/copy'
import { ModelDestinationsRow } from './assistant-card/model-destinations-row'
import { openAssistantCard } from './assistant-card/store'
import { formatDriveSize } from './drive'
import { HermesPrompt } from './hermes-prompts'
import { matrixMacRowLine, MatrixMacState, useMatrixReachMacs } from './mac-reach-rows'
import { MatrixPersonAvatar } from './member-avatar'
import { roomAgentActivity } from './room-agent'
import { matrixRosterAgentName } from './roster-model'
import { runMatrixCommand } from './text-document-actions'
import type { MatrixCloudStop } from './use-cloud-stop'
import { useMatrixWorkbenchCopy } from './workbench-copy'

const ArrowLeftIcon = phosphorIcon('arrow-left')
const BellIcon = phosphorIcon('bell')
const CalendarIcon = phosphorIcon('calendar-blank')
const CaretIcon = phosphorIcon('caret-right')
const FolderIcon = phosphorIcon('folder-simple')
const PauseIcon = phosphorIcon('pause')
const SearchIcon = phosphorIcon('magnifying-glass')
const SlidersIcon = phosphorIcon('sliders-horizontal')
const CheckIcon = phosphorIcon('check')
const DesktopIcon = phosphorIcon('desktop')
const FileIcon = phosphorIcon('file')
const StopIcon = phosphorIcon('stop')

/** The agent's face at the size a tab chip or the ask's mark wants. */
export function MatrixAgentDeskFace({
  agent,
  className,
  name
}: {
  agent: MatrixAgentView
  className: string
  name: string
}) {
  return <MatrixPersonAvatar agent={agent} className={className} id={agent.userId} name={name} />
}

/** The agent's name as its roster row says it. */
export function useMatrixAgentDeskName(agent: MatrixAgentView): string {
  const { t } = useI18n()

  return matrixRosterAgentName(agent, t.matrixShell.assistantName)
}

/** Ticks once a minute while `on`, so "Working · 4 min" stays true without a snapshot. */
function useMinuteClock(on: boolean): number {
  const [now, setNow] = useState(Date.now)

  useEffect(() => {
    if (!on) {
      return
    }

    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 30_000)

    return () => clearInterval(timer)
  }, [on])

  return now
}

/**
 * Agent text, clamped to a few lines (`--atum-desk-clamp`, 3 by default) with More when it
 * overflows: a long step or ask never pushes the rest of the panel away.
 */
function Clamped({
  as: Tag = 'p',
  className,
  line,
  text
}: {
  as?: 'p' | 'span'
  className: string
  /** Marks the native progress line (the turn's own words). */
  line?: boolean
  text: string
}) {
  const { locale } = useI18n()
  const copy = matrixAgentDeskText(locale)
  const ref = useRef<HTMLElement>(null)
  const [open, setOpen] = useState(false)
  const [overflows, setOverflows] = useState(false)

  useLayoutEffect(() => {
    const node = ref.current

    if (!node || open) {
      return
    }

    // Half a line of slack: a font's ascenders can poke past one clamped line by a pixel or two.
    // Re-measured on resize: the panel opens with a width animation and can be dragged wider.
    const measure = () => {
      const line = Number.parseFloat(getComputedStyle(node).lineHeight)
      setOverflows(node.scrollHeight - node.clientHeight > (Number.isFinite(line) ? line / 2 : 1))
    }

    measure()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    observer?.observe(node)

    return () => observer?.disconnect()
  }, [open, text])

  return (
    <>
      <Tag
        className={className}
        data-agent-desk-clamp={open ? 'open' : 'closed'}
        data-agent-desk-line={line || undefined}
        ref={ref as never}
      >
        {text}
      </Tag>
      {(overflows || open) && (
        <button className="atum-desk-more" onClick={() => setOpen(value => !value)} type="button">
          {open ? copy.less : copy.more}
        </button>
      )}
    </>
  )
}

/**
 * The native todo checklist exactly as Hermes sent it (presentation plugin `post_tool_call`):
 * every item in order, ✓ done or • still to do, the chat's own step card. Only long items clamp.
 */
function Steps({ steps }: { steps: readonly MatrixProgressStep[] }) {
  if (!steps.length) {
    return null
  }

  return (
    <ul className="atum-desk-steps" data-agent-desk-steps>
      {steps.map((step, index) => (
        <li className="atum-desk-step" data-done={step.done || undefined} key={`${step.text}:${index}`}>
          {step.done ? (
            <CheckIcon aria-hidden className="ak-icon ak-icon--sm" />
          ) : (
            <span aria-hidden className="atum-desk-step-todo" />
          )}
          <Clamped as="span" className="atum-desk-step-text" text={step.text} />
        </li>
      ))}
    </ul>
  )
}

export interface MatrixAgentDeskStop {
  /** Stop is offered: a cloud turn names its question, or this room's local run is going. */
  available: boolean
  disabled: boolean
  stop(): void
}

/**
 * Stop for the desk, on the existing paths only: the composer's own cloud Stop (one hook: the
 * Shell host Stop route for a Hermes-runtime agent's owner or scheduled turn,
 * `stopTurn` on the old cloud path) and a Mac-run agent's own cancel. Both are this chat's turn only.
 *
 * Never the device host's Stop: its status says only that SOME grant is live and its Stop fences the
 * whole device (electron/matrix/device/runtime.ts), so from one agent's panel it would also interrupt
 * another agent using this Mac. That device-wide action stays in Settings › Device, labelled there.
 * Nothing is decided here; each path's owner refuses what it will not do.
 */
export function matrixAgentDeskStop({
  cloud,
  roomId,
  running
}: {
  cloud: MatrixCloudStop
  roomId: string
  running: boolean
}): MatrixAgentDeskStop {
  const available = cloud.shown || running

  return {
    available,
    disabled: cloud.shown && !cloud.ready,
    stop: () => {
      if (cloud.shown) {
        cloud.stop()
      } else if (running) {
        void window.atumMatrix.cancelHermes(roomId).catch(() => undefined)
      }
    }
  }
}

function StopButton({ label, stop }: { label: string; stop: MatrixAgentDeskStop }) {
  if (!stop.available) {
    return null
  }

  return (
    <div className="atum-desk-now-actions">
      <button className="ak-btn" data-agent-desk-stop disabled={stop.disabled} onClick={stop.stop} type="button">
        <StopIcon aria-hidden className="ak-icon ak-icon--sm" />
        {label}
      </button>
    </div>
  )
}

/**
 * Now, only while it works or waits: the native progress notice as Hermes sent it (its line,
 * its checklist) and Stop; the question and its action; idle → nothing at all. The head is a quiet caption; how a message steers or waits is a
 * tooltip on it, never a sentence on the panel.
 */
function NowBlock({
  name,
  now,
  steers,
  stop
}: {
  name: string
  now: MatrixAgentDeskNow
  /** A message sent now changes the running turn (otherwise it waits for it). */
  steers: boolean
  stop: MatrixAgentDeskStop
}) {
  const { locale } = useI18n()
  const copy = matrixAgentDeskText(locale)
  const clock = useMinuteClock(now.state !== 'free')
  const minutes = now.state === 'free' ? undefined : matrixAgentDeskMinutes(now.since, clock)
  const withTime = (head: string) => (minutes === undefined ? head : `${head} · ${copy.minutes(minutes)}`)

  // Idle is not news: no state word. The tab already names the agent.
  if (now.state === 'free') {
    return null
  }

  if (now.state === 'waiting') {
    return (
      <div className="atum-desk-now" data-agent-desk-now="waiting">
        <div className="atum-desk-now-head">
          <span aria-hidden className="ak-dot atum-desk-dot" />
          <span className="atum-desk-caption" role="status">
            {withTime(copy.waiting)}
          </span>
        </div>
        {now.prompts.length ? (
          // The chat's own ask, as it is: one object, its question and its buttons are the focus.
          <section aria-label={copy.ask(name)} className="atum-desk-ask">
            {now.prompts.map(prompt => (
              <HermesPrompt key={prompt.id} prompt={prompt} />
            ))}
          </section>
        ) : (
          <>
            {now.line && <Clamped className="atum-desk-focus" line text={now.line} />}
            <StopButton label={copy.stop} stop={stop} />
          </>
        )}
      </div>
    )
  }

  const head =
    now.state === 'device'
      ? now.device
        ? copy.onDevice(now.device)
        : copy.onThisMac
      : now.scheduled
        ? copy.routine
        : copy.working


  return (
    <div className="atum-desk-now" data-agent-desk-now={now.state}>
      <div
        className="atum-desk-now-head"
        data-agent-desk-hint={steers ? 'steer' : 'queue'}
        title={steers ? copy.steerHint : copy.queueHint}
      >
        <AtumAtom aria-hidden className="ak-icon ak-icon--sm text-(--ak-ink-3)" data-working />
        <span className="atum-desk-caption" role="status">
          {withTime(head)}
        </span>
      </div>
      {now.line && <Clamped className="atum-desk-focus" line text={now.line} />}
      <Steps steps={now.steps} />
      <StopButton label={copy.stop} stop={stop} />
    </div>
  )
}

/** A secondary section folded to one row: its name, a count, and a caret; it opens in place. */
function Fold({
  children,
  count,
  data,
  icon: Icon,
  initiallyOpen = false,
  label,
  mark,
  title
}: {
  children: React.ReactNode
  count: number
  data: Record<string, string | true>
  icon: typeof FileIcon
  initiallyOpen?: boolean
  label: string
  /** A small dot on the folded row when something inside wants a look (a missing permission). */
  mark?: boolean
  title?: string
}) {
  const [open, setOpen] = useState(initiallyOpen)

  return (
    <section aria-label={label} className="atum-desk-fold-section" {...data}>
      <button
        aria-expanded={open}
        className="ak-row atum-desk-fold-row"
        onClick={() => setOpen(value => !value)}
        title={title}
        type="button"
      >
        <Icon aria-hidden className="ak-icon" />
        <span className="ak-row-main">
          <span className="truncate">{label}</span>
        </span>
        {mark && <span aria-hidden className="ak-dot atum-desk-mark" />}
        <span className="atum-desk-row-end">{count}</span>
        <CaretIcon aria-hidden className="ak-icon ak-icon--sm atum-desk-caret" data-open={open || undefined} />
      </button>
      {open && (
        <div className="atum-desk-fold-body" role="list">
          {children}
        </div>
      )}
    </section>
  )
}

function DevicesSection({
  devices,
  focus,
  stop
}: {
  devices: ReturnType<typeof matrixAgentDeskDevices>
  /** One is in use: the section is the focus, open, right under Now. */
  focus: boolean
  stop: MatrixAgentDeskStop
}) {
  const { locale } = useI18n()
  const copy = matrixAgentDeskText(locale)
  const sources = matrixKnowledgeSourcesCopy[locale]
  const permissions = window.atumMatrix.permissions

  if (!devices.length) {
    return null
  }

  return (
    <Fold
      count={devices.length}
      data={{ 'data-agent-desk-devices': true }}
      icon={DesktopIcon}
      initiallyOpen={focus}
      key={focus ? 'focus' : 'rest'}
      label={copy.devices}
      mark={devices.some(each => each.mac.state === 'needs_permission')}
    >
      {devices.map(({ mac, inUse }) => (
        <DeviceRow
          inUse={inUse}
          key={mac.id}
          locale={locale}
          mac={mac}
          permissions={permissions}
          sources={sources}
          stop={stop}
          stopLabel={copy.stop}
          usingNow={copy.usingNow}
        />
      ))}
    </Fold>
  )
}

function DeviceRow({
  inUse,
  locale,
  mac,
  permissions,
  sources,
  stop,
  stopLabel,
  usingNow
}: {
  inUse: boolean
  locale: string
  mac: MatrixReachMac
  permissions: typeof window.atumMatrix.permissions
  sources: (typeof matrixKnowledgeSourcesCopy)[keyof typeof matrixKnowledgeSourcesCopy]
  stop: MatrixAgentDeskStop
  stopLabel: string
  usingNow: string
}) {
  const line = matrixMacRowLine(mac, sources, locale)
  const pane = line.action?.kind === 'settings' && permissions ? line.action.pane : undefined

  return (
    <div className="ak-row" data-agent-desk-device={inUse ? 'in-use' : mac.state} role="listitem">
      <DesktopIcon aria-hidden className="ak-icon" />
      <div className="ak-row-main">
        <span className="truncate">{mac.name}</span>
        {(inUse || line.help) && <span className="ak-row-meta">{inUse ? usingNow : line.help}</span>}
      </div>
      {inUse && stop.available ? (
        <button
          className="ak-btn ak-btn--sm"
          data-agent-desk-device-stop
          disabled={stop.disabled}
          onClick={stop.stop}
          type="button"
        >
          {stopLabel}
        </button>
      ) : pane && permissions ? (
        <button
          className="ak-btn ak-btn--sm"
          data-agent-desk-allow={pane}
          onClick={() => void permissions.openSettings(pane).catch(() => undefined)}
          type="button"
        >
          {sources.folderAccess.openSettings}
        </button>
      ) : (
        <span className="atum-desk-row-end">
          <MatrixMacState copy={sources} state={mac.state} />
        </span>
      )}
    </div>
  )
}

/** A file it sent in this chat (a Matrix file event), with Save. */
function SentFileRow({
  file,
  locale,
  roomId,
  save,
  saveShort
}: {
  file: MatrixMessage
  locale: string
  roomId: string
  save: string
  saveShort: string
}) {
  return (
    <div className="ak-row" data-agent-desk-file={file.id} role="listitem">
      <FileIcon aria-hidden className="ak-icon" />
      <span className="ak-row-main">
        <span className="truncate">{file.body}</span>
        <span className="ak-row-meta">
          {[
            file.attachmentSize !== undefined ? formatDriveSize(file.attachmentSize, locale) : undefined,
            relativeWhen(file.timestamp, locale)
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </span>
      <button
        aria-label={save}
        className="ak-btn ak-btn--sm"
        onClick={() => void window.atumMatrix.command({ kind: 'download', roomId, eventId: file.id }).catch(() => undefined)}
        type="button"
      >
        {saveShort}
      </button>
    </div>
  )
}

/** A short local time: today's hour, else the day. */
function relativeWhen(at: number, locale: string): string {
  const date = new Date(at)
  const today = new Date().toDateString() === date.toDateString()

  return new Intl.DateTimeFormat(locale, today ? { hour: 'numeric', minute: '2-digit' } : { day: 'numeric', month: 'short' }).format(date)
}

/** The same address bar the new tab has: a page typed here opens as its own tab. */
function AddressBar({ onOpen }: { onOpen(url: string): void }) {
  const copy = useMatrixWorkbenchCopy()
  const [address, setAddress] = useState('')

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const url = address.trim()

    if (url) {
      onOpen(url)
    }
  }

  return (
    <div className="shrink-0 px-(--ak-s6) pt-(--ak-s4)" data-matrix-new-tab-search>
      <form className="ak-field ak-field--search" data-matrix-workbench-navigation onSubmit={submit}>
        <SearchIcon aria-hidden className="ak-icon ak-icon--sm" />
        <input
          aria-label={copy.searchWeb}
          onChange={event => setAddress(event.target.value)}
          placeholder={copy.searchWeb}
          value={address}
        />
      </form>
    </div>
  )
}

/**
 * Its own files on its cloud computer (`agentDesk.read`, the host desk route), one folder at a
 * time. Listing only, never contents. A refusal or a window without the route reads as none.
 */
function useOwnFiles(active: boolean, agent: MatrixAgentView) {
  const desk = window.atumMatrix.agentDesk
  const [path, setPath] = useState<string>()
  const [view, setView] = useState<MatrixHostDeskFiles>()
  const [read, setRead] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!active || !desk || agent.runtime !== 'hermes') {
      return
    }

    let current = true
    setRead('loading')
    void desk
      .read(agent.principal, path === undefined ? { read: 'files' as const } : { read: 'files' as const, path })
      .then(
        next => {
          if (current) {
            setView(next)
            setRead('ready')
          }
        },
        () => {
          if (current) {
            setRead('failed')

            if (path === undefined) {
              setView(undefined)
            }
          }
        }
      )

    return () => {
      current = false
    }
  }, [active, agent.principal, agent.runtime, attempt, desk, path])

  return {
    path,
    setPath,
    view: view && (view.rows.length || path !== undefined) ? view : undefined,
    read,
    reload: () => setAttempt(each => each + 1),
    /** Its computer's files can be read (a native Hermes cloud agent). */
    hosted: Boolean(desk?.read && agent.runtime === 'hermes')
  }
}

function OwnFiles({ own }: { own: ReturnType<typeof useOwnFiles> }) {
  const { locale } = useI18n()
  const copy = matrixAgentDeskText(locale)
  const { path, setPath, view } = own

  if (!view) {
    return null
  }

  const parent = path?.split('/').slice(0, -1).join('/')

  return (
    <div className="atum-desk-own" data-agent-desk-own-files>
      <h3 className="atum-desk-subheading">{copy.onItsComputer}</h3>
      <div className="ak-group mt-2" role="list">
        {path !== undefined && (
          <button
            className="ak-row w-full text-left"
            onClick={() => setPath(parent && parent.includes('/') ? parent : undefined)}
            type="button"
          >
            <ArrowLeftIcon aria-hidden className="ak-icon" />
            <span className="ak-row-main">
              <span className="truncate">{copy.back}</span>
            </span>
          </button>
        )}
        {view.rows.map(row =>
          row.kind === 'folder' ? (
            <button
              aria-label={row.name}
              className="ak-row w-full text-left"
              key={`folder:${row.name}`}
              onClick={() => setPath(`${path ?? view.root}/${row.name}`)}
              type="button"
            >
              <FolderIcon aria-hidden className="ak-icon" />
              <span className="ak-row-main">
                <span className="truncate">{row.name}</span>
              </span>
              <CaretIcon aria-hidden className="ak-icon ak-icon--sm atum-desk-caret" />
            </button>
          ) : (
            <div className="ak-row" key={`file:${row.name}`} role="listitem">
              <FileIcon aria-hidden className="ak-icon" />
              <span className="ak-row-main">
                <span className="truncate">{row.name}</span>
                <span className="ak-row-meta">
                  {formatDriveSize(row.size, locale)} · {relativeWhen(row.modifiedAt, locale)}
                </span>
              </span>
            </div>
          )
        )}
      </div>
    </div>
  )
}

type Jobs = MatrixHostDeskSchedule['jobs']
type JobState = Jobs[number]['state']

const LIVE: ReadonlySet<JobState> = new Set(['scheduled', 'running'])

/** Paused when it has routines and none of them can start on its own. */
export function matrixAgentDeskPaused(jobs: Jobs | undefined, globallyPaused?: boolean): boolean {
  if (globallyPaused !== undefined) {
    return globallyPaused
  }

  return Boolean(jobs?.some(job => job.state === 'paused') && !jobs.some(job => LIVE.has(job.state)))
}

/** The shared Shell cooldown (10 s per agent schedule) answers a quick second request with 429. */
export const MATRIX_AGENT_CONTROL_RETRY_MS = 10_500

/**
 * Its native schedule as the host reads it (desk H1), plus its controls through the host
 * agent-control route: Pause / Resume (native cron pause, resume with no catch-up) and each
 * routine on or off. Every successful control re-reads native state. A busy reply
 * (the shared cooldown) is retried once after it.
 */
function useAgentSchedule(active: boolean, agent: MatrixAgentView) {
  const desk = window.atumMatrix.agentDesk
  const [snapshot, setSnapshot] = useState<MatrixHostDeskSchedule>()
  const [controlling, setControlling] = useState(false)
  const [problem, setProblem] = useState<'failed' | 'stopped'>()
  // Whether the last read of its schedule answered: a failed read says so instead of hiding Pause.
  const [read, setRead] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [attempt, setAttempt] = useState(0)
  const live = useRef(true)
  const reload = () => setAttempt(each => each + 1)

  useEffect(() => {
    live.current = true

    return () => {
      live.current = false
    }
  }, [])

  useEffect(() => {
    if (!active || !desk || agent.runtime !== 'hermes') {
      return
    }

    const refresh = () => setAttempt(each => each + 1)

    window.addEventListener('focus', refresh)
    window.addEventListener('matrix-native-routines-changed', refresh)

    return () => {
      window.removeEventListener('focus', refresh)
      window.removeEventListener('matrix-native-routines-changed', refresh)
    }
  }, [active, agent.runtime, desk])

  useEffect(() => {
    if (!active || !desk || agent.runtime !== 'hermes') {
      return
    }

    let current = true
    setRead('loading')
    void desk.read(agent.principal, { read: 'schedule', summary: true }).then(
      next => {
        if (current) {
          setSnapshot(next)
          setRead('ready')
        }
      },
      () => current && setRead('failed')
    )

    return () => {
      current = false
    }
  }, [active, agent.principal, agent.runtime, attempt, desk])

  const control = (request: MatrixHostAgentControl) => {
    const send = desk?.control

    if (!send || !snapshot?.jobs.length || controlling || read !== 'ready') {
      return
    }

    setProblem(undefined)
    setControlling(true)

    const attempt = (retry: boolean): Promise<void> =>
      send(agent.principal, request).then(
        () => {
          if (live.current) {
            setRead('loading')
            window.dispatchEvent(new Event('matrix-native-routines-changed'))
          }
        },
        (error: unknown) => {
          const code = error instanceof Error ? error.message : ''

          if (retry && code === 'matrix_host_control_busy') {
            return new Promise<void>(resolve => setTimeout(resolve, MATRIX_AGENT_CONTROL_RETRY_MS)).then(() =>
              live.current ? attempt(false) : undefined
            )
          }

          if (live.current) {
            setProblem(code === 'matrix_host_control_stopped' ? 'stopped' : 'failed')
          }
        }
      )

    void attempt(true).finally(() => {
      if (live.current) {
        setControlling(false)
      }
    })
  }

  return {
    jobs: snapshot?.jobs,
    globallyPaused: snapshot?.globallyPaused,
    remaining: snapshot?.remaining,
    truncated: snapshot?.truncated,
    problem,
    read,
    reload,
    hosted: Boolean(desk?.read && desk.control && agent.runtime === 'hermes'),
    canControl: Boolean(desk?.control && snapshot?.jobs.length),
    pending: controlling || read === 'loading',
    pause: () => control({ action: 'pause' }),
    resume: () => control({ action: 'resume' }),
    routine: (job: string, on: boolean) => control(on ? { action: 'routine_on', job } : { action: 'routine_off', job })
  }
}

/** Its routines, soonest first, each with its own switch when the host can change it. */
function Routines({ schedule }: { schedule: ReturnType<typeof useAgentSchedule> }) {
  const { locale } = useI18n()
  const copy = matrixAgentDeskText(locale)
  const { jobs } = schedule

  if (!schedule.hosted && !jobs?.length && !schedule.truncated) {
    return null
  }

  const when = (iso: string | null) => {
    if (!iso) {
      return undefined
    }

    return copy.nextRun(
      new Intl.DateTimeFormat(locale, { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(iso))
    )
  }

  return (
    <>
      <div className="atum-desk-subhead">{copy.routines}</div>
      <button className="ak-btn ak-btn--sm" disabled={schedule.pending} onClick={schedule.reload} type="button">
        {copy.refresh}
      </button>
      {jobs?.map(job => {
        const switchable = schedule.canControl && (LIVE.has(job.state) || job.state === 'paused')
        const switchedOff = job.state === 'paused' && job.pausedReason === 'owner_routine_off'
        // A switched-off routine already reads off on its own switch, so it adds nothing; every
        // other paused row keeps the word it always had, whether its reason is known or not.
        const next = switchedOff ? undefined : job.state === 'paused' ? copy.paused : when(job.nextRunAt)

        return (
          <div className="ak-row" data-agent-desk-routine={job.state} key={job.id} role="listitem">
            <CalendarIcon aria-hidden className="ak-icon" />
            <span className="ak-row-main">
              <span className="truncate">{job.name}</span>
              {next && <span className="ak-row-meta">{next}</span>}
            </span>
            {switchable && (
              <Switch
                aria-label={job.name}
                checked={job.state !== 'paused'}
                disabled={schedule.pending}
                onCheckedChange={on => schedule.routine(job.id, on)}
              />
            )}
          </div>
        )
      })}
      {schedule.truncated && (
        <p className="atum-desk-quiet" role="status">
          {copy.moreRoutines(schedule.remaining)}
        </p>
      )}
    </>
  )
}

/**
 * This chat's own notifications switch (Matrix push rules through the `mute` command), optimistic:
 * it flips at once and returns to the room's state if main refuses. One implementation for the
 * desk's Controls and the agent panel's Notifications row.
 */
export function useMatrixRoomMute(room: Pick<MatrixRoom, 'id' | 'muted'>) {
  const [muted, setMuted] = useState(Boolean(room.muted))

  useEffect(() => setMuted(Boolean(room.muted)), [room.muted])

  const toggle = (on: boolean) => {
    setMuted(!on)
    void runMatrixCommand({ kind: 'mute', roomId: room.id, muted: !on }).catch(() => setMuted(Boolean(room.muted)))
  }

  return { muted, toggle }
}

/**
 * Controls: the agent's settings that are real somewhere already. Notifications are this chat's
 * own mute (Matrix push rules); the model is the one picker row the agent's card uses; Pause is
 * native cron through the host (it still answers you and starts nothing on its own, said in a
 * tooltip); your devices fold to one row. Rare ones sit behind one More: its routines, each with
 * a switch, and the agent's card for everything else.
 */
function Controls({
  active,
  agent,
  devices,
  room,
  snapshot,
  stop
}: {
  active: boolean
  agent: MatrixAgentView
  devices: ReturnType<typeof matrixAgentDeskDevices>
  room: MatrixRoom
  snapshot: MatrixSnapshot
  stop: MatrixAgentDeskStop
}) {
  const { locale } = useI18n()
  const copy = matrixAgentDeskText(locale)
  const { muted, toggle } = useMatrixRoomMute(room)
  const [more, setMore] = useState(false)
  const schedule = useAgentSchedule(active, agent)
  const paused = matrixAgentDeskPaused(schedule.jobs, schedule.globallyPaused)

  return (
    <section aria-label={copy.controls} data-agent-desk-controls>
      <h2 className="atum-launcher-heading">{copy.controls}</h2>
      {agent.modelDestinations && (
        <div className="atum-settings-group mt-2 atum-desk-model" data-agent-desk-model>
          <ModelDestinationsRow
            agent={agent}
            cloudOnly
            preferenceScope={`account:${snapshot.identity?.userId ?? 'signed-out'}`}
          />
        </div>
      )}
      <div className="ak-group mt-2" role="list">
        {schedule.canControl && (
          <label className="ak-row" data-agent-desk-pause={paused ? 'paused' : 'running'} role="listitem" title={copy.pauseHint}>
            <PauseIcon aria-hidden className="ak-icon" />
            <span className="ak-row-main">
              <span className="truncate">{copy.pause}</span>
            </span>
            <Switch
              aria-label={copy.pause}
              checked={paused}
              disabled={schedule.pending}
              onCheckedChange={on => (on ? schedule.pause() : schedule.resume())}
            />
          </label>
        )}
        <label className="ak-row" role="listitem">
          <BellIcon aria-hidden className="ak-icon" />
          <span className="ak-row-main">
            <span className="truncate">{copy.notifications}</span>
          </span>
          <Switch aria-label={copy.notifications} checked={!muted} onCheckedChange={toggle} />
        </label>
        <DevicesSection devices={devices} focus={false} stop={stop} />
        <button
          aria-expanded={more}
          className="ak-row w-full text-left atum-desk-fold-row"
          onClick={() => setMore(value => !value)}
          type="button"
        >
          <SlidersIcon aria-hidden className="ak-icon" />
          <span className="ak-row-main">
            <span className="truncate">{copy.moreControls}</span>
          </span>
          <CaretIcon aria-hidden className="ak-icon ak-icon--sm atum-desk-caret" data-open={more || undefined} />
        </button>
        {more && (
          <div className="atum-desk-fold-body" role="list">
            <Routines schedule={schedule} />
            <button
              className="ak-row w-full text-left"
              onClick={() => openAssistantCard({ kind: 'agent', principal: agent.principal })}
              type="button"
            >
              <span className="ak-row-main">
                <span className="truncate">{copy.allSettings}</span>
              </span>
              <CaretIcon aria-hidden className="ak-icon ak-icon--sm atum-desk-caret" />
            </button>
          </div>
        )}
      </div>
      {schedule.problem && (
        <p className="atum-desk-quiet" role="status">
          {schedule.problem === 'stopped' ? copy.computerOff : copy.controlFailed}
        </p>
      )}
    </section>
  )
}

/**
 * The agent's own tab in its 1:1 chat's side panel (plan 2026-11-13, side panel r2, round 3).
 * Today's frame stays: the tab strip and the new tab's address bar and reading column; only the
 * content is the agent's. Now shows only while it works or waits; Files is an open list (what it
 * sent here, then its own files when the host shares them); Controls holds its real settings. No
 * money, no explanations, no second chat: steering is the composer.
 */
export interface MatrixAgentDeskInput {
  /** On screen: device and host reads run only then. */
  active: boolean
  agent: MatrixAgentView
  cloudStop: MatrixCloudStop
  room: MatrixRoom
  snapshot: MatrixSnapshot
}

/** What the desk knows of its agent right now: one read, for the desk tab and the agent's panel. */
export function useMatrixAgentDesk({ active, agent, cloudStop, room, snapshot }: MatrixAgentDeskInput) {
  const { locale } = useI18n()
  const name = useMatrixAgentDeskName(agent)
  const macs = useMatrixReachMacs(active)
  const running = roomAgentActivity(snapshot, room.id)?.state === 'running'
  const prompts = snapshot.agentTurns?.find(turn => turn.roomId === room.id)?.prompts

  const now = matrixAgentDeskNow({
    roomId: room.id,
    agentId: agent.userId,
    messages: snapshot.messages,
    typing: snapshot.typing,
    turns: snapshot.localTurns,
    running,
    ...(prompts ? { prompts } : {}),
    ...(cloudStop.target ? { stopTarget: cloudStop.target } : {}),
    terminalOpen: Boolean(snapshot.terminals?.some(tab => tab.open)),
    locale
  })

  const devices = matrixAgentDeskDevices(macs ?? [], now)
  const stop = matrixAgentDeskStop({ cloud: cloudStop, roomId: room.id, running })
  const deviceInUse = devices.some(each => each.inUse)
  const sent = matrixAgentDeskSentFiles(snapshot.messages, agent.userId)
  const steers = matrixAgentDeskSteers({ runtime: agent.runtime, running })

  return { name, now, devices, stop, deviceInUse, sent, steers }
}

export type MatrixAgentDeskState = ReturnType<typeof useMatrixAgentDesk>

export function MatrixAgentDesk({
  active,
  agent,
  browser,
  cloudStop,
  onOpenBrowser,
  room,
  snapshot
}: MatrixAgentDeskInput & {
  /** The window has its in-app browser: the address bar shows, as on the new tab. */
  browser: boolean
  onOpenBrowser(url: string): void
}) {
  const { locale, t } = useI18n()
  const copy = matrixAgentDeskText(locale)

  const { name, now, devices, stop, deviceInUse, sent, steers } = useMatrixAgentDesk({
    active,
    agent,
    cloudStop,
    room,
    snapshot
  })

  return (
    <div className="flex h-full min-h-0 flex-col" data-agent-desk-frame>
      {browser && <AddressBar onOpen={onOpenBrowser} />}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div
          aria-label={copy.desk(name)}
          className="atum-desk mx-auto flex max-w-[44rem] flex-col gap-8 px-6 pt-8 pb-8"
          data-agent-desk
          data-agent-desk-column
          role="region"
        >
          <NowBlock name={name} now={now} steers={steers} stop={stop} />
          {deviceInUse && <DevicesSection devices={devices} focus stop={stop} />}
          <FilesSection active={active} agent={agent} locale={locale} roomId={room.id} sent={sent} />
          <Controls
            active={active}
            agent={agent}
            devices={deviceInUse ? [] : devices}
            room={room}
            snapshot={snapshot}
            stop={stop}
          />
          {(cloudStop.refused || cloudStop.stopped) && (
            <NoticeBand role="status" tone="notice">
              {cloudStop.stopped ? matrixAgentStatusText('stopped', locale) : t.cloud.stopRefused}
            </NoticeBand>
          )}
        </div>
      </div>
    </div>
  )
}

/** Files: what it sent in this chat, then its own files when the host shares them. */
function FilesSection({
  active,
  agent,
  always = false,
  locale,
  roomId,
  sent
}: {
  active: boolean
  agent: MatrixAgentView
  /**
   * The agent's panel (owner 2026-11-27: "agent card don't see pause and files"): a cloud agent whose
   * computer can be read keeps its Files entry with nothing in it, saying so, or that the read failed.
   */
  always?: boolean
  locale: ReturnType<typeof useI18n>['locale']
  roomId: string
  sent: MatrixMessage[]
}) {
  const copy = matrixAgentDeskText(locale)
  const own = useOwnFiles(active, agent)
  const empty = !sent.length && !own.view

  if (empty && !(always && own.hosted)) {
    return null
  }

  return (
    <section aria-label={copy.files} data-agent-desk-files={empty ? own.read : ''}>
      <h2 className="atum-launcher-heading">{copy.files}</h2>
      {empty && own.read === 'ready' && <p className="atum-settings-row-help mt-2">{copy.noFiles}</p>}
      {empty && own.read === 'failed' && (
        <p className="atum-settings-row-help mt-2 flex items-center gap-2" role="status">
          <span>{copy.filesUnavailable}</span>
          <button className="ak-btn ak-btn--sm" data-agent-desk-files-retry onClick={own.reload} type="button">
            {copy.tryAgain}
          </button>
        </p>
      )}
      {sent.length > 0 && (
        <div className="ak-group mt-2" role="list" title={copy.sentHere}>
          {sent.map(file => (
            <SentFileRow
              file={file}
              key={file.id}
              locale={locale}
              roomId={roomId}
              save={copy.save(file.body)}
              saveShort={copy.saveShort}
            />
          ))}
        </div>
      )}
      <OwnFiles own={own} />
    </section>
  )
}

/**
 * The agent's panel (its card beside its chat) takes the desk's live parts as they are: Now only
 * while it works or waits (with the device in use under it), and Files only when there are some.
 */
export function MatrixAgentDeskNowSection({ cloudStop, desk }: { cloudStop: MatrixCloudStop; desk: MatrixAgentDeskState }) {
  const { locale, t } = useI18n()
  const notice = cloudStop.refused || cloudStop.stopped

  if (desk.now.state === 'free' && !desk.deviceInUse && !notice) {
    return null
  }

  return (
    <div className="atum-desk atum-card-section flex flex-col gap-4" data-agent-panel-now>
      <NowBlock name={desk.name} now={desk.now} steers={desk.steers} stop={desk.stop} />
      {desk.deviceInUse && <DevicesSection devices={desk.devices} focus stop={desk.stop} />}
      {notice && (
        <NoticeBand role="status" tone="notice">
          {cloudStop.stopped ? matrixAgentStatusText('stopped', locale) : t.cloud.stopRefused}
        </NoticeBand>
      )}
    </div>
  )
}

/** How many files the card shows before "Show all files". */
export const MATRIX_AGENT_CARD_FILES = 3

type CardFile =
  | { kind: 'sent'; at: number; file: MatrixMessage }
  | { kind: 'own'; at: number; row: MatrixHostDeskFiles['rows'][number] }

/**
 * Files on the agent's card, last (agent card revamp 2026-11-28): one list, the newest three across
 * what it sent in this chat and what is on its computer, then "Show all files · N", which opens the
 * full lists in place (Save on each sent file, folder browsing on its computer). A cloud agent whose
 * computer can be read always keeps the section (owner 2026-11-27): "No files yet.", or the failed
 * read with Try again.
 */
export function MatrixAgentDeskFiles({
  active,
  agent,
  desk,
  roomId
}: {
  active: boolean
  agent: MatrixAgentView
  desk: MatrixAgentDeskState
  roomId: string
}) {
  const { locale } = useI18n()
  const copy = matrixAgentDeskText(locale)
  const card = useAssistantCardCopy()
  const own = useOwnFiles(active, agent)
  const [all, setAll] = useState(false)
  const sent = desk.sent
  const root = own.path === undefined ? (own.view?.rows ?? []) : []

  const files: CardFile[] = [
    ...sent.map(file => ({ kind: 'sent' as const, at: file.timestamp, file })),
    ...root.map(row => ({ kind: 'own' as const, at: row.modifiedAt, row }))
  ].sort((a, b) => b.at - a.at)

  const empty = !sent.length && !own.view

  if (empty && !own.hosted) {
    return null
  }

  const download = (file: MatrixMessage) =>
    void window.atumMatrix.command({ kind: 'download', roomId, eventId: file.id }).catch(() => undefined)

  const openFolder = (name: string) => {
    if (own.view) {
      own.setPath(`${own.view.root}/${name}`)
    }

    setAll(true)
  }

  const retry = own.read === 'failed' && own.hosted && (
    <p className="atum-settings-section-foot flex items-center gap-2" role="status">
      <span>{copy.filesUnavailable}</span>
      <button className="ak-btn ak-btn--sm" data-agent-desk-files-retry onClick={own.reload} type="button">
        {copy.tryAgain}
      </button>
    </p>
  )

  return (
    <div className="atum-desk atum-card-section" data-agent-panel-files>
      <section aria-label={copy.files} data-agent-desk-files={empty ? own.read : ''}>
        <div className="atum-settings-section-head">
          <h3 className="ak-section atum-settings-section-title">{copy.files}</h3>
        </div>
        {empty && own.read === 'ready' && <p className="atum-settings-section-foot">{copy.noFiles}</p>}
        {all ? (
          <>
            {sent.length > 0 && (
              <div className="ak-group mt-2" role="list" title={copy.sentHere}>
                {sent.map(file => (
                  <SentFileRow
                    file={file}
                    key={file.id}
                    locale={locale}
                    roomId={roomId}
                    save={copy.save(file.body)}
                    saveShort={copy.saveShort}
                  />
                ))}
              </div>
            )}
            <OwnFiles own={own} />
            <div className="ak-group mt-2">
              <button
                className="ak-row w-full text-left"
                data-agent-card-files-less
                onClick={() => {
                  setAll(false)
                  own.setPath(undefined)
                }}
                type="button"
              >
                <span className="ak-row-main">
                  <span className="truncate">{copy.less}</span>
                </span>
              </button>
            </div>
          </>
        ) : (
          files.length > 0 && (
            <div className="ak-group mt-2" data-agent-card-files role="list">
              {files.slice(0, MATRIX_AGENT_CARD_FILES).map(item =>
                item.kind === 'sent' ? (
                  <button
                    aria-label={copy.save(item.file.body)}
                    className="ak-row w-full text-left"
                    data-agent-desk-file={item.file.id}
                    key={`sent:${item.file.id}`}
                    onClick={() => download(item.file)}
                    type="button"
                  >
                    <FileIcon aria-hidden className="ak-icon" />
                    <span className="ak-row-main">
                      <span className="truncate">{item.file.body}</span>
                      <span className="ak-row-meta">{card.fileSentHere(relativeWhen(item.at, locale))}</span>
                    </span>
                  </button>
                ) : item.row.kind === 'folder' ? (
                  <button
                    aria-label={item.row.name}
                    className="ak-row w-full text-left"
                    key={`folder:${item.row.name}`}
                    onClick={() => openFolder(item.row.name)}
                    type="button"
                  >
                    <FolderIcon aria-hidden className="ak-icon" />
                    <span className="ak-row-main">
                      <span className="truncate">{item.row.name}</span>
                      <span className="ak-row-meta">{copy.onItsComputer}</span>
                    </span>
                    <CaretIcon aria-hidden className="ak-icon ak-icon--sm atum-desk-caret" />
                  </button>
                ) : (
                  <div className="ak-row" key={`file:${item.row.name}`} role="listitem">
                    <FileIcon aria-hidden className="ak-icon" />
                    <span className="ak-row-main">
                      <span className="truncate">{item.row.name}</span>
                      <span className="ak-row-meta">
                        {copy.onItsComputer} · {relativeWhen(item.at, locale)}
                      </span>
                    </span>
                  </div>
                )
              )}
              {files.length > MATRIX_AGENT_CARD_FILES && (
                <button
                  className="ak-row w-full text-left"
                  data-agent-card-files-all
                  onClick={() => setAll(true)}
                  type="button"
                >
                  <span className="ak-row-main">
                    <span className="truncate">{card.filesShowAll}</span>
                  </span>
                  <span className="ak-row-meta">{files.length}</span>
                  <CaretIcon aria-hidden className="ak-icon ak-icon--sm atum-desk-caret" />
                </button>
              )}
            </div>
          )
        )}
        {retry}
      </section>
    </div>
  )
}

/** Each of your devices as the desk lists it: its state, Allow where a permission is missing, Stop while in use. */
export function MatrixAgentDeskDevices({ desk }: { desk: MatrixAgentDeskState }) {
  const { locale } = useI18n()
  const copy = matrixAgentDeskText(locale)
  const sources = matrixKnowledgeSourcesCopy[locale]
  const permissions = window.atumMatrix.permissions

  return (
    <div className="atum-desk" data-agent-panel-devices role="list">
      {desk.devices.map(({ mac, inUse }) => (
        <DeviceRow
          inUse={inUse}
          key={mac.id}
          locale={locale}
          mac={mac}
          permissions={permissions}
          sources={sources}
          stop={desk.stop}
          stopLabel={copy.stop}
          usingNow={copy.usingNow}
        />
      ))}
    </div>
  )
}

export { useAgentSchedule as useMatrixAgentSchedule }
