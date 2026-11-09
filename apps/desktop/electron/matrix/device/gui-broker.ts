/**
 * The GUI broker (S1 build plan §3, §4, WS-4 `device/gui-broker.ts`).
 *
 * `computer_use` for a cloud-mode agent runs Hermes's own tool inside the device host, whose CuaDriver
 * session is the host's child (not Hermes's, and never reachable from a shell command: its socket and
 * binary are denied in the Seatbelt profile). Before **every** mutating action the host asks this broker
 * (`device.gui_authorize`), describing the window the action will actually reach: CuaDriver posts each
 * event to one process, the tool's sticky target, so that process is the target.
 *
 * The broker re-checks authority (grant live, not paused) and **refuses any action aimed at system
 * security UI** — the LocalAuthentication and SecurityAgent sheets, TCC prompts, System Settings — or at
 * Atum itself, so the agent can never click or type at its own approval prompt (test 5(i)). It matches
 * on the process path and bundle ID, which are not localized (these Macs run a Vietnamese UI), with the
 * window title only as a fallback. A file-picker action, or typing, setting or pasting more than 2 KB
 * into a browser or mail app, is a protected `gui_upload` and needs the owner's approval (test 5(h),
 * Q3). Small typed sends into a logged-in app are the accepted S1 limit.
 */

/** The window a mutating action will reach, as the device host resolves it from CuaDriver. */
export interface GuiTarget {
  readonly pid?: number
  /** The executable of the target process (`proc_pidpath`). */
  readonly processPath?: string
  readonly bundleId?: string
  /** CuaDriver's app name (localized) and window title (localized). */
  readonly appName?: string
  readonly title?: string
  /** `focus_app`/`launch_app`: the app the agent asked for. */
  readonly requestedApp?: string
}

export interface GuiAuthorizeRequest {
  readonly commandId: string
  readonly action: string
  readonly summary?: string
  readonly target: GuiTarget
  /** UTF-8 bytes of text a `type`/`set_value` would enter. */
  readonly textBytes?: number
  /** Bytes on the pasteboard when the action pastes (cmd+v). */
  readonly pasteBytes?: number
}

export type GuiRefusal = 'command_app' | 'no_target' | 'stopped' | 'paused' | 'security_ui' | 'own_app' | 'approval_denied' | 'approval_timeout'

export type GuiAuthorizeVerdict = { readonly allow: true } | { readonly allow: false; readonly reason: GuiRefusal }

/** Executables of system security UI, by path fragment (never localized). */
const SECURITY_UI_PATHS: readonly RegExp[] = [
  /\/SecurityAgent(\.bundle)?\//i,
  /\/SecurityAgent$/i,
  /\/coreautha(\.bundle)?\//i,
  /\/coreautha$/i,
  /\/coreauthd$/i,
  /\/LocalAuthentication\.framework\//i,
  /\/UserNotificationCenter\.app\//i,
  /\/universalAccessAuthWarn\.app\//i,
  /\/authorizationhost(\.bundle)?\//i,
  /\/System Settings\.app\//i,
  /\/System Preferences\.app\//i,
  /\/PreferencePanes\//i,
  /\/Keychain Access\.app\//i,
  /\/Passwords\.app\//i,
  /\/loginwindow\.app\//i,
  /\/loginwindow$/i,
  /\/tccd$/i,
  /\/ScreenSaverEngine\.app\//i
]

const SECURITY_UI_BUNDLES: readonly RegExp[] = [
  /^com\.apple\.SecurityAgent$/i,
  /^com\.apple\.CoreAuthUI/i,
  /^com\.apple\.LocalAuthentication/i,
  /^com\.apple\.UserNotificationCenter$/i,
  /^com\.apple\.universalaccessAuthWarn$/i,
  /^com\.apple\.systempreferences/i,
  /^com\.apple\.(settings|preference)\./i,
  /^com\.apple\.keychainaccess$/i,
  /^com\.apple\.Passwords$/i,
  /^com\.apple\.loginwindow$/i
]

/** A last resort for when the process is unknown: English and Vietnamese security-sheet titles. */
const SECURITY_UI_TITLE =
  /(touch id|privacy & security|security & privacy|wants to make changes|enter your password|system settings|quyền riêng tư|bảo mật|nhập mật khẩu|cài đặt hệ thống|muốn thực hiện thay đổi)/i

/** Requested app names (focus/launch) that are security UI, in the five product locales. */
const SECURITY_UI_APPS =
  /^(system settings|system preferences|keychain access|passwords|cài đặt hệ thống|truy cập chuỗi khóa|mật khẩu|システム設定|キーチェーンアクセス|パスワード|系统设置|钥匙串访问|密码|系統設定|鑰匙圈存取|密碼)$/i

/** True when the target is system security UI that synthetic input must never reach. */
export function isSecurityUiTarget(target: GuiTarget): boolean {
  if (target.processPath && SECURITY_UI_PATHS.some(pattern => pattern.test(target.processPath!))) {
    return true
  }

  if (target.bundleId && SECURITY_UI_BUNDLES.some(pattern => pattern.test(target.bundleId!))) {
    return true
  }

  const requested = target.requestedApp?.trim()

  if (requested && (SECURITY_UI_APPS.test(requested) || SECURITY_UI_BUNDLES.some(pattern => pattern.test(requested)))) {
    return true
  }

  return Boolean(target.title && SECURITY_UI_TITLE.test(target.title)) || Boolean(target.appName && SECURITY_UI_APPS.test(target.appName.trim()))
}

// These apps can turn GUI input into code running outside the command sandbox.
// Check both a resolved target and focus/launch requests, including bundle IDs and .app paths.
const COMMAND_APP_BUNDLES = new Set([
  'com.apple.terminal', 'com.googlecode.iterm2', 'com.apple.scripteditor2',
  'com.apple.automator', 'com.apple.shortcuts', 'dev.warp.warp-stable',
  'dev.warp.warp-preview', 'com.mitchellh.ghostty', 'org.alacritty',
  'net.kovidgoyal.kitty', 'com.github.wez.wezterm', 'co.zeit.hyper',
  'org.tabby', 'com.raphaelamorim.rio', 'dev.commandline.waveterm',
  'com.termius-dmg.mac', 'com.termius.mas', 'com.latenightsw.scriptdebugger8'
])

const COMMAND_APP_NAMES = /^(terminal|iterm2?|script editor|automator|shortcuts|warp|ghostty|alacritty|kitty|wezterm|hyper|tabby|rio|wave|termius|script debugger)$/i

export function isCommandAppTarget(target: GuiTarget): boolean {
  const names = [target.requestedApp, target.appName, target.bundleId]

  if (names.some(value => value && (
    COMMAND_APP_BUNDLES.has(value.trim().toLowerCase()) ||
    COMMAND_APP_NAMES.test(value.trim().replace(/\/+$/, '').replace(/^.*\//, '').replace(/\.app$/i, ''))
  ))) {
    return true
  }

  return Boolean(target.processPath?.split('/').some(part =>
    /\.app$/i.test(part) && COMMAND_APP_NAMES.test(part.replace(/\.app$/i, ''))
  ))
}

/** True when the target is Atum itself (its chat, its Settings, its windows): never agent-driven. */
export function isOwnApp(target: GuiTarget, own: { bundlePath?: string | null; bundleId?: string | null; pids?: readonly number[] }): boolean {
  if (own.bundlePath && target.processPath?.startsWith(`${own.bundlePath}/`)) {
    return true
  }

  if (own.bundleId && (target.bundleId === own.bundleId || target.requestedApp === own.bundleId)) {
    return true
  }

  return target.pid !== undefined && (own.pids ?? []).includes(target.pid)
}

const BROWSER_MAIL_BUNDLES: readonly string[] = [
  'com.apple.Safari',
  'com.apple.SafariTechnologyPreview',
  'com.google.Chrome',
  'com.google.Chrome.canary',
  'org.chromium.Chromium',
  'company.thebrowser.Browser',
  'com.brave.Browser',
  'com.microsoft.edgemac',
  'org.mozilla.firefox',
  'com.operasoftware.Opera',
  'com.vivaldi.Vivaldi',
  'com.apple.mail',
  'com.microsoft.Outlook',
  'com.readdle.smartemail-Mac',
  'com.superhuman.electron',
  'it.bloop.airmail2'
]

const BROWSER_MAIL_PATHS = /\/(Safari|Google Chrome|Chromium|Arc|Brave Browser|Microsoft Edge|Firefox|Opera|Vivaldi|Mail|Microsoft Outlook|Spark|Superhuman)\.app\//i

/** Open/Save/Upload panel titles in the five product locales (a separator or the end must follow:
 * JavaScript's `\b` does not see a boundary after a Vietnamese or CJK letter). */
const FILE_PANEL_TITLE =
  /^(open|save|save as|choose|upload|attach|export|import|mở|lưu|lưu thành|chọn|tải lên|đính kèm|xuất|nhập|開く|保存|選択|アップロード|添付|打开|存储|选择|上传|附加|打開|儲存|選擇|上傳)(?=$|[\s:.,…\-–—])/i

const GUI_UPLOAD_BYTES = 2048

function isBrowserOrMail(target: GuiTarget): boolean {
  return Boolean(
    (target.bundleId && BROWSER_MAIL_BUNDLES.includes(target.bundleId)) ||
      (target.processPath && BROWSER_MAIL_PATHS.test(target.processPath))
  )
}

/** True when a GUI action is a protected `gui_upload`: an action at a file panel, or a large text entry
 * or paste into a browser or mail app (the honest S1 limit: ordinary small typing is not blocked). */
export function isGuiUpload(request: Pick<GuiAuthorizeRequest, 'action' | 'target' | 'textBytes' | 'pasteBytes'>): boolean {
  const { action, target } = request

  if (!isBrowserOrMail(target)) {
    return false
  }

  if (target.title && FILE_PANEL_TITLE.test(target.title.trim()) && action !== 'wait') {
    return true
  }

  return (
    ((action === 'type' || action === 'set_value') && (request.textBytes ?? 0) > GUI_UPLOAD_BYTES) ||
    (action === 'key' && (request.pasteBytes ?? 0) > GUI_UPLOAD_BYTES)
  )
}

export interface GuiBrokerDeps {
  /** Authority right now, for the command this action belongs to (grant live, not paused). */
  authority(commandId: string): { live: boolean; paused: boolean }
  /** Atum's own bundle and processes, which the agent may not drive. */
  ownApp(): { bundlePath?: string | null; bundleId?: string | null; pids?: readonly number[] }
  /** One Touch ID for a protected `gui_upload`; resolves the outcome. */
  requestUploadApproval(request: GuiAuthorizeRequest): Promise<'approved' | 'approval_denied' | 'approval_timeout'>
  /** Record a decision for audit (never the typed text). */
  audit(decision: 'gui_refused' | 'admitted' | 'approved', summary: string): void
}

export class GuiBroker {
  constructor(private readonly deps: GuiBrokerDeps) {}

  /** Decide one mutating GUI action: authority, security UI, Atum itself, the upload gate. */
  async authorize(request: GuiAuthorizeRequest): Promise<GuiAuthorizeVerdict> {
    const refuse = (reason: GuiRefusal): GuiAuthorizeVerdict => {
      this.deps.audit('gui_refused', `${request.action}:${reason}`)

      return { allow: false, reason }
    }

    const authority = this.deps.authority(request.commandId)

    if (!authority.live) {
      return refuse('stopped')
    }

    if (authority.paused) {
      return refuse('paused')
    }

    const target = request.target ?? {}

    if (isSecurityUiTarget(target)) {
      return refuse('security_ui')
    }

    if (isCommandAppTarget(target)) {
      return refuse('command_app')
    }

    if (isOwnApp(target, this.deps.ownApp())) {
      return refuse('own_app')
    }

    const appSelection = ['focus_app', 'launch_app', 'bring_to_front'].includes(request.action) && !!target.requestedApp

    if (!appSelection && (!Number.isSafeInteger(target.pid) || (target.pid ?? 0) <= 0)) {
      return refuse('no_target')
    }

    if (isGuiUpload({ ...request, target })) {
      const outcome = await this.deps.requestUploadApproval(request)

      if (outcome !== 'approved') {
        return refuse(outcome)
      }

      // Stop may have fired while the sheet was up.
      if (!this.deps.authority(request.commandId).live) {
        return refuse('stopped')
      }

      this.deps.audit('approved', `${request.action}:gui_upload`)
    }

    return { allow: true }
  }
}
