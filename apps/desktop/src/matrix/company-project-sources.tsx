import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'

import type {
  MatrixCompanyErrorCode,
  MatrixCompanyMutation,
  MatrixCompanyProjectReaderStatus,
  MatrixCompanyProjectSource,
  MatrixCompanyProjectSources
} from '../../shared/matrix-company'
import { matrixCompanyCopy } from '../../shared/matrix-company-copy'

export interface MatrixCompanyProjectSourcesProps {
  value: MatrixCompanyProjectSources
  admin: boolean
  blocked: boolean
  channelNames: Readonly<Record<string, string>>
  onMutation(mutation: MatrixCompanyMutation): void
  readerStatus?: MatrixCompanyProjectReaderStatus
  readerStatusLoading?: boolean
  readerStatusError?: MatrixCompanyErrorCode
  onRetryReader?(): void
}

function sourceLabel(source: MatrixCompanyProjectSource, value: MatrixCompanyProjectSources,
  channelNames: Readonly<Record<string, string>>, fallback: string): string {
  if (source.kind === 'company_file') {return source.file.name}

  return channelNames[source.channelId] ??
    value.eligibleChannels.find(channel => channel.channelId === source.channelId)?.displayName ?? fallback
}

/** T3b1 configuration only: source pointers and pending coverage, never evidence or a generated brief. */
export function MatrixCompanyProjectSourcesPanel({ value, admin, blocked, channelNames, onMutation,
  readerStatus, readerStatusLoading = false, readerStatusError, onRetryReader }: MatrixCompanyProjectSourcesProps) {
  const { locale } = useI18n()
  const copy = matrixCompanyCopy(locale)
  const activeChannel = value.sources.find(source => source.kind === 'channel' && source.state === 'active')
  const activeFile = value.sources.find(source => source.kind === 'company_file' && source.state === 'active')
  const channelHistory = new Set(value.sources.filter(source => source.kind === 'channel').map(source => source.channelId))
  const fileHistory = new Set(value.sources.flatMap(source => source.kind === 'company_file' ? [source.file.file_id] : []))
  const currentReader = readerStatus?.companyId === value.companyId && readerStatus.projectId === value.projectId &&
    readerStatus.authorityGeneration === value.authorityGeneration && readerStatus.sourceGeneration === value.sourceGeneration
    ? readerStatus : undefined
  const coverage = currentReader?.coverage
  const coverageLabel = readerStatusError ? copy.readerUnavailable
    : readerStatusLoading && !currentReader ? copy.readerLoading
      : coverage ? copy.readerCoverage(coverage.state)
        : value.coverage.state === 'pending' ? copy.sourcesPending : copy.sourcesEmpty
  const lastIngestedAt = coverage && 'lastIngestedAt' in coverage ? coverage.lastIngestedAt : undefined

  return (
    <div className="grid gap-3 rounded-(--atum-r-control) border border-(--atum-line) p-3" data-matrix-company-project-sources>
      <div className="grid gap-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h5 className="text-sm font-semibold text-(--atum-ink)">{copy.projectSources}</h5>
          <span className="text-xs text-(--atum-ink-muted)" role="status">
            {coverageLabel}
          </span>
        </div>
        <p className="text-xs text-(--atum-ink-muted)">{copy.projectSourcesDescription}</p>
        {coverage && (coverage.state === 'paused' || coverage.state === 'attention') && (
          <p className="text-xs text-(--atum-ink-muted)">{copy.readerGap(coverage.gapCode)}</p>
        )}
        {lastIngestedAt && (
          <p className="text-xs text-(--atum-ink-muted)">
            {copy.lastIngested(new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' })
              .format(new Date(lastIngestedAt)))}
          </p>
        )}
        {readerStatusError && onRetryReader && (
          <Button disabled={blocked || readerStatusLoading} onClick={onRetryReader} size="sm" variant="text">
            {copy.retry}
          </Button>
        )}
      </div>

      <div className="grid gap-1">
        <h6 className="text-xs font-semibold text-(--atum-ink)">{copy.selectedSources}</h6>
        {value.sources.length === 0 ? <p className="text-sm text-(--atum-ink-muted)">{copy.noSelectedSources}</p> : (
          <ul aria-label={copy.selectedSources} className="grid gap-1">
            {value.sources.map(source => {
              const label = sourceLabel(source, value, channelNames, copy.unknownSource)

              return <li className="flex flex-wrap items-center justify-between gap-2 text-sm" key={source.id}>
                <span className={source.state === 'withdrawn' ? 'text-(--atum-ink-muted)' : 'text-(--atum-ink)'}>
                  {source.kind === 'channel' ? '# ' : ''}{label} · {source.state === 'active' ? copy.sourceSelected : copy.sourceWithdrawn}
                </span>
                {admin && source.state === 'active' && (
                  <Button
                    aria-label={`${copy.removeSource} ${source.kind === 'channel' ? '# ' : ''}${label}`}
                    disabled={blocked}
                    onClick={() => onMutation({ action: 'withdraw-project-source', companyId: value.companyId,
                      projectId: value.projectId, requestId: globalThis.crypto.randomUUID(), sourceId: source.id,
                      expectedSourceGeneration: value.sourceGeneration })}
                    size="sm"
                    variant="text"
                  >
                    {copy.removeSource}
                  </Button>
                )}
              </li>
            })}
          </ul>
        )}
      </div>

      <div className="grid gap-1">
        <h6 className="text-xs font-semibold text-(--atum-ink)">{copy.availableSources}</h6>
        {value.eligibleChannels.length === 0 && value.eligibleFiles.length === 0 ? (
          <p className="text-sm text-(--atum-ink-muted)">{copy.noAvailableSources}</p>
        ) : (
          <ul aria-label={copy.availableSources} className="grid gap-1">
            {value.eligibleChannels.map(channel => {
              const selected = activeChannel?.channelId === channel.channelId
              const withdrawn = !selected && channelHistory.has(channel.channelId)

              return <li className="flex flex-wrap items-center justify-between gap-2 text-sm" key={`channel:${channel.channelId}`}>
                <span className="text-(--atum-ink)"># {channel.displayName} · {selected ? copy.sourceSelected : withdrawn ? copy.sourceWithdrawn : copy.sourceAvailable}</span>
                {admin && !activeChannel && !withdrawn && (
                  <Button
                    aria-label={`${copy.addSource} # ${channel.displayName}`}
                    disabled={blocked}
                    onClick={() => onMutation({ action: 'include-project-channel-source', companyId: value.companyId,
                      projectId: value.projectId, requestId: globalThis.crypto.randomUUID(), channelId: channel.channelId,
                      expectedSourceGeneration: value.sourceGeneration })}
                    size="sm"
                    variant="text"
                  >
                    {copy.addSource}
                  </Button>
                )}
              </li>
            })}
            {value.eligibleFiles.map(item => {
              const selected = activeFile?.kind === 'company_file' && activeFile.file.file_id === item.file.file_id
              const withdrawn = !selected && fileHistory.has(item.file.file_id)

              return <li className="flex flex-wrap items-center justify-between gap-2 text-sm" key={`file:${item.file.file_id}`}>
                <span className="text-(--atum-ink)">{item.file.name} · {selected ? copy.sourceSelected : withdrawn ? copy.sourceWithdrawn : copy.sourceAvailable}</span>
                {admin && !activeFile && !withdrawn && (
                  <Button
                    aria-label={`${copy.addSource} ${item.file.name}`}
                    disabled={blocked}
                    onClick={() => onMutation({ action: 'include-project-file-source', companyId: value.companyId,
                      projectId: value.projectId, requestId: globalThis.crypto.randomUUID(), fileId: item.file.file_id,
                      revision: 1, expectedSourceGeneration: value.sourceGeneration })}
                    size="sm"
                    variant="text"
                  >
                    {copy.addSource}
                  </Button>
                )}
              </li>
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
