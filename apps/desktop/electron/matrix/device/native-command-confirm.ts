/**
 * The owner's presence before the window approves a command Hermes wants to run on this Mac
 * (owner, 2026-11-17: confirmed with Touch ID). One fresh check per approval, nothing remembered.
 *
 * The device approval key asks (Touch ID, or the Mac's password where there is no sensor) over
 * domain-separated bytes that no device protocol message can share; its signature is checked
 * nowhere and never leaves main: this is a presence check, not a grant. Without an enrolled
 * device, Electron's Touch ID prompt stands in. The window then sends Hermes's own answer.
 */
import { createHash, randomBytes } from 'node:crypto'

import { DEFAULT_DESKTOP_LOCALE, desktopLocaleFor, isDesktopLocale } from '../../../shared/desktop-locale'
import { type MatrixNativeCommandConfirm, matrixNativeCommandSheetText } from '../../../shared/matrix-native-mac'
import { matrixNativeMacCopy } from '../../../shared/matrix-native-mac-copy'

import { approvalFailure, type ApprovalSigner } from './approvals'

/** Hermes's approval text is far shorter; this only bounds what crosses the IPC. */
const COMMAND_MAX = 16_000
const DOMAIN = 'atum.native-command-confirm/1\0'

export interface NativeCommandConfirmDeps {
  /** This Mac's approval key while the device is enrolled, else null. */
  signer(): ApprovalSigner | null
  touchId: { can(): boolean; prompt(reason: string): Promise<void> }
  locale(): string | undefined
  /** Pause the device's GUI broker while the sheet is up, as every other Touch ID does. */
  setPaused?(paused: boolean): void
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
  const signer = deps.signer()

  deps.setPaused?.(true)

  try {
    if (signer) {
      const bytes = Buffer.concat([Buffer.from(DOMAIN), randomBytes(16), createHash('sha256').update(command).digest()])

      try {
        await signer.approve(bytes, reason)

        return 'confirmed'
      } catch (error) {
        // A refusal or silence is the owner's answer; only a missing key falls back to Touch ID.
        if (approvalFailure(error) !== 'unavailable') {
          return 'declined'
        }
      }
    }

    if (!deps.touchId.can()) {
      return 'unavailable'
    }

    try {
      await deps.touchId.prompt(reason)

      return 'confirmed'
    } catch {
      return 'declined'
    }
  } finally {
    deps.setPaused?.(false)
  }
}
