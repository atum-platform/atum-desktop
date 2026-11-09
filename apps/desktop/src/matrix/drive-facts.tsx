import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Progress } from '@/components/ui/progress'
import type { Locale } from '@/i18n'

import type { MatrixDriveIssue, MatrixDriveQuota, MatrixDriveView } from '../../shared/matrix-drive'

import { matrixDriveCopy } from './drive-copy'

const TASK_SPACE = 64 * 1024 * 1024

const QUOTA_FILL: Record<MatrixDriveQuota['state'], string> = {
  normal: 'bg-primary',
  nearing: 'bg-(--atum-warn)',
  critical: 'bg-(--atum-danger)',
  exceeded: 'bg-(--atum-danger)'
}

type DriveIssueCard = MatrixDriveIssue & { code: Exclude<MatrixDriveIssue['code'], 'excluded'> }

const ISSUE_ACTION: Record<DriveIssueCard['code'], 'folder' | 'retry'> = {
  drive_full: 'folder',
  conflicts: 'folder',
  errors: 'folder',
  signed_out: 'retry'
}

/** Skipped files are by design (private keys, .env, databases, code folders), not a sync failure:
 * the header shows them as a quiet note (`MatrixDriveSkippedNote`), never as an issue card. */
function isIssueCard(issue: MatrixDriveIssue): issue is DriveIssueCard {
  return issue.code !== 'excluded'
}

export interface MatrixDriveFactsProps {
  view: MatrixDriveView
  locale: Locale
  busy: boolean
  formatSize: (bytes: number) => string
  onReveal: () => void
  onRefresh: () => void
  onRetry: () => void
}

/** Engine facts are display data; aggregate issue IDs never become file handles. */
export function MatrixDriveFacts({
  view,
  locale,
  busy,
  formatSize,
  onReveal,
  onRefresh,
  onRetry
}: MatrixDriveFactsProps) {
  const copy = matrixDriveCopy[locale]
  const facts = copy.facts
  const numbers = new Intl.NumberFormat(locale)
  const progress = view.progress?.active && !view.factsStale && view.state === 'syncing' ? view.progress : undefined
  const quota = view.quota
  const issues = (view.issues ?? []).filter(isIssueCard)
  const full = quota?.state === 'exceeded' && !issues.some(issue => issue.code === 'drive_full')
  const shownIssues: DriveIssueCard[] = full ? [{ id: 'quota-full', code: 'drive_full' }, ...issues] : issues

  if (!progress && !quota && !shownIssues.length && !view.factsStale) {
    return null
  }

  let progressLine: string | undefined

  if (progress) {
    progressLine = (progress.files.total === 1 ? facts.progressOne : facts.progress)
      .replace('{done}', numbers.format(progress.files.done))
      .replace('{total}', numbers.format(progress.files.total))

    if (progress.etaSeconds !== null && progress.etaSeconds > 0) {
      const eta =
        progress.etaSeconds < 60
          ? facts.underMinute
          : progress.etaSeconds < 3600
            ? progress.etaSeconds === 60
              ? facts.aboutMinute
              : facts.aboutMinutes.replace('{count}', numbers.format(Math.ceil(progress.etaSeconds / 60)))
            : progress.etaSeconds === 3600
              ? facts.aboutHour
              : facts.aboutHours.replace('{count}', numbers.format(Math.ceil(progress.etaSeconds / 3600)))

      progressLine += `, ${eta}`
    }
  }

  const storage =
    quota && facts.storage.replace('{used}', formatSize(quota.used)).replace('{total}', formatSize(quota.total))

  return (
    <section className="mt-5 space-y-3" data-matrix-drive-facts>
      {view.factsStale && (
        <p className="text-(length:--atum-t-caption) text-(--atum-ink-muted)" data-matrix-drive-stale>
          {facts.stale}
        </p>
      )}
      {progress && (
        <div className="max-w-sm space-y-2" data-matrix-drive-progress>
          <p className="text-(length:--atum-t-ui) text-(--atum-ink)">{progressLine}</p>
          {progress.files.total > 0 && (
            <Progress
              aria-label={progressLine}
              aria-valuemax={progress.files.total}
              aria-valuenow={progress.files.done}
              fillClassName="motion-reduce:transition-none"
              size="sm"
              value={progress.files.done / progress.files.total}
            />
          )}
        </div>
      )}
      {quota && (
        <div className="max-w-sm space-y-2">
          <p className="text-(length:--atum-t-caption) text-(--atum-ink-muted)">{storage}</p>
          <Progress
            aria-label={facts.storageLabel}
            aria-valuemax={quota.total}
            aria-valuenow={Math.min(quota.used, quota.total)}
            aria-valuetext={storage}
            data-matrix-drive-quota={quota.state}
            fillClassName={`${QUOTA_FILL[quota.state]} motion-reduce:transition-none`}
            role="meter"
            size="sm"
            value={quota.total > 0 ? quota.used / quota.total : 0}
          />
          {quota.state !== 'exceeded' && quota.remaining < TASK_SPACE && (
            <p className="text-(length:--atum-t-caption) text-(--atum-ink-muted)">{facts.lowSpace}</p>
          )}
        </div>
      )}
      {shownIssues.length > 0 && (
        <ul className="divide-y divide-(--atum-line) rounded-(--atum-r-card) bg-(--atum-sunk) px-4">
          {shownIssues.map(issue => (
            <li
              className="flex flex-wrap items-center justify-between gap-x-5 gap-y-2 py-3"
              data-matrix-drive-issue={issue.code}
              key={`${issue.code}:${issue.id}`}
            >
              <div className="min-w-0">
                <p className="text-(length:--atum-t-ui) font-medium text-(--atum-ink)">
                  {facts.issues[issue.code].title}
                </p>
                <p className="mt-1 text-(length:--atum-t-caption) text-(--atum-ink-muted)">
                  {facts.issues[issue.code].body}
                </p>
                {'count' in issue && issue.count !== undefined && (
                  <p className="mt-1 text-(length:--atum-t-caption) text-(--atum-ink-muted)">
                    {issue.count === 1
                      ? facts.issueOne
                      : facts.issueCount.replace('{count}', numbers.format(issue.count))}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {ISSUE_ACTION[issue.code] === 'retry' ? (
                  <Button disabled={busy} onClick={onRetry} size="sm" variant="secondary">
                    {copy.retry}
                  </Button>
                ) : (
                  <>
                    <Button disabled={busy} onClick={onReveal} size="sm" variant="secondary">
                      {copy.reveal}
                    </Button>
                    <Button disabled={busy} onClick={onRefresh} size="sm" variant="text">
                      {copy.refresh}
                    </Button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export interface MatrixDriveSkippedNoteProps {
  view: MatrixDriveView
  locale: Locale
  busy: boolean
  onReveal: () => void
}

/** The files Drive skips on purpose, as a quiet note beside the header status ("7 files only on
 * this Mac"). One click explains why and offers the folder; it never looks like a failure. */
export function MatrixDriveSkippedNote({ view, locale, busy, onReveal }: MatrixDriveSkippedNoteProps) {
  const copy = matrixDriveCopy[locale]
  const skipped = view.issues?.find(issue => issue.code === 'excluded')
  const count = skipped?.count ?? 0

  if (!count) {
    return null
  }

  const label =
    count === 1 ? copy.facts.skipped.one : copy.facts.skipped.many.replace('{count}', new Intl.NumberFormat(locale).format(count))

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className="shrink-0 truncate rounded-(--ak-r-xs) [font:var(--ak-t-caption)] text-(--ak-ink-3) hover:text-(--ak-ink-2) hover:underline focus-visible:outline-2 focus-visible:outline-(--ak-focus)"
          data-matrix-drive-skipped={count}
          type="button"
        >
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-3">
        <p className="text-(length:--atum-t-caption) leading-[1.5] text-(--atum-ink-muted)">{copy.facts.issues.excluded.body}</p>
        <Button className="mt-2 -ms-2" disabled={busy} onClick={onReveal} size="sm" variant="text">
          {copy.reveal}
        </Button>
      </PopoverContent>
    </Popover>
  )
}
