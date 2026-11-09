import { useEffect, useRef, useState } from 'react'

import { LogTail } from '@/components/chat/log-tail'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { compactNumber } from '@/lib/format'
import { Spinner } from '@/lib/icons'

import {
  MATRIX_COMMAND_LOG_FILES,
  MATRIX_COMMAND_LOG_LEVELS,
  MATRIX_COMMAND_USAGE_DAYS,
  type MatrixCommandCenterClient,
  type MatrixCommandCurator,
  type MatrixCommandLogFile,
  type MatrixCommandLogLevel,
  type MatrixCommandLogs,
  type MatrixCommandStatus,
  type MatrixCommandUsage,
  type MatrixCommandUsageDays
} from '../../shared/matrix-command-center'
import { matrixCommandCenterCopy } from '../../shared/matrix-command-center-copy'
import type { MatrixCommandCenterOpsClient } from '../../shared/matrix-command-center-ops'
import type { MatrixCuratorClient } from '../../shared/matrix-curator'
import type { MatrixDebugClient } from '../../shared/matrix-debug-share'

import { MatrixCommandCenterOps } from './command-center-ops'
import { MatrixCuratorControls } from './curator'
import { MatrixDebugSharing } from './debug-share'

type Panel = 'status' | 'logs' | 'usage' | 'curator'
type Data =
  | { panel: 'status'; value: MatrixCommandStatus }
  | { panel: 'logs'; value: MatrixCommandLogs }
  | { panel: 'usage'; value: MatrixCommandUsage }
  | { panel: 'curator'; value: MatrixCommandCurator }
interface Props {
  curatorClient?: MatrixCuratorClient
  debugClient?: MatrixDebugClient
  client: MatrixCommandCenterClient
  agentName: string
  opsClient?: MatrixCommandCenterOpsClient
  onClose?: () => void
}

export function MatrixCommandCenter({ client, debugClient, agentName, curatorClient, opsClient, onClose }: Props) {
  const { locale } = useI18n()
  const c = matrixCommandCenterCopy[locale] ?? matrixCommandCenterCopy.en
  const [panel, setPanel] = useState<Panel>('status')
  const [file, setFile] = useState<MatrixCommandLogFile>('agent')
  const [level, setLevel] = useState<MatrixCommandLogLevel>('ALL')
  const [days, setDays] = useState<MatrixCommandUsageDays>(30)
  const [query, setQuery] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [data, setData] = useState<Data | null>(null)
  const [failed, setFailed] = useState(false)
  const generation = useRef(0)
  useEffect(() => {
    setQuery('')
  }, [client, agentName])
  useEffect(() => {
    const id = ++generation.current
    let live = true
    setData(null)
    setFailed(false)

    const load = async (): Promise<Data> => {
      if (panel === 'status') {
        return { panel, value: await client.status() }
      }

      if (panel === 'logs') {
        return { panel, value: await client.logs(file, level) }
      }

      if (panel === 'usage') {
        return { panel, value: await client.usage(days) }
      }

      return { panel, value: await client.curator() }
    }

    void load()
      .then(value => {
        if (live && id === generation.current) {
          setData(value)
        }
      })
      .catch(() => {
        if (live && id === generation.current) {
          setFailed(true)
        }
      })

    return () => {
      live = false
      generation.current += 1
    }
  }, [client, agentName, panel, file, level, days, refresh])
  const number = (value: number | null) => (value === null ? c.unknown : compactNumber(value))
  const yes = (value: boolean | null) => (value === null ? c.unknown : value ? c.yes : c.no)

  const row = (label: string, value: string) => (
    <div className="flex min-w-0 flex-wrap justify-between gap-2 border-b border-border py-3" key={label}>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words font-medium">{value}</dd>
    </div>
  )

  const selectClass = 'max-w-full rounded-md border border-border bg-background px-3 py-2 text-sm'

  return (
    <section className="flex h-full min-h-0 flex-1 flex-col overflow-y-auto p-5" data-matrix-command-center>
      <div className="mx-auto w-full min-w-0 max-w-3xl">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold">{c.title}</h1>
            <p className="mt-1 break-words text-sm text-muted-foreground">
              {agentName} · {c.help}
            </p>
          </div>
          <div className="flex gap-2">
            <Button onClick={() => setRefresh(value => value + 1)} size="sm" variant="secondary">
              {c.refresh}
            </Button>
            {onClose && (
              <Button onClick={onClose} size="sm" variant="ghost">
                {c.close}
              </Button>
            )}
          </div>
        </header>
        <nav aria-label={c.title} className="my-5 flex flex-wrap gap-2">
          {(['status', 'logs', 'usage', 'curator'] as const).map(item => (
            <Button
              aria-pressed={panel === item}
              key={item}
              onClick={() => setPanel(item)}
              size="sm"
              variant={panel === item ? 'secondary' : 'ghost'}
            >
              {c[item]}
            </Button>
          ))}
        </nav>
        {panel === 'logs' && (
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <label className="grid gap-1 text-sm">
              {c.file}
              <select
                aria-label={c.file}
                className={selectClass}
                onChange={e => setFile(e.target.value as MatrixCommandLogFile)}
                value={file}
              >
                {MATRIX_COMMAND_LOG_FILES.map(v => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-sm">
              {c.level}
              <select
                aria-label={c.level}
                className={selectClass}
                onChange={e => setLevel(e.target.value as MatrixCommandLogLevel)}
                value={level}
              >
                {MATRIX_COMMAND_LOG_LEVELS.map(v => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </label>
            <label className="grid min-w-0 flex-1 gap-1 text-sm">
              {c.search}
              <input
                aria-label={c.search}
                className={selectClass}
                maxLength={512}
                onChange={e => setQuery(e.target.value)}
                value={query}
              />
            </label>
          </div>
        )}
        {panel === 'usage' && (
          <div className="mb-4">
            <label className="grid w-fit gap-1 text-sm">
              {c.days}
              <select
                aria-label={c.days}
                className={selectClass}
                onChange={e => setDays(Number(e.target.value) as MatrixCommandUsageDays)}
                value={days}
              >
                {MATRIX_COMMAND_USAGE_DAYS.map(v => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </label>
            <p className="mt-3 text-sm text-muted-foreground">{c.usageHelp}</p>
          </div>
        )}
        {failed ? (
          <p role="alert">{c.failed}</p>
        ) : data === null ? (
          <Spinner className="mx-auto my-6 block size-5 animate-spin text-muted-foreground" label={c.loading} />
        ) : data.panel === 'status' ? (
          <dl>
            {row(c.version, data.value.version ?? c.unknown)}
            {row(
              c.gateway,
              data.value.gatewayRunning === null ? c.unknown : data.value.gatewayRunning ? c.running : c.stopped
            )}
            {row(c.activeSessions, number(data.value.activeSessions))}
            {data.value.components
              .filter(item => item.name !== 'gateway')
              .map(item =>
                row(
                  item.name === 'gateway'
                    ? c.gateway
                    : item.name === 'dashboard'
                      ? c.dashboard
                      : item.name === 'storage'
                        ? c.storage
                        : c.platforms,
                  c[item.status]
                )
              )}
          </dl>
        ) : data.panel === 'logs' ? (
          <>
            <div className="h-96 min-w-0 rounded-lg border border-border p-2">
              <LogTail
                emptyLabel={c.empty}
                lines={data.value.lines.filter(line => line.toLowerCase().includes(query.trim().toLowerCase()))}
              />
            </div>
            {data.value.truncated && <p className="mt-2 text-xs text-muted-foreground">{c.truncated}</p>}
          </>
        ) : data.panel === 'curator' ? (
          curatorClient ? (
            <MatrixCuratorControls agentName={agentName} client={curatorClient} />
          ) : (
            <dl>
              {row(c.enabled, yes(data.value.enabled))}
              {row(c.paused, yes(data.value.paused))}
              {row(c.interval, number(data.value.intervalHours))}
              {row(
                c.lastRun,
                !data.value.lastRunKnown
                  ? c.unknown
                  : data.value.lastRunAt
                    ? new Date(data.value.lastRunAt).toLocaleString(locale)
                    : c.noLastRun
              )}
            </dl>
          )
        ) : (
          <div>
            <dl>
              {row(c.sessions, number(data.value.totals.sessions))}
              {row(c.calls, number(data.value.totals.calls))}
              {row(c.input, number(data.value.totals.input))}
              {row(c.output, number(data.value.totals.output))}
            </dl>
            <h2 className="mb-2 mt-6 font-medium">{c.daily}</h2>
            {data.value.daily.length ? (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr>
                      <th>{c.days}</th>
                      <th>{c.input}</th>
                      <th>{c.output}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.value.daily.map(item => (
                      <tr className="border-b border-border" key={item.day}>
                        <td className="py-2">{item.day}</td>
                        <td>{number(item.input)}</td>
                        <td>{number(item.output)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">{c.empty}</p>
            )}
            <h2 className="mb-2 mt-6 font-medium">{c.models}</h2>
            {data.value.models.length ? (
              <dl>
                {data.value.models.map(item =>
                  row(item.name, `${c.input}: ${number(item.input)} · ${c.output}: ${number(item.output)}`)
                )}
              </dl>
            ) : (
              <p className="text-sm text-muted-foreground">{c.empty}</p>
            )}
          </div>
        )}
        {debugClient && <MatrixDebugSharing agentName={agentName} client={debugClient} />}
        {opsClient && <MatrixCommandCenterOps agentName={agentName} client={opsClient} />}
      </div>
    </section>
  )
}
