import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

import { DEFAULT_DESKTOP_LOCALE, desktopLocaleFor, isDesktopLocale } from '../../../shared/desktop-locale'
import { type MatrixNativeCommandConfirm, matrixNativeCommandSheetText } from '../../../shared/matrix-native-mac'
import { matrixNativeMacCopy } from '../../../shared/matrix-native-mac-copy'

/** Hermes's approval text is far shorter; this only bounds what crosses the IPC. */
const COMMAND_MAX = 16_000

export interface NativeCommandConfirmDeps {
  touchId: { can(): boolean; prompt(reason: string): Promise<void> }
  locale(): string | undefined
  password?(reason: string): Promise<void>
}

export async function confirmNativeCommand(
  command: unknown,
  deps: NativeCommandConfirmDeps
): Promise<MatrixNativeCommandConfirm> {
  if (typeof command !== 'string' || !command.trim() || command.length > COMMAND_MAX) {
    throw new Error('invalid_native_command')
  }

  const wanted = deps.locale()
  const locale = isDesktopLocale(wanted) ? wanted : (desktopLocaleFor([wanted ?? '']) ?? DEFAULT_DESKTOP_LOCALE)
  const reason = matrixNativeMacCopy[locale].approval.sheetReason(matrixNativeCommandSheetText(command))

  try {
    if (deps.touchId.can()) {
      await deps.touchId.prompt(reason)
    } else {
      if (deps.password) {
        await deps.password(reason)
      } else {
        await promisify(execFile)(
          path.join(process.resourcesPath, 'app.asar.unpacked', 'atum-device-key'),
          ['presence', reason],
          { timeout: 600_000 }
        )
      }
    }

    return 'confirmed'
  } catch {
    return 'declined'
  }
}
