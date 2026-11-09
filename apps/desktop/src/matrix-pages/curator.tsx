import { useEffect, useRef, useState } from 'react'

import { LogTail } from '@/components/chat/log-tail'
import { Button } from '@/components/ui/button'
import { NoticeBand } from '@/components/ui/error-state'
import { useI18n } from '@/i18n'
import { Spinner } from '@/lib/icons'

import type { MatrixCuratorAction, MatrixCuratorClient, MatrixCuratorStatus } from '../../shared/matrix-curator'
import { matrixCuratorCopy } from '../../shared/matrix-curator-copy'

interface Props {
  agentName: string
  client: MatrixCuratorClient
}

export function MatrixCuratorControls({ agentName, client }: Props) {
  const { locale, t } = useI18n()
  const c = matrixCuratorCopy[locale] ?? matrixCuratorCopy.en
  const [data, setData] = useState<MatrixCuratorStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<'cancelled' | 'unavailable' | null>(null)
  const [refresh, setRefresh] = useState(0)
  const [poll, setPoll] = useState<{ generation: number; deadline: number } | null>(null)
  const generation = useRef(0)
  const inFlight = useRef(false)
  useEffect(() => {
    const fence = generation
    const id = ++fence.current
    setData(null)
    setMessage(null)
    setBusy(true)
    setPoll(null)
    inFlight.current = false
    void client
      .status()
      .then(value => {
        if (id === generation.current) {
          setData(value)

          if (value.run.state === 'running') {
            setPoll({ generation: id, deadline: Date.now() + 120_000 })
          }
        }
      })
      .catch(() => {
        if (id === generation.current) {
          setMessage('unavailable')
        }
      })
      .finally(() => {
        if (id === generation.current) {
          setBusy(false)
        }
      })

    return () => {
      fence.current++
    }
  }, [client, agentName, refresh])
  useEffect(() => {
    if (!poll) {
      return
    }

    let live = true
    let timer: ReturnType<typeof setTimeout>

    const next = async () => {
      if (!live || poll.generation !== generation.current) {
        return
      }

      if (Date.now() >= poll.deadline) {
        setMessage('unavailable')
        setPoll(null)

        return
      }

      try {
        const value = await client.status()

        if (!live || poll.generation !== generation.current) {
          return
        }

        setData(value)

        if (value.run.state === 'running') {
          timer = setTimeout(() => void next(), 1500)
        } else {
          setPoll(null)
        }
      } catch {
        if (live && poll.generation === generation.current) {
          setMessage('unavailable')
          setPoll(null)
        }
      }
    }

    timer = setTimeout(() => void next(), 1500)

    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [client, poll])

  const act = async (action: MatrixCuratorAction) => {
    if (inFlight.current || busy) {
      return
    }

    const id = generation.current
    inFlight.current = true
    setBusy(true)
    setPoll(null)
    setMessage(null)

    try {
      const value = await client.act(action)

      if (id !== generation.current) {
        return
      }

      if (value.status === 'cancelled') {
        setMessage('cancelled')
      } else {
        setData(value.value)
      }

      // Cancel leaves the existing run active, so resume bounded status reads.
      const running = value.status === 'completed' ? value.value.run.state === 'running' : data?.run.state === 'running'

      if (running) {
        setPoll({ generation: id, deadline: Date.now() + 120_000 })
      }
    } catch {
      if (id === generation.current) {
        setMessage('unavailable')
        setData(null)
      }
    } finally {
      if (id === generation.current) {
        inFlight.current = false
        setBusy(false)
      }
    }
  }

  return (
    <section data-matrix-curator>
      <h2 className="mb-2 font-medium">{c.title}</h2>
      <p className="mb-4 text-sm text-muted-foreground">{c.warning}</p>
      {data && (
        <>
          <p className="text-sm">{!data.enabled ? c.disabled : data.paused ? c.paused : c.active}</p>
          <dl className="mt-2 text-sm">
            <dt>{c.interval}</dt>
            <dd>{data.intervalHours?.toLocaleString(locale) ?? c.unknown}</dd>
            <dt>{c.lastRun}</dt>
            <dd>{data.lastRunAt ? new Date(data.lastRunAt).toLocaleString(locale) : c.never}</dd>
          </dl>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              disabled={busy || !data.enabled}
              onClick={() => void act(data.paused ? 'resume' : 'pause')}
              variant="outline"
            >
              {data.paused ? c.resume : c.pause}
            </Button>
            <Button disabled={busy || data.run.state === 'running'} onClick={() => void act('run')} variant="outline">
              {c.run}
            </Button>
          </div>
          <p className="mt-3 text-sm" role="status">
            {c[data.run.state]}
          </p>
        {data.run.lines.length > 0 && <LogTail className="mt-3" emptyLabel={c.unknown} lines={data.run.lines} />}
        </>
      )}
      <Button className="mt-4" disabled={busy} onClick={() => setRefresh(value => value + 1)} variant="outline">
        {c.refresh}
      </Button>
      {busy && <Spinner className="mt-3 size-4 animate-spin text-muted-foreground" label={t.common.loading} />}
      {message === 'unavailable' ? (
        <NoticeBand className="mt-3" role="status" tone="failure">
          {c.unavailable}
        </NoticeBand>
      ) : (
        message && (
          <p className="mt-3 text-sm" role="status">
            {c.cancelled}
          </p>
        )
      )}
    </section>
  )
}
