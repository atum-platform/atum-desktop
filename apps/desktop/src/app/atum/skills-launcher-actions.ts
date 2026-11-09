import { OFFICE_SKILLS } from '@/lib/launcher-capabilities'
import { $actionPanelEpoch } from '@/store/action-panel-owner'
import { prepareLauncherSkill } from '@/store/launcher-capabilities'
import { openNativeAppDocument } from '@/store/native-apps'
import { openWordCompanion } from '@/store/word-companion'
import { $workbenchScope, resolveCaptureScope } from '@/store/workbench-tabs'

import type { NativeAppEntry } from '../../../shared/skills-launcher'
import { officeKindForBundle } from '../../../shared/skills-launcher'

function current(scopeKey: string, epoch: number) {
  return epoch === $actionPanelEpoch.get() && resolveCaptureScope(scopeKey) === resolveCaptureScope($workbenchScope.get())
}

export async function openLauncherOfficeFile(app: NativeAppEntry, scopeKey: string): Promise<void> {
  const kind = officeKindForBundle(app.bundleId)

  if (!kind) {return}
  const epoch = $actionPanelEpoch.get()
  const path = await window.hermesDesktop.nativeApps?.chooseFile(kind)

  if (!path || !current(scopeKey, epoch)) {return}

  if (kind === 'word') {await openWordCompanion(path, scopeKey)} else {
    const result = await openNativeAppDocument(app, path, scopeKey)
    const skill = app.bundleId ? OFFICE_SKILLS[app.bundleId] : undefined

    if (result && result.status !== 'choose-window' && skill && current(scopeKey, epoch)) {prepareLauncherSkill(skill, scopeKey)}
  }
}
