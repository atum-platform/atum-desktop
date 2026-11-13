import { useState } from 'react'

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useI18n } from '@/i18n'
import { ChevronRight, Cloud, DeviceDesktop } from '@/lib/icons'

import type { MatrixAgentView } from '../../shared/matrix'
import { matrixAgentAnswersInCloud } from '../../shared/matrix-agent-actions'
import type { MatrixAgentSourcesBridge } from '../../shared/matrix-agent-sources'

import { agentPlaceCopy } from './agent-place-copy'
import { openMatrixConnections } from './connections-request'
import { MatrixCanUseList, useMatrixReachMacs } from './mac-reach-rows'

function PlaceIcon({ className, kind }: { className?: string; kind: 'cloud' | 'mac' }) {
  const Icon = kind === 'cloud' ? Cloud : DeviceDesktop

  return <Icon aria-hidden className={className} strokeWidth={1.7} />
}

/**
 * The same "Lives on" row for an assistant without an authoritative home (U1 §2): where it
 * answers, read-only, and the Macs it can use. Every card shows the same row; nothing here moves it.
 */
export function MatrixAgentPlaceRow({
  agent,
  sources = window.atumMatrix?.agentSources
}: {
  agent: Pick<MatrixAgentView, 'answering' | 'macRole'>
  sources?: MatrixAgentSourcesBridge
}) {
  const { locale } = useI18n()
  const copy = agentPlaceCopy(locale)
  const [open, setOpen] = useState(false)
  const macs = useMatrixReachMacs(open, sources)
  const cloud = matrixAgentAnswersInCloud(agent)
  const place = cloud ? copy.cloudPlace : copy.thisMac

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <button className="atum-settings-row atum-settings-link" data-agent-home-row="read-only" data-assistant-card-place type="button">
          <span className="atum-settings-row-title shrink-0">{copy.rowTitle}</span>
          <span className="atum-card-row-value ms-auto" data-agent-home-value title={place}>
            {place}
          </span>
          <ChevronRight aria-hidden className="atum-settings-chevron" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label={copy.title}
        className="ak-glass ak-menu z-[140] w-80 max-w-[calc(100vw-1rem)] border-0 bg-transparent p-1.5"
        data-agent-home-popover
        sideOffset={8}
      >
        <div className="ak-menu-label">{copy.livesWhere}</div>
        <div className="flex items-center gap-2.5 px-2.5 pt-1 pb-2" data-agent-home-here>
          <span
            aria-hidden
            className="grid size-8 shrink-0 place-items-center rounded-full bg-(--ak-fill-quiet) text-(--ak-ink)"
          >
            <PlaceIcon className="size-[18px]" kind={cloud ? 'cloud' : 'mac'} />
          </span>
          <p className="min-w-0 flex-1 truncate [font:var(--ak-t-body-strong)] text-(--ak-ink)" data-agent-home-current>
            {place}
          </p>
        </div>
        {macs ? (
          <MatrixCanUseList
            emptyLabel={copy.noMac}
            label={copy.canUse}
            macs={macs}
            onFix={() => {
              setOpen(false)
              openMatrixConnections()
            }}
          />
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
