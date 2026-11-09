import { useEffect, useRef, useState } from 'react'

import { LogTail } from '@/components/chat/log-tail'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { Spinner } from '@/lib/icons'

import {
  MATRIX_LOCAL_ACTIONS,
  type MatrixCommandCenterOpsClient,
  type MatrixLocalAction,
  type MatrixLocalActionStatus
} from '../../shared/matrix-command-center-ops'
import { matrixMaintenanceCopy } from '../../shared/matrix-command-center-ops-copy'

interface Props {
  client: MatrixCommandCenterOpsClient
  agentName: string
}

export function MatrixCommandCenterOps({ client, agentName }: Props) {
  const { locale } = useI18n()
  const c = matrixMaintenanceCopy[locale] ?? matrixMaintenanceCopy.en
  const [data, setData] = useState<Partial<Record<MatrixLocalAction, MatrixLocalActionStatus>>>({})
  const [message, setMessage] = useState<'cancelled' | 'failed' | 'timeout' | null>(null)
  const [busy, setBusy] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const generation = useRef(0)
  const inFlight = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [poll, setPoll] = useState<{ action: MatrixLocalAction; deadline: number; generation: number } | null>(null)
  useEffect(() => {
    const fence = generation
    const id = ++fence.current
    setData({})
    setMessage(null)
    setPoll(null)
    setBusy(true)
    inFlight.current = false
    void Promise.all(MATRIX_LOCAL_ACTIONS.map(action => client.status(action)))
      .then(values => {
        if (id === generation.current) {
          setData(Object.fromEntries(values.map(value => [value.action, value])))
        }
      })
      .catch(() => {
        if (id === generation.current) {
          setMessage('failed')
        }
      })
      .finally(() => {
        if (id === generation.current) {
          setBusy(false)
        }
      })

    return () => {
      fence.current++
      clearTimeout(timer.current)
    }
  }, [client, agentName, refresh])
  useEffect(() => {
    if (!poll) {
      return
    }

    let live = true

    const next = async () => {
      if (Date.now() >= poll.deadline) {
        if (live && poll.generation === generation.current) {
          setMessage('timeout')
          setPoll(null)
        }

        return
      }

      try {
        const value = await client.status(poll.action)

        if (!live || poll.generation !== generation.current) {
          return
        }

        setData(previous => ({ ...previous, [poll.action]: value }))

        if (value.state === 'running') {
          timer.current = setTimeout(() => void next(), 1200)
        } else {
          setPoll(null)
        }
      } catch {
        if (live && poll.generation === generation.current) {
          setMessage('failed')
          setPoll(null)
        }
      }
    }

    timer.current = setTimeout(() => void next(), 1200)

    return () => {
      live = false
      clearTimeout(timer.current)
    }
  }, [client, poll])

  const run = async (action: MatrixLocalAction) => {
    if (inFlight.current || busy || poll) {
      return
    }

    inFlight.current = true
    setBusy(true)
    setMessage(null)
    const id = generation.current

    try {
      const result = await client.run(action)

      if (id !== generation.current) {
        return
      }

      if (result.status === 'cancelled') {
        setMessage('cancelled')
      } else {
        setData(previous => ({ ...previous, [action]: result.value }))

        if (result.value.state === 'running') {
          setPoll({ action, deadline: Date.now() + 300000, generation: id })
        }
      }
    } catch {
      if (id === generation.current) {
        setMessage('failed')
      }
    } finally {
      if (id === generation.current) {
        inFlight.current = false
        setBusy(false)
      }
    }
  }

  const reveal = async () => {
    if (inFlight.current || busy) {
      return
    }

    inFlight.current = true
    setBusy(true)
    setMessage(null)
    const id = generation.current

    try {
      await client.revealBackup()
    } catch {
      if (id === generation.current) {
        setMessage('failed')
      }
    } finally {
      if (id === generation.current) {
        inFlight.current = false
        setBusy(false)
      }
    }
  }

  return (
    <section className="mt-8 border-t border-border pt-5" data-matrix-local-maintenance>
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{c.title}</h2>
        <Button
          disabled={busy || Boolean(poll)}
          onClick={() => setRefresh(value => value + 1)}
          size="sm"
          variant="secondary"
        >
          {c.refresh}
        </Button>
      </header>
      {message && (
        <p className="mt-3 text-sm" role={message === 'cancelled' ? 'status' : 'alert'}>
          {c[message]}
        </p>
      )}
      {MATRIX_LOCAL_ACTIONS.map(action => (
        <div className="mt-5 min-w-0 rounded-lg border border-border p-4" key={action}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="font-medium">{c[action]}</h3>
            <Button
              disabled={busy || Boolean(poll) || data[action]?.state === 'running'}
              onClick={() => void run(action)}
              size="sm"
            >
              {c.run} · {c[action]}
            </Button>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">{action === 'doctor' ? c.doctorHelp : c.backupHelp}</p>
          {data[action] ? (
            <p className="mt-3 text-sm" role="status">
              {c.states[data[action]!.state]}
            </p>
          ) : (
            <Spinner className="mt-3 size-5 animate-spin text-muted-foreground" label={c.loading} />
          )}
          {data[action]?.lines.length ? (
            <div className="mt-3 h-52 min-w-0 rounded-md border border-border p-2">
              <LogTail emptyLabel={c.states.unknown} lines={data[action]!.lines} />
            </div>
          ) : null}
          {data[action]?.truncated && <p className="mt-2 text-xs text-muted-foreground">{c.truncated}</p>}
          {action === 'backup' && data.backup?.backupAvailable && (
            <Button className="mt-3" disabled={busy} onClick={() => void reveal()} size="sm" variant="secondary">
              {c.reveal}
            </Button>
          )}
        </div>
      ))}
    </section>
  )
}
