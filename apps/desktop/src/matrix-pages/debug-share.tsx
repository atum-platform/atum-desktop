import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'

import {
  MATRIX_DEBUG_DESTINATIONS,
  type MatrixDebugClient,
  type MatrixDebugDestination,
  type MatrixDebugLabel,
  type MatrixDebugPreview,
  type MatrixDebugStatus
} from '../../shared/matrix-debug-share'
import { matrixDebugShareCopy } from '../../shared/matrix-debug-share-copy'

interface Props {
  client: MatrixDebugClient
  agentName: string
}

export function MatrixDebugSharing({ client, agentName }: Props) {
  const { locale } = useI18n()
  const c = matrixDebugShareCopy[locale] ?? matrixDebugShareCopy.en
  const [preview, setPreview] = useState<MatrixDebugPreview | null>(null)
  const [destination, setDestination] = useState<MatrixDebugDestination>('paste.rs')
  const [labels, setLabels] = useState<MatrixDebugLabel[]>(['report'])
  const [status, setStatus] = useState<MatrixDebugStatus | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [watch, setWatch] = useState(false)
  const generation = useRef(0)
  const inFlight = useRef(false)
  useEffect(() => {
    const id = ++generation.current
    setPreview(null)
    setStatus(null)
    setMessage('')
    setBusy(false)
    setWatch(false)
    inFlight.current = false
    void client
      .status()
      .then(value => {
        if (id === generation.current) {
          setStatus(value)
        }
      })
      .catch(() => {
        if (id === generation.current) {
          setMessage(c.failed)
        }
      })

    return () => {
      generation.current += 1
    }
  }, [client, agentName, c.failed])
  useEffect(() => {
    if (!watch) {
      return
    }

    const id = generation.current
    let live = true
    const deadline = Date.now() + 120_000
    let timer: ReturnType<typeof setTimeout>

    const poll = async () => {
      try {
        const value = await client.status()

        if (!live || id !== generation.current) {
          return
        }

        setStatus(value)

        if (value.state === 'running' && Date.now() < deadline) {
          timer = setTimeout(() => void poll(), 1500)
        } else {
          setWatch(false)
        }
      } catch {
        if (live && id === generation.current) {
          setMessage(c.failed)
          setWatch(false)
        }
      }
    }

    timer = setTimeout(() => void poll(), 1500)

    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [watch, client, c.failed])

  const run = async (action: () => Promise<void>) => {
    if (inFlight.current) {
      return
    }

    const id = generation.current
    inFlight.current = true
    setBusy(true)
    setMessage('')

    try {
      await action()
    } catch {
      if (id === generation.current) {
        setMessage(c.failed)
      }
    } finally {
      if (id === generation.current) {
        inFlight.current = false
        setBusy(false)
      }
    }
  }

  const capture = async () => {
    const id = generation.current
    const value = await client.preview()

    if (id === generation.current) {
      setPreview(value)
      setLabels(['report'])
      setStatus(null)
    }
  }

  const share = async () => {
    const id = generation.current
    let value: Awaited<ReturnType<MatrixDebugClient['upload']>>

    try {
      value = await client.upload(destination, labels)
    } catch (error) {
      if (id === generation.current) {
        setPreview(null)
      }

      throw error
    }

    if (id !== generation.current) {
      return
    }

    if (value.status === 'cancelled') {
      setMessage(c.cancelled)
    } else {
      setPreview(null)
      setStatus(value.value)
      setWatch(value.value.state === 'running')
    }
  }

  const check = async () => {
    const id = generation.current
    const value = await client.status()

    if (id === generation.current) {
      setStatus(value)
      setWatch(value.state === 'running')
    }
  }

  return (
    <section className="mt-8 min-w-0 border-t border-border pt-6" data-matrix-debug-share>
      <h2 className="font-medium">{c.title}</h2>
      <p className="mt-2 text-sm text-muted-foreground">{c.help}</p>
      <p className="mt-2 text-sm">{c.privacy}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button disabled={busy || status?.state === 'running'} onClick={() => void run(capture)} variant="outline">
          {c.preview}
        </Button>
        <Button disabled={busy} onClick={() => void run(check)} variant="outline">
          {c.status}
        </Button>
      </div>
      {preview && (
        <div className="mt-4 space-y-4">
          <label className="grid w-fit gap-1 text-sm">
            {c.destination}
            <select
              className="rounded-md border border-border bg-background p-2"
              disabled={busy}
              onChange={e => setDestination(e.target.value as MatrixDebugDestination)}
              value={destination}
            >
              {MATRIX_DEBUG_DESTINATIONS.map(d => (
                <option key={d}>{d}</option>
              ))}
            </select>
          </label>
          <p className="text-sm text-muted-foreground">
            {destination === 'paste.rs' ? c.pasteRetention : c.dpasteRetention}
          </p>
          {preview.files.map(file => (
            <div className="min-w-0" key={file.label}>
              <label className="flex items-center gap-2 text-sm">
                <input
                  checked={labels.includes(file.label)}
                  disabled={busy || file.label === 'report'}
                  onChange={e =>
                    setLabels(current =>
                      e.target.checked ? [...current, file.label] : current.filter(l => l !== file.label)
                    )
                  }
                  type="checkbox"
                />
                {file.label === 'report' ? c.report : file.label} · {file.bytes.toLocaleString(locale)} B
              </label>
              <pre
                className="mt-2 max-h-72 overflow-y-auto whitespace-pre-wrap break-all bg-muted p-3 text-xs"
                tabIndex={0}
              >
                {file.text}
              </pre>
            </div>
          ))}
          <Button disabled={busy || status?.state === 'running'} onClick={() => void run(share)}>
            {c.upload}
          </Button>
        </div>
      )}
      {busy && (
        <p className="mt-3 text-sm" role="status">
          {c.loading}
        </p>
      )}
      {message && (
        <p className="mt-3 text-sm" role="status">
          {message}
        </p>
      )}
      {status && (
        <div aria-live="polite" className="mt-4 text-sm">
          <p>
            {c[status.state]} {status.uncertainLabel ?? ''}
          </p>
          {status.destination && (
            <p className="mt-2 text-muted-foreground">
              {status.destination === 'paste.rs' ? c.pasteRetention : c.dpasteRetention}
            </p>
          )}
          {status.urls.map(item => (
            <div className="mt-3 flex min-w-0 flex-wrap items-center gap-2" key={item.label}>
              <span className="break-all">
                {item.label}: {item.url}
              </span>
              <Button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await client.open(item.label)
                  })
                }
                size="sm"
                variant="outline"
              >
                {c.open}
              </Button>
              <Button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const id = generation.current
                    await client.copy(item.label)

                    if (id === generation.current) {
                      setMessage(c.copied)
                    }
                  })
                }
                size="sm"
                variant="outline"
              >
                {c.copy}
              </Button>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
