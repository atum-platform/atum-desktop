import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import type {
  LauncherCapabilityTile,
  LauncherOperation,
  LauncherOperationReadiness
} from '@/lib/launcher-capability-types'

import type { LauncherCapabilityCopy } from './launcher-capability-copy'

const OPERATION_LABELS: Record<
  LauncherOperation,
  keyof Pick<
    LauncherCapabilityCopy,
    | 'operationRead'
    | 'operationEdit'
    | 'operationValidate'
    | 'operationRenderQa'
    | 'operationCreate'
    | 'operationFileVisible'
  >
> = {
  read: 'operationRead',
  edit: 'operationEdit',
  validate: 'operationValidate',
  'render-qa': 'operationRenderQa',
  create: 'operationCreate',
  'file-visible': 'operationFileVisible'
}

function readinessCopy(readiness: LauncherOperationReadiness, copy: LauncherCapabilityCopy): string {
  return readiness.state === 'ready'
    ? copy.operationReady
    : readiness.state === 'needs-setup'
      ? copy.operationNeedsSetup
      : copy.operationUnknown
}

/** Backend reason codes are deliberately not consumer copy. The few readiness
 * reasons with product meaning have stable local language; new diagnostics keep
 * the useful generic setup explanation instead of leaking an implementation id. */
function reasonCopy(reasons: readonly string[], copy: LauncherCapabilityCopy): string | null {
  if (reasons.some(reason => /file[-_ ](?:not[-_ ])?visible|mount|attachment/iu.test(reason))) {
    return copy.reasonFileVisibility
  }

  if (reasons.some(reason => /missing[-_ ](?:package|tool|executable)|not[-_ ]found/iu.test(reason))) {
    return copy.reasonMissingTools
  }

  if (reasons.some(reason => /vision|visual|render[-_ ]qa|poppler|libreoffice/iu.test(reason))) {
    return copy.reasonVisualQa
  }

  if (reasons.some(reason => /remote[-_ ]runtime|remote[-_ ]unprobed/iu.test(reason))) {
    return copy.reasonRemoteRuntime
  }

  return null
}

export interface AppCapabilityDialogProps {
  copy: LauncherCapabilityCopy
  onAdd?: () => void
  onBrowse?: () => void
  onEnable?: () => void
  onOpenApp?: (normal?: boolean) => void
  onOpenChange: (open: boolean) => void
  onRecheck?: () => void
  onSetup?: () => void
  onUse?: () => void
  open: boolean
  tile: LauncherCapabilityTile | null
}

/** Explains why a launcher tile cannot yet perform its capability action.
 * It never takes away the ordinary native-app open route. */
export function AppCapabilityDialog({
  copy,
  onAdd,
  onBrowse,
  onEnable,
  onOpenApp,
  onOpenChange,
  onRecheck,
  onSetup,
  onUse,
  open,
  tile
}: AppCapabilityDialogProps) {
  if (!tile) {
    return null
  }

  const statusCopy = {
    checking: copy.statusChecking,
    unavailable: copy.statusUnavailable,
    included: copy.statusIncluded,
    disabled: copy.statusDisabled,
    'needs-setup': copy.statusNeedsSetup,
    acquire: copy.statusAcquire,
    unsupported: copy.statusUnsupported,
    ambiguous: copy.statusAmbiguous,
    ready: copy.statusReady
  }[tile.status]

  const detail = {
    checking: copy.unknownCapability,
    unavailable: copy.unavailableDetail,
    included: copy.includedDetail,
    disabled: copy.disabledDetail,
    'needs-setup': copy.needsSetupDetail,
    acquire: copy.acquireDetail,
    unsupported: copy.noSupportedSkill,
    ambiguous: copy.ambiguousDetail,
    ready: copy.readyDetail
  }[tile.status]

  const operations = Object.entries(tile.operations) as Array<[LauncherOperation, LauncherOperationReadiness]>

  const partiallyReady = tile.status === 'ready' && tile.operations.read?.state === 'ready' &&
    operations.some(([, readiness]) => readiness.state !== 'ready')

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="max-w-[28rem] border-(--atum-line) bg-(--atum-card) text-(--atum-ink)"
        data-atum-app-capability-dialog
        onCloseAutoFocus={event => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{tile.app ? copy.capabilityForApp : copy.capabilityForSkill}</DialogTitle>
          <DialogDescription className="text-(--atum-ink-muted)">{tile.label}</DialogDescription>
        </DialogHeader>
        <p className="text-(length:--atum-t-label) font-medium text-(--atum-ink)">{partiallyReady ? copy.statusReadReady : statusCopy}</p>
        <p className="text-(length:--atum-t-control) text-(--atum-ink-soft)">{partiallyReady ? copy.readReadyDetail : detail}</p>
        {tile.description && (
          <p className="text-(length:--atum-t-caption) text-(--atum-ink-muted)">{tile.description}</p>
        )}
        {operations.length > 0 && (
          <div>
            <h3 className="mb-1 text-(length:--atum-t-label) font-semibold uppercase tracking-[0.06em] text-(--atum-ink-faint)">
              {copy.limitations}
            </h3>
            <ul className="space-y-1 text-(length:--atum-t-caption) text-(--atum-ink-muted)">
              {operations.map(([operation, readiness]) => (
                <li key={operation}>
                  {copy[OPERATION_LABELS[operation]]}: {readinessCopy(readiness, copy)}
                  {reasonCopy(readiness.reasons, copy) ? ` · ${reasonCopy(readiness.reasons, copy)}` : ''}
                </li>
              ))}
            </ul>
          </div>
        )}
        <DialogFooter className="flex-wrap gap-2 sm:justify-between">
          <div className="flex flex-wrap gap-2">
            {tile.skill?.enabled && operations.some(([, readiness]) => readiness.state !== 'ready') && onSetup && (
              <Button onClick={onSetup} size="sm" type="button">{copy.setup}</Button>
            )}
            {(partiallyReady || tile.status === 'checking' || tile.status === 'unavailable' || tile.status === 'needs-setup') &&
              onRecheck && (
                <Button onClick={onRecheck} size="sm" type="button" variant="secondary">
                  {copy.recheck}
                </Button>
              )}
            {tile.status === 'included' && onAdd && (
              <Button onClick={onAdd} size="sm" type="button">
                {copy.addToAssistant}
              </Button>
            )}
            {tile.status === 'disabled' && onEnable && (
              <Button onClick={onEnable} size="sm" type="button">
                {copy.enableForAssistant}
              </Button>
            )}
            {tile.status === 'unsupported' && onBrowse && (
              <Button onClick={onBrowse} size="sm" type="button">
                {copy.browseSkills}
              </Button>
            )}
            {tile.status === 'ready' && onUse && (
              <Button onClick={onUse} size="sm" type="button">
                {copy.useSkill}
              </Button>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            {tile.app && onOpenApp && (
              <Button onClick={() => onOpenApp(false)} size="sm" type="button" variant="ghost">
                {copy.openBeside}
              </Button>
            )}
            {tile.app && onOpenApp && (
              <Button onClick={() => onOpenApp(true)} size="sm" type="button" variant="ghost">
                {copy.openNormally}
              </Button>
            )}
            <Button onClick={() => onOpenChange(false)} size="sm" type="button" variant="ghost">
              {copy.close}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
