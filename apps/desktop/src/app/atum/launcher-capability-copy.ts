import type { useI18n } from '@/i18n'

/**
 * The launcher has a compact copy surface of its own, but remains part of the
 * normal Atum workspace locale. Keeping this adapter here makes the UI's
 * status vocabulary explicit without creating a second translation mechanism.
 */
export interface LauncherCapabilityCopy {
  acquireDetail: string
  actionFailed: string
  addToAssistant: string
  ambiguousDetail: string
  browseSkills: string
  capabilityForApp: string
  capabilityForSkill: string
  close: string
  disabledDetail: string
  enableForAssistant: string
  includedDetail: string
  limitations: string
  needsSetupDetail: string
  noSupportedSkill: string
  openApp: string
  openBeside: string
  openNormally: string
  operationCreate: string
  operationEdit: string
  operationFileVisible: string
  operationNeedsSetup: string
  operationRead: string
  operationReady: string
  operationRenderQa: string
  operationUnknown: string
  operationValidate: string
  readyDetail: string
  readReadyDetail: string
  recheck: string
  setup: string
  setupRequest: string
  reasonFileVisibility: string
  reasonMissingTools: string
  reasonRemoteRuntime: string
  reasonVisualQa: string
  skillOnly: string
  statusAcquire: string
  statusAmbiguous: string
  statusChecking: string
  statusDisabled: string
  statusIncluded: string
  statusNeedsSetup: string
  statusReady: string
  statusReadReady: string
  statusUnavailable: string
  statusUnsupported: string
  unavailableDetail: string
  unknownCapability: string
  useSkill: string
}

/** Parent locale bundles provide this under `atum.workspace.capability`. */
export function launcherCapabilityCopy(t: ReturnType<typeof useI18n>['t']): LauncherCapabilityCopy {
  return (t.atum.workspace as typeof t.atum.workspace & { capability: LauncherCapabilityCopy }).capability
}
