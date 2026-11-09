import { useEffect, useRef, useState } from 'react'

import { StarMapCanvas } from '@/app/starmap/star-map-canvas'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { Spinner } from '@/lib/icons'
import type { StarmapGraph } from '@/types/hermes'

import type { MatrixStarmapClient } from '../../shared/matrix-starmap'
import { matrixStarmapCopy } from '../../shared/matrix-starmap-copy'

interface Props {
  client: MatrixStarmapClient
  agentName: string
  onClose?: () => void
}

export function MatrixStarmap({ client, agentName, onClose }: Props) {
  const { locale, t } = useI18n()
  const c = matrixStarmapCopy[locale] ?? matrixStarmapCopy.en
  const [graph, setGraph] = useState<StarmapGraph | null>(null)
  const [imported, setImported] = useState<StarmapGraph | null>(null)
  const [failed, setFailed] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const generation = useRef(0)
  useEffect(() => {
    const id = ++generation.current
    let live = true
    setGraph(null)
    setImported(null)
    setFailed(false)
    void client
      .graph()
      .then(value => {
        if (live && id === generation.current) {
          setGraph(value)
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
  }, [client, agentName, refresh])
  const shown = imported ?? graph

  return (
    <section className="flex h-full min-h-0 flex-col" data-matrix-starmap>
      <header className="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold">{c.title}</h1>
          <p className="mt-1 break-words text-sm text-muted-foreground">
            {agentName} · {c.help}
          </p>
          {imported && <p className="mt-1 text-xs text-muted-foreground">{t.starmap.importedBadge}</p>}
        </div>
        <div className="flex gap-2">
          <Button onClick={() => setRefresh(value => value + 1)} size="sm" variant="secondary">
            {t.starmap.refresh}
          </Button>
          {onClose && (
            <Button onClick={onClose} size="sm" variant="ghost">
              {t.common.close}
            </Button>
          )}
        </div>
      </header>
      {failed ? (
        <p className="px-5" role="alert">
          {t.starmap.loadFailed}
        </p>
      ) : shown === null ? (
        <Spinner className="mx-auto my-6 block size-5 animate-spin text-muted-foreground" label={t.starmap.loading} />
      ) : (
        <div className="relative flex min-h-0 flex-1 flex-col">
          {shown.nodes.length === 0 && (
            <div className="pointer-events-none absolute left-5 top-20 z-10 pr-5">
              <h2>{t.starmap.emptyTitle}</h2>
              <p className="mt-2 text-muted-foreground">{t.starmap.emptyDesc}</p>
            </div>
          )}
          <StarMapCanvas
            chrome={c}
            graph={shown}
            imported={imported !== null}
            onImport={setImported}
            onResetMap={() => setImported(null)}
          />
        </div>
      )}
    </section>
  )
}
