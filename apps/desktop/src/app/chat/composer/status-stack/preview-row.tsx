import { useStore } from '@nanostores/react'
import { memo, useState } from 'react'

import { StatusRow } from '@/components/chat/status-row'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { normalizeOrLocalPreviewTarget } from '@/lib/local-preview'
import { cn } from '@/lib/utils'
import { notifyError } from '@/store/notifications'
import { dismissPreviewResource, setCurrentSessionPreviewTarget } from '@/store/preview'
import { type PreviewArtifact } from '@/store/preview-status'
import { $workbenchTabs } from '@/store/workbench-tabs'

interface PreviewStatusRowProps {
  item: PreviewArtifact
  onDismiss: (id: string) => void
}

/** One detected artifact, single line, always visible: filename + open + close. */
export const PreviewStatusRow = memo(function PreviewStatusRow({ item, onDismiss }: PreviewStatusRowProps) {
  const { t } = useI18n()
  const tabs = useStore($workbenchTabs)
  const [opening, setOpening] = useState(false)
  const openRegistration = tabs.find(tab => tab.surface.kind === 'preview' && tab.surface.target.source === item.target)
  const isOpen = Boolean(openRegistration)

  const resolveTarget = async () => {
    const target = await normalizeOrLocalPreviewTarget(item.target, item.cwd || undefined)

    if (!target) {
      throw new Error(`Could not open preview target: ${item.target}`)
    }

    return target
  }

  const togglePreview = async () => {
    if (opening) {
      return
    }

    if (isOpen) {
      if (openRegistration?.surface.kind === 'preview') {
        dismissPreviewResource(openRegistration.scopeKey, openRegistration.surface.target)
      }

      return
    }

    setOpening(true)

    try {
      setCurrentSessionPreviewTarget(await resolveTarget(), 'tool-result', item.target)
    } catch (error) {
      notifyError(error, t.preview.unavailable)
    } finally {
      setOpening(false)
    }
  }

  const openInBrowser = async () => {
    try {
      const bridge = window.hermesDesktop?.openPreviewInBrowser

      if (!bridge) {
        throw new Error('Desktop preview browser bridge is unavailable')
      }

      await bridge((await resolveTarget()).url)
    } catch (error) {
      notifyError(error, t.preview.unavailable)
    }
  }

  return (
    <StatusRow
      leading={
        <Codicon
          aria-hidden
          className={cn('text-muted-foreground/70', opening && 'animate-pulse')}
          name="globe"
          size="0.8rem"
        />
      }
      // The visible result stays in the one-window demo path by default.
      // External browsing remains an explicit adjacent action.
      onActivate={() => void togglePreview()}
      trailing={
        <>
          <Tip label={t.preview.openInBrowser}>
            <Button
              aria-label={t.preview.openInBrowser}
              className="-my-1 size-4 rounded-md text-muted-foreground/60 hover:text-foreground/90"
              onClick={event => {
                event.stopPropagation()
                void openInBrowser()
              }}
              size="icon-xs"
              type="button"
              variant="ghost"
            >
              <Codicon name="link-external" size="0.75rem" />
            </Button>
          </Tip>
          <Tip label={t.statusStack.dismiss}>
            <Button
              aria-label={t.statusStack.dismiss}
              className="-my-1 size-4 rounded-md text-muted-foreground/60 hover:text-foreground/90"
              onClick={event => {
                event.stopPropagation()
                onDismiss(item.id)
              }}
              size="icon-xs"
              type="button"
              variant="ghost"
            >
              <Codicon name="close" size="0.75rem" />
            </Button>
          </Tip>
        </>
      }
      trailingVisible
    >
      <Tip
        label={
          // inline-flex (not flex): a block child collapses Tip's decoration
          // wrapper geometry and mis-positions the tooltip (#62022).
          <span className="inline-flex flex-col gap-0.5">
            <span>{item.target}</span>
            <span className="opacity-70">{isOpen ? t.preview.hide : t.preview.openPreview}</span>
          </span>
        }
      >
        <span className="min-w-0 max-w-[18rem] truncate text-[0.73rem] leading-4 text-foreground/92">{item.label}</span>
      </Tip>
    </StatusRow>
  )
})
