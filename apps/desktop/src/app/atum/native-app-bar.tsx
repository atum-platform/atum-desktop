import { useStore } from '@nanostores/react'

import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { AppWindow } from '@/lib/icons'
import { $documentContext } from '@/store/document-context'
import { $nativeApps, endNativeApp } from '@/store/native-apps'
import { $nativeDocument, currentNativeDocument } from '@/store/native-document'
import { $workbenchScope, resolveCaptureScope } from '@/store/workbench-tabs'

export function NativeAppBar() {
  const state = useStore($nativeApps)
  const scopeKey = useStore($workbenchScope)
  useStore($nativeDocument)
  const context = useStore($documentContext)
  const { t } = useI18n()
  const result = state.result
  // Like the Word bar, this is only a layout status. A saved file linked from
  // the composer may be A while this displayed app is B.
  const displayedContext = Boolean(state.documentPath && context?.identity.path === state.documentPath)

  if (!result || result.status !== 'beside' || resolveCaptureScope(scopeKey) !== resolveCaptureScope(state.scopeKey)) {return null}

  return (
    <div className="flex shrink-0 items-start gap-2 border-b border-(--atum-line) px-4 py-2 text-(length:--atum-t-caption) text-(--atum-ink) [-webkit-app-region:no-drag]" data-native-app-companion role="status">
      <AppWindow aria-hidden className="mt-0.5 size-4 shrink-0 text-(--atum-ink-muted)" />
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{state.documentPath?.split('/').pop() ?? result.app.name}</div>
        <p className="mt-0.5 text-(--atum-ink-muted)">{state.documentPath
          ? state.documentContextError || currentNativeDocument(scopeKey)?.captureError
            ? t.atum.workspace.launcherSavedFileUnavailable : displayedContext ? t.atum.workspace.launcherSavedFileContext : t.atum.workspace.launcherNoLiveContext
          : t.atum.workspace.launcherNoLiveContext}</p>
      </div>
      <Button onClick={() => void endNativeApp()} size="sm" variant="ghost">{t.atum.workspace.wordExit}</Button>
    </div>
  )
}
