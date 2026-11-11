import { describe, expect, it, vi } from 'vitest'

import { type GuiAuthorizeRequest, GuiBroker, isGuiUpload, isOwnApp, isSecurityUiTarget } from './gui-broker'

const SAFARI = '/Applications/Safari.app/Contents/MacOS/Safari'
const TEXTEDIT = '/System/Applications/TextEdit.app/Contents/MacOS/TextEdit'

describe('isSecurityUiTarget', () => {
  it('refuses the LocalAuthentication sheet, SecurityAgent, TCC prompts and System Settings by process path', () => {
    for (const processPath of [
      '/System/Library/Frameworks/Security.framework/Versions/A/MachServices/SecurityAgent.bundle/Contents/MacOS/SecurityAgent',
      '/System/Library/Frameworks/LocalAuthentication.framework/Support/coreautha.bundle/Contents/MacOS/coreautha',
      '/System/Library/CoreServices/UserNotificationCenter.app/Contents/MacOS/UserNotificationCenter',
      '/System/Library/CoreServices/universalAccessAuthWarn.app/Contents/MacOS/universalAccessAuthWarn',
      '/System/Applications/System Settings.app/Contents/MacOS/System Settings',
      '/System/Library/CoreServices/loginwindow.app/Contents/MacOS/loginwindow'
    ]) {
      expect(isSecurityUiTarget({ processPath }), processPath).toBe(true)
    }
  })

  it('does not depend on a localized title: a Vietnamese System Settings window is still refused', () => {
    expect(
      isSecurityUiTarget({
        processPath: '/System/Applications/System Settings.app/Contents/MacOS/System Settings',
        appName: 'Cài đặt hệ thống',
        title: 'Quyền riêng tư & Bảo mật'
      })
    ).toBe(true)
    expect(isSecurityUiTarget({ title: 'Nhập mật khẩu của bạn' })).toBe(true)
  })

  it('refuses focusing or launching a security app by name in any product locale', () => {
    for (const requestedApp of ['System Settings', 'Cài đặt hệ thống', 'システム設定', '系统设置', '系統設定', 'com.apple.systempreferences']) {
      expect(isSecurityUiTarget({ requestedApp }), requestedApp).toBe(true)
    }
  })

  it('allows ordinary apps', () => {
    expect(isSecurityUiTarget({ processPath: TEXTEDIT, bundleId: 'com.apple.TextEdit', title: 'hello.txt' })).toBe(false)
    expect(isSecurityUiTarget({ processPath: SAFARI, title: 'GitHub' })).toBe(false)
    expect(isSecurityUiTarget({ requestedApp: 'TextEdit' })).toBe(false)
  })
})

describe('isOwnApp', () => {
  const own = { bundlePath: '/Applications/Atum.app', bundleId: 'com.atum.matrix-candidate', pids: [4242] }

  it('refuses Atum by bundle path, bundle ID or pid', () => {
    expect(isOwnApp({ processPath: '/Applications/Atum.app/Contents/MacOS/Atum' }, own)).toBe(true)
    expect(isOwnApp({ processPath: '/Applications/Atum.app/Contents/Frameworks/Atum Helper (Renderer).app/Contents/MacOS/Atum Helper (Renderer)' }, own)).toBe(true)
    expect(isOwnApp({ requestedApp: 'com.atum.matrix-candidate' }, own)).toBe(true)
    expect(isOwnApp({ pid: 4242 }, own)).toBe(true)
    expect(isOwnApp({ processPath: TEXTEDIT, pid: 99 }, own)).toBe(false)
  })
})

describe('isGuiUpload', () => {
  const request = (over: Partial<GuiAuthorizeRequest>): GuiAuthorizeRequest => ({ commandId: 'c', action: 'click', target: {}, ...over })

  it('an action at a browser or mail file panel is an upload, in any product locale', () => {
    for (const title of ['Open', 'Upload File', 'Mở', 'Tải lên', '開く', '上传']) {
      expect(isGuiUpload(request({ target: { processPath: SAFARI, title } })), title).toBe(true)
    }
  })

  it('large typing, set_value or a large paste into a browser or mail app is an upload; small ones are not', () => {
    const safari = { processPath: SAFARI, title: 'web form' }
    expect(isGuiUpload(request({ action: 'type', target: safari, textBytes: 3000 }))).toBe(true)
    expect(isGuiUpload(request({ action: 'set_value', target: safari, textBytes: 3000 }))).toBe(true)
    expect(isGuiUpload(request({ action: 'key', target: safari, pasteBytes: 9000 }))).toBe(true)
    expect(isGuiUpload(request({ action: 'type', target: safari, textBytes: 20 }))).toBe(false)
    expect(isGuiUpload(request({ action: 'key', target: { bundleId: 'com.apple.mail' }, pasteBytes: 4000 }))).toBe(true)
  })

  it('a non-browser app is not an upload (the honest S1 limit), even a Save panel', () => {
    const editor = { processPath: TEXTEDIT, title: 'Save' }
    expect(isGuiUpload(request({ action: 'type', target: editor, textBytes: 9000 }))).toBe(false)
    expect(isGuiUpload(request({ action: 'click', target: editor }))).toBe(false)
  })
})

function makeBroker(over: Partial<ConstructorParameters<typeof GuiBroker>[0]> = {}) {
  const deps = {
    authority: vi.fn(() => ({ live: true, paused: false })),
    ownApp: vi.fn(() => ({ bundlePath: '/Applications/Atum.app', bundleId: 'com.atum.matrix-candidate', pids: [4242] })),
    requestUploadApproval: vi.fn(async () => 'approved' as const),
    audit: vi.fn(),
    ...over
  }

  return { deps, broker: new GuiBroker(deps) }
}

const click = (target: GuiAuthorizeRequest['target'], over: Partial<GuiAuthorizeRequest> = {}): GuiAuthorizeRequest => ({
  commandId: 'cmd-1',
  action: 'click',
  target: { pid: 99, ...target },
  ...over
})

describe('GuiBroker.authorize', () => {
  it('refuses an unresolved input target and allows selecting an app first', async () => {
    const { broker } = makeBroker()
    expect(await broker.authorize(click({}, { target: {} }))).toEqual({ allow: false, reason: 'no_target' })
    expect(await broker.authorize(click({ requestedApp: 'Fixture' }, { action: 'focus_app' }))).toEqual({ allow: true })
  })

  it.each([
    ['Terminal', 'com.apple.Terminal'], ['iTerm2', 'com.googlecode.iterm2'],
    ['Script Editor', 'com.apple.ScriptEditor2'], ['Automator', 'com.apple.Automator'],
    ['Shortcuts', 'com.apple.shortcuts'], ['Warp', 'dev.warp.Warp-Stable'],
    ['Ghostty', 'com.mitchellh.ghostty'], ['Alacritty', 'org.alacritty'],
    ['kitty', 'net.kovidgoyal.kitty'], ['WezTerm', 'com.github.wez.wezterm'], ['Hyper', 'co.zeit.hyper'],
    ['Tabby', 'org.tabby'], ['Rio', 'com.raphaelamorim.rio'], ['Wave', 'dev.commandline.waveterm'],
    ['Termius', 'com.termius-dmg.mac'], ['Termius', 'com.termius.mas'], ['Script Debugger', 'com.latenightsw.ScriptDebugger8']
  ])('refuses command app %s by target identity and focus/launch aliases', async (name, bundleId) => {
    const { broker } = makeBroker()

    for (const target of [
      { bundleId }, { appName: name }, { processPath: `/Applications/${name}.app/Contents/MacOS/renamed` }
    ]) {
      expect(await broker.authorize(click(target, { action: 'type' }))).toEqual({ allow: false, reason: 'command_app' })
    }

    for (const action of ['focus_app', 'launch_app', 'bring_to_front']) {
      for (const requestedApp of [name, bundleId, `/Applications/${name}.app`, `/Applications/${name}.app/`]) {
        expect(await broker.authorize(click({ requestedApp }, { action }))).toEqual({ allow: false, reason: 'command_app' })
      }
    }
  })

  it.each(['Visual Studio Code', 'Cursor', 'IntelliJ IDEA', 'Zed', 'Xcode'])(
    'allows IDE input without a warning for %s', async appName => {
      const { broker, deps } = makeBroker()
      expect(await broker.authorize(click({ appName }, { action: 'type', textBytes: 100 }))).toEqual({ allow: true })
      expect(deps.requestUploadApproval).not.toHaveBeenCalled()
    }
  )

  it('allows an ordinary action under live authority', async () => {
    const { broker } = makeBroker()
    expect(await broker.authorize(click({ processPath: TEXTEDIT }))).toEqual({ allow: true })
  })

  it('refuses when the grant is gone or an approval sheet is up', async () => {
    expect(await makeBroker({ authority: () => ({ live: false, paused: false }) }).broker.authorize(click({ processPath: TEXTEDIT }))).toEqual({
      allow: false,
      reason: 'stopped'
    })
    expect(await makeBroker({ authority: () => ({ live: true, paused: true }) }).broker.authorize(click({ processPath: TEXTEDIT }))).toEqual({
      allow: false,
      reason: 'paused'
    })
  })

  it('refuses any action at its own Touch ID sheet, a TCC prompt, System Settings ', async () => {
    const { broker, deps } = makeBroker()
    const sheet = '/System/Library/Frameworks/LocalAuthentication.framework/Support/coreautha.bundle/Contents/MacOS/coreautha'

    for (const action of ['click', 'type', 'key', 'set_value']) {
      expect(await broker.authorize(click({ processPath: sheet }, { action }))).toEqual({ allow: false, reason: 'security_ui' })
    }

    expect(await broker.authorize(click({ processPath: '/Applications/Atum.app/Contents/MacOS/Atum' }))).toEqual({ allow: true })
    expect(deps.requestUploadApproval).not.toHaveBeenCalled()
  })

  it('a gui_upload needs the owner; a denial or timeout refuses, and a Stop during the sheet refuses too', async () => {
    const upload = click({ processPath: SAFARI, title: 'Upload File' })

    const approved = makeBroker()
    expect(await approved.broker.authorize(upload)).toEqual({ allow: true })
    expect(approved.deps.requestUploadApproval).toHaveBeenCalledTimes(1)

    expect(await makeBroker({ requestUploadApproval: async () => 'approval_denied' }).broker.authorize(upload)).toEqual({
      allow: false,
      reason: 'approval_denied'
    })
    expect(await makeBroker({ requestUploadApproval: async () => 'approval_timeout' }).broker.authorize(upload)).toEqual({
      allow: false,
      reason: 'approval_timeout'
    })

    let live = true

    const stopped = makeBroker({
      authority: () => ({ live, paused: false }),
      requestUploadApproval: async () => {
        live = false

        return 'approved'
      }
    })

    expect(await stopped.broker.authorize(upload)).toEqual({ allow: false, reason: 'stopped' })
  })
})

 it.each(['click', 'type', 'key', 'set_value'])('allows %s in the owner Atum window without approval', async action => {
  const { broker, deps } = makeBroker()
  expect(await broker.authorize(click({ pid: 4242, bundleId: 'com.atum.matrix-candidate', title: 'Atum' }, { action }))).toEqual({ allow: true })
  expect(deps.requestUploadApproval).not.toHaveBeenCalled()
})

it('enforces registered consent before accepting ordinary owner-authorized input', async () => {
  const { hitsConsent } = await import('./consent')
  const broker = new GuiBroker({
    authority: () => ({ live: true, paused: false }),
    ownApp: () => ({ pids: [7] }),
    requestUploadApproval: async () => 'approved',
    audit: () => {},
    consentProtected: async request => hitsConsent(request, [{ x: 10, y: 10, width: 100, height: 100 }])
  })
  const request = { commandId: 'command', action: 'click', target: { pid: 7, windowId: 8 } }
  expect(await broker.authorize({ ...request, destination: { x: 30, y: 30 } })).toEqual({ allow: false, reason: 'consent_ui' })
  expect(await broker.authorize({ ...request, destination: { x: 300, y: 300 } })).toEqual({ allow: true })
  for (const action of ['type', 'paste', 'key', 'set_value', 'ax_press']) {
    expect(await broker.authorize({ ...request, action })).toEqual({ allow: false, reason: 'consent_ui' })
  }
})
