/**
 * The disclaim launcher wrapper (S1 build plan §4, WS-4 `device/launcher.ts`; native source at
 * `native/atum-disclaim-launcher/`, reused from the G0 probe).
 *
 * macOS attributes TCC grants (Automation / Apple Events, Accessibility / synthetic input) to the
 * *responsible* process of a tree, not the leaf. A plain child of Atum.app inherits Atum's grants, so an
 * agent command could reach `osascript → System Events` under Atum's Automation grant, or post synthetic
 * events under its Accessibility grant — sidestepping the sandbox. Seatbelt cannot block Apple Events
 * (G0), so the device host is spawned **through this launcher**, which disclaims responsibility: the
 * child answers to TCC for itself, a fresh ungranted binary. The `osascript`-family exec denies in the
 * Seatbelt profile are the belt to this braces.
 *
 * This module only resolves the launcher binary and builds the argv; `host.ts` does the spawn.
 */
import { existsSync } from 'node:fs'
import path from 'node:path'

export interface LauncherResolution {
  /** Absolute path to the staged `atum-disclaim-launcher` binary, or null when it is not present. */
  readonly path: string | null
}

/**
 * Resolve the staged disclaim launcher. In a packaged app it sits in `Contents/Resources`; in a dev
 * build it is staged to `dist/`. `resourcesPath` and `appRoot` are injected so this is testable and so
 * it never assumes `process.resourcesPath` exists.
 */
export function resolveDisclaimLauncher(options: {
  resourcesPath?: string
  appRoot?: string
  exists?: (p: string) => boolean
}): LauncherResolution {
  const exists = options.exists ?? existsSync
  const candidates: string[] = []

  if (options.resourcesPath) {
    candidates.push(path.join(options.resourcesPath, 'atum-disclaim-launcher'))
  }

  if (options.appRoot) {
    candidates.push(path.join(options.appRoot, 'dist', 'atum-disclaim-launcher'))
    candidates.push(path.join(options.appRoot, 'dist-matrix', 'atum-disclaim-launcher'))
  }

  for (const candidate of candidates) {
    if (exists(candidate)) {
      return { path: candidate }
    }
  }

  return { path: null }
}

/**
 * Build the argv that runs `program …args` as a disclaimed child. The shipping device host always
 * disclaims (`--disclaim 1`); the `--disclaim 0` form exists only for the G0 A/B probe.
 */
export function disclaimArgv(launcher: string, program: string, args: readonly string[]): string[] {
  return [launcher, '--disclaim', '1', '--', program, ...args]
}
