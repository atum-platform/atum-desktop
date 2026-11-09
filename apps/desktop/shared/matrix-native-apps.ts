import type { LauncherSupportSnapshot, SkillInfo } from './hermes-skills'
import type { NativeAppEntry, NativeAppLaunchRequest, NativeAppLaunchResult } from './skills-launcher'

export const MATRIX_NATIVE_APPS = {
  list: 'matrix:native-apps:list',
  launch: 'matrix:native-apps:launch',
  end: 'matrix:native-apps:end',
  ended: 'matrix:native-apps:ended',
  settings: 'matrix:native-apps:settings',
  readiness: 'matrix:native-apps:readiness'
} as const

/** Machine presentation, never document access or agent execution. */
export interface MatrixNativeAppsBridge {
  list(refresh?: boolean): Promise<NativeAppEntry[]>
  launch(request: Omit<NativeAppLaunchRequest, 'documentPath'>): Promise<NativeAppLaunchResult>
  end(id: string): Promise<void>
  openArrangementSettings(): Promise<void>
  onEnded(listener: (id: string) => void): () => void
  readiness(roomId: string, refresh?: boolean): Promise<{ skills: SkillInfo[]; support: LauncherSupportSnapshot }>
}
