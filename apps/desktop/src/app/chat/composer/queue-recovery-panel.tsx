import { useStore } from '@nanostores/react'

import { StatusSection } from '@/components/chat/status-section'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { $actionPanelEpoch, $actionPanelOwner, panelOwnerKey } from '@/store/action-panel-owner'
import { $composerDraft, setComposerDraft } from '@/store/composer'
import { $queueRecovery, dismissQueueRecovery } from '@/store/composer-queue'
import { ownsActionPanel } from '@/store/windows'

export function QueueRecoveryPanel() {
  const { t } = useI18n()
  const owner = useStore($actionPanelOwner)
  useStore($actionPanelEpoch)
  const recovery = useStore($queueRecovery)
  const drafts = recovery.filter(item => item.accountId ? item.accountId === owner?.accountId : item.ownerKey === panelOwnerKey())

  if (!ownsActionPanel() || !drafts.length) {return null}

  return <StatusSection defaultCollapsed={false} label={t.composer.recoveredDrafts}>
    {drafts.map(draft => <div className="flex items-center gap-2 px-2" key={draft.id}>
      <p className="min-w-0 flex-1 truncate text-xs">{draft.text}</p>
      <Button onClick={() => {
        setComposerDraft([$composerDraft.get(), draft.text].filter(Boolean).join('\n\n'))
        dismissQueueRecovery(draft.id)
      }} size="micro" variant="text">{t.composer.restoreDraft}</Button>
      <Button onClick={() => dismissQueueRecovery(draft.id)} size="micro" variant="text">{t.common.delete}</Button>
    </div>)}
  </StatusSection>
}
