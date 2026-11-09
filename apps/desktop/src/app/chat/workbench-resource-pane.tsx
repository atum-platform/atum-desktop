import { useStore } from '@nanostores/react'

import { isChatDocumentTarget, reopenChatDocument } from '@/app/atum/chat-documents'
import { FileContextCard } from '@/app/atum/file-context-card'
import { AtumPdfPane } from '@/app/atum/pdf-pane'
import { PreviewPane } from '@/app/chat/right-rail/preview-pane'
import { WorkspaceTextFilePane } from '@/app/chat/workspace-text-file-pane'
import { $restartPreviewServer, setTitlebarToolGroup } from '@/app/contrib/panes'
import { registerPaneCloser, removeTreePane, treePanesWithPrefix } from '@/components/pane-shell/tree/store'
import { Button } from '@/components/ui/button'
import { registry } from '@/contrib/registry'
import { useI18n } from '@/i18n'
import {
  $atumDmArtifactByConversation,
  type AtumArtifactPanelState,
  closeAtumDmArtifact,
  resolveAtumDmArtifact
} from '@/store/atum-dm-workspace'
import { atumFileViewToken, isAtumFileViewTarget } from '@/store/atum-file-views'
import { $atumShellEnabled } from '@/store/atum-shell'
import { $previewReloadRequest, dismissPreviewResource } from '@/store/preview'
import { $workbenchTabs, closeWorkbenchTab, type WorkbenchTabRegistration } from '@/store/workbench-tabs'
import { isWorkspaceTextFileTarget, requestCloseWorkspaceTextFileTab, workspaceTextFilePaneId } from '@/store/workspace-text-files'

function ArtifactState({
  conversationId,
  state
}: {
  conversationId: string
  state: Exclude<AtumArtifactPanelState, 'ready'>
}) {
  const { t } = useI18n()
  const copy = t.dm.artifact.state[state === 'idle' ? 'loading' : state]
  const retryable = ['offline', 'missing', 'error', 'waiting'].includes(state)

  return (
    <div className="grid h-full place-items-center px-5 text-center">
      <div>
        <p className="font-medium">{copy.title}</p>
        <p className="text-(--ui-text-tertiary)">{copy.body}</p>
        {retryable && (
          <Button className="mt-2" onClick={() => void resolveAtumDmArtifact(conversationId)}>
            {t.dm.artifact.retry}
          </Button>
        )}
      </div>
    </div>
  )
}

function ArtifactWorkbenchPane({ registration }: { registration: WorkbenchTabRegistration }) {
  const workspaces = useStore($atumDmArtifactByConversation)

  if (registration.surface.kind !== 'artifact') {
    return null
  }

  const { conversationId, resourceId } = registration.surface
  const tab = workspaces[conversationId]?.tabs.find(candidate => candidate.ref.resourceId === resourceId)

  if (!tab) {
    return null
  }

  return tab.state === 'ready' && tab.target ? (
    <PreviewPane embedded restricted setTitlebarToolGroup={setTitlebarToolGroup} target={tab.target} />
  ) : (
    <ArtifactState conversationId={conversationId} state={tab.state === 'ready' ? 'error' : tab.state} />
  )
}

function PreviewWorkbenchPane({ registration }: { registration: WorkbenchTabRegistration }) {
  const reloadRequest = useStore($previewReloadRequest)
  const restartPreviewServer = useStore($restartPreviewServer)

  if (registration.surface.kind !== 'preview') {
    return null
  }

  const target = registration.surface.target

  if (target.previewKind === 'card') {return <FileContextCard target={target} />}

  if (isWorkspaceTextFileTarget(target)) {
    const scopeKey = registration.scopeKey

    return (
      <WorkspaceTextFilePane
        reopenDocument={
          isChatDocumentTarget(target) ? async () => void (await reopenChatDocument(scopeKey, target)) : undefined
        }
        scopeKey={scopeKey}
        tab={{ id: workspaceTextFilePaneId(target.workspaceTextFile.fileRef), target }}
      />
    )
  }

  if (isAtumFileViewTarget(target)) {
    const token = atumFileViewToken(target)

    return token ? <AtumPdfPane sourcePath={target.source} title={target.label} token={token} /> : null
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        <PreviewPane
          embedded
          onRestartServer={restartPreviewServer ?? undefined}
          reloadRequest={reloadRequest}
          scopeKey={registration.scopeKey}
          setTitlebarToolGroup={setTitlebarToolGroup}
          target={registration.surface.target}
        />
      </div>
    </div>
  )
}

export function WorkbenchResourcePane({ id }: { id: string }) {
  const tabs = useStore($workbenchTabs)
  const registration = tabs.find(tab => tab.id === id)

  if (!registration) {
    return null
  }

  if (registration.surface.kind === 'artifact') {
    return <ArtifactWorkbenchPane registration={registration} />
  }

  if (registration.surface.kind === 'preview') {
    return <PreviewWorkbenchPane registration={registration} />
  }

  return null
}

export function closeWorkbenchRegistration(registration: WorkbenchTabRegistration): void {
  if (registration.surface.kind === 'artifact') {
    closeAtumDmArtifact(registration.surface.conversationId, registration.surface.resourceId)

    return
  }

  if (registration.surface.kind === 'preview') {
    const { target } = registration.surface

    if (isWorkspaceTextFileTarget(target)) {
      // Dirty-close guard first; the lease is released only once the pane
      // agrees, and the tab follows.
      void requestCloseWorkspaceTextFileTab(target.workspaceTextFile.fileRef).then(closed => {
        if (closed) {dismissPreviewResource(registration.scopeKey, target)}
      })

      return
    }

    dismissPreviewResource(registration.scopeKey, target)

    return
  }

  closeWorkbenchTab(registration.id)
}

export function watchWorkbenchResourceTabs(): void {
  const registered = new Map<string, { dispose: () => void; registration: WorkbenchTabRegistration }>()

  const sync = () => {
    const tabs = $atumShellEnabled.get()
      ? []
      : $workbenchTabs.get().filter(tab => tab.surface.kind === 'artifact' || tab.surface.kind === 'preview')

    const wanted = new Set(tabs.map(tab => tab.id))

    for (const tab of tabs) {
      const current = registered.get(tab.id)

      if (current?.registration === tab) {
        continue
      }

      current?.dispose()
      registered.set(tab.id, {
        dispose: registry.register({
          id: tab.id,
          area: 'panes',
          title: tab.title,
          data: {
            dock: { pane: 'workspace', pos: 'center' },
            minWidth: '18rem',
            placement: 'main'
          },
          render: () => <WorkbenchResourcePane id={tab.id} />
        }),
        registration: tab
      })
      registerPaneCloser(tab.id, () => closeWorkbenchRegistration(tab))
    }

    for (const [id, current] of registered) {
      if (!wanted.has(id)) {
        current.dispose()
        registered.delete(id)
        removeTreePane(id)
      }
    }

    for (const prefix of ['artifact:', 'resource:']) {
      for (const id of treePanesWithPrefix(prefix)) {
        if (!wanted.has(id)) {
          removeTreePane(id)
        }
      }
    }
  }

  sync()
  $workbenchTabs.listen(sync)
  $atumShellEnabled.listen(sync)
}
