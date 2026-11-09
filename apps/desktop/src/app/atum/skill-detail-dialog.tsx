import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useI18n } from '@/i18n'
import { type AtumStoreSkillEntry, storeCopy } from '@/lib/atum-store-items'
import { Loader2 } from '@/lib/icons'

import { $atumAgents } from './agents'
import { PriceTag } from './price-tag'
import {
  $atumSkillRows,
  loadAtumSkillPreview,
  removeAtumSkill,
  tryAtumSkill
} from './skills'

/** The needs line at the moment of consent. Known needs get translated copy;
 *  a need this build does not know is shown as the catalog wrote it — bounded
 *  by main's validation — rather than silently dropped. */
export function skillNeedsCopy(needs: readonly string[], copy: ReturnType<typeof useI18n>['t']['atum']['discover']): string {
  if (needs.length === 0) {return copy.needsNothing}

  return needs.map(need => need === 'internet' ? copy.needsInternet : need === 'runs-scripts' ? copy.needsScripts : need).join(' · ')
}

export function SkillDetailDialog({
  entry,
  onAdd,
  onOpenChange,
  open
}: {
  entry: AtumStoreSkillEntry | null
  onAdd: (entry: AtumStoreSkillEntry) => void
  onOpenChange: (open: boolean) => void
  open: boolean
}) {
  const { locale, t } = useI18n()
  const agents = useStore($atumAgents)
  const rows = useStore($atumSkillRows)
  const row = entry ? rows.find(candidate => candidate.entry.identifier === entry.identifier) : undefined
  const [files, setFiles] = useState<string[] | null>(null)
  const [previewFailed, setPreviewFailed] = useState(false)
  const [choosing, setChoosing] = useState(false)
  const [target, setTarget] = useState<string | null>(null)
  const copy = t.atum.discover

  useEffect(() => {
    if (!open || !entry) {return}
    let current = true
    setFiles(null)
    setPreviewFailed(false)
    setChoosing(false)
    setTarget(null)
    void loadAtumSkillPreview(entry).then(
      result => { if (current) {setFiles(result.files)} },
      () => { if (current) {setPreviewFailed(true)} }
    )

    return () => { current = false }
  }, [entry, open])

  if (!entry) {return null}
  const installedIds = row?.installedFor ?? []
  const prompt = storeCopy(entry.tryPrompt, locale)

  const actTry = () => {
    if (installedIds.length === 1) {
      tryAtumSkill(prompt, installedIds[0]!, entry)
      onOpenChange(false)
    } else if (!choosing) {
      setChoosing(true)
      setTarget(installedIds[0] ?? null)
    } else if (target) {
      tryAtumSkill(prompt, target, entry)
      onOpenChange(false)
    }
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-[31rem] border-(--atum-line) bg-(--atum-card) text-(--atum-ink)" data-atum-skill-detail>
        <DialogHeader className="flex-row items-center gap-3 text-left">
          <span
            aria-hidden
            className="grid size-12 shrink-0 place-items-center rounded-[var(--atum-r-card)] text-[1.5rem]"
            style={{ background: entry.accent }}
          >
            {entry.glyph}
          </span>
          <span>
            <DialogTitle className="text-(--atum-ink)">{storeCopy(entry.name, locale)}</DialogTitle>
            <span className="text-(length:--atum-t-control) text-(--atum-ink-muted)">{storeCopy(entry.after, locale)}</span>
          </span>
        </DialogHeader>

        <p className="text-(length:--atum-t-body) font-medium text-(--atum-ink-muted)">{skillNeedsCopy(entry.needs, copy)}</p>
        <p className="text-(length:--atum-t-control) leading-[1.55] text-(--atum-ink-soft)">{storeCopy(entry.description, locale)}</p>
        <blockquote className="rounded-[var(--atum-r-row)] bg-(--atum-sunk) px-3 py-2.5 text-(length:--atum-t-control) text-(--atum-ink-muted)">
          {copy.tryExample(prompt)}
        </blockquote>

        {!entry.cloudProtected && <div>
          <h3 className="mb-1.5 text-(length:--atum-t-label) font-semibold uppercase tracking-[0.06em] text-(--atum-ink-faint)">{copy.filesIncluded}</h3>
          {files ? (
            <ul className="space-y-1 text-(length:--atum-t-caption) text-(--atum-ink-muted)">
              {files.map(file => <li key={file}>{file}</li>)}
            </ul>
          ) : previewFailed ? null : (
            <p className="text-(length:--atum-t-caption) text-(--atum-ink-muted)">{copy.previewLoading}</p>
          )}
        </div>}

        <div>
          <h3 className="mb-1.5 text-(length:--atum-t-label) font-semibold uppercase tracking-[0.06em] text-(--atum-ink-faint)">{copy.installedAssistants}</h3>
          {installedIds.length === 0 ? (
            <p className="text-(length:--atum-t-caption) text-(--atum-ink-muted)">{copy.noInstalledAssistants}</p>
          ) : (
            <div className="space-y-1" role={choosing ? 'radiogroup' : undefined}>
              {installedIds.map(id => {
                const agent = agents.find(candidate => candidate.id === id)
                const assistant = row?.assistants.find(candidate => candidate.agentId === id)
                const removing = assistant?.action === 'removing'

                return (
                  <div className="flex min-h-10 items-center gap-2 rounded-[var(--atum-r-row)] px-2" key={id}>
                    {choosing && <input checked={target === id} name="skill-detail-target" onChange={() => setTarget(id)} type="radio" />}
                    <span className="min-w-0 flex-1 text-(length:--atum-t-control)">{agent?.title || 'Atum'}</span>
                    {!choosing && !entry.cloudProtected && (
                      <button
                        aria-busy={removing || undefined}
                        className="text-(length:--atum-t-caption) text-(--atum-ink-muted) hover:text-(--atum-ink)"
                        disabled={removing || entry.cloudProtected}
                        onClick={() => void removeAtumSkill(entry, id)}
                        type="button"
                      >
                        {removing ? <><Loader2 aria-hidden className="size-4 animate-spin" /><span className="sr-only">{t.common.remove}</span></> : t.common.remove}
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <DialogFooter>
          {installedIds.length > 0 && agents.some(agent => agent.hostedId && agent.localProfileId !== null && !entry.trainedAssistantIds?.includes(agent.hostedId)) && (
            <button className="rounded-full px-4 py-2 text-(length:--atum-t-control) font-medium hover:bg-(--atum-hover)"
              onClick={() => { onOpenChange(false); onAdd(entry) }} type="button">{copy.trainAnother}</button>
          )}
          <button
            className="rounded-full bg-(--atum-ink) px-4 py-2 text-(length:--atum-t-control) font-medium text-(--atum-on-accent)"
            onClick={() => {
              if (installedIds.length === 0) {onOpenChange(false); onAdd(entry)} else {actTry()}
            }}
            type="button"
          >
            {installedIds.length === 0 ? (entry.owned ? copy.add : <PriceTag copy={copy} formatAmount={amount => new Intl.NumberFormat(locale).format(amount)} price={entry.price} />) : copy.try}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
