import fs from 'node:fs'
import path from 'node:path'

export type MainLocale = 'en' | 'vi'

export const MAIN_STRINGS = {
  en: {
    menu: {
      about: 'About Atum', actualSize: 'Actual Size', checkForUpdates: 'Check for Updates…', close: 'Close',
      addToDictionary: 'Add to dictionary', copy: 'Copy', copyImage: 'Copy Image',
      copyImageAddress: 'Copy Image Address', copyLink: 'Copy Link', cut: 'Cut', delete: 'Delete', edit: 'Edit',
      file: 'File', forceReload: 'Force Reload',
      front: 'Bring All to Front', help: 'Help', hide: 'Hide Atum', hideOthers: 'Hide Others', minimize: 'Minimize',
      newWindow: 'New Window', openImage: 'Open Image', openLink: 'Open Link', paste: 'Paste', quit: 'Quit Atum',
      redo: 'Redo', reload: 'Reload', saveImageAs: 'Save Image As…',
      selectAll: 'Select All', services: 'Services', toggleDevTools: 'Developer Tools',
      toggleFullscreen: 'Toggle Full Screen', undo: 'Undo', unhide: 'Show All', view: 'View', window: 'Window',
      windowZoom: 'Zoom', zoomIn: 'Zoom In', zoomOut: 'Zoom Out'
    },
    dialogs: {
      addContext: 'Add context', choose: 'Choose', chooseDefaultProjectDirectory: 'Choose default project directory',
      save: 'Save', saveImage: 'Save Image',
      workspaceUnavailable: 'Your Atum folder is unavailable',
      workspaceRestoreDetail: 'If you moved or renamed it, locate the original folder to move it back here. If it is in Trash, restore it first. Your work has not been deleted by Atum.',
      workspaceLocate: 'Locate original folder…', workspaceCancel: 'Cancel',
      workspaceStartNew: 'Start a new Atum folder',
      workspaceForgotten: 'Sign in again to create a new Atum folder. Any other folders remain where they are.',
      workspaceRestored: 'Your Atum folder has been restored. Sign in again to continue.',
      workspaceRestoreFailed: 'The folder could not be restored. Select the original Atum folder and make sure its expected location is free.'
    },
    windows: {
      bootstrapRequired: 'Atum is not installed yet; initial setup is required',
      cloudSessionExpired: 'Your Atum Cloud session has expired. Sign in to Atum Cloud again.',
      gatewaySessionExpired: 'Your Atum Cloud session has expired. Open Settings → Gateway and sign in again.',
      connectingCloudAgent: 'Connecting to Atum Cloud agent…', signInCloud: 'Sign in to Atum Cloud',
      signInGateway: 'Sign in to Atum gateway'
    },
    desktopOAuth: {
      eyebrow: 'Atum for desktop',
      'native-sign-in': {
        title: "You're signed in",
        body: 'Atum is ready. You can close this window and return to the app.'
      },
      'connection-approved': {
        title: 'Connection approved',
        body: 'Atum received the authorization. You can close this window and return to the app.'
      },
      'connection-denied': {
        title: 'Connection not approved',
        body: 'Nothing was connected. Return to Atum when you are ready to try again.'
      },
      'invalid-response': {
        title: 'Invalid authorization response',
        body: 'Return to Atum and start the connection again.'
      }
    }
  },
  vi: {
    menu: {
      about: 'Giới thiệu Atum', actualSize: 'Kích thước thực', checkForUpdates: 'Kiểm tra bản cập nhật…',
      addToDictionary: 'Thêm vào từ điển', close: 'Đóng', copy: 'Sao chép', copyImage: 'Sao chép hình ảnh',
      copyImageAddress: 'Sao chép địa chỉ hình ảnh', copyLink: 'Sao chép liên kết', cut: 'Cắt', delete: 'Xóa',
      edit: 'Chỉnh sửa', file: 'Tệp',
      forceReload: 'Buộc tải lại', front: 'Đưa tất cả ra trước', help: 'Trợ giúp', hide: 'Ẩn Atum',
      hideOthers: 'Ẩn ứng dụng khác', minimize: 'Thu nhỏ cửa sổ', newWindow: 'Cửa sổ mới',
      openImage: 'Mở hình ảnh', openLink: 'Mở liên kết', paste: 'Dán', quit: 'Thoát Atum', redo: 'Làm lại',
      reload: 'Tải lại', saveImageAs: 'Lưu hình ảnh thành…', selectAll: 'Chọn tất cả', services: 'Dịch vụ',
      toggleDevTools: 'Công cụ dành cho nhà phát triển', toggleFullscreen: 'Bật/tắt toàn màn hình',
      undo: 'Hoàn tác', unhide: 'Hiện tất cả', view: 'Hiển thị', window: 'Cửa sổ', windowZoom: 'Thu phóng',
      zoomIn: 'Phóng to', zoomOut: 'Thu nhỏ'
    },
    dialogs: {
      addContext: 'Thêm ngữ cảnh', choose: 'Chọn', chooseDefaultProjectDirectory: 'Chọn thư mục dự án mặc định',
      save: 'Lưu', saveImage: 'Lưu hình ảnh',
      workspaceUnavailable: 'Không tìm thấy thư mục Atum của bạn',
      workspaceRestoreDetail: 'Nếu bạn đã di chuyển hoặc đổi tên thư mục, hãy chọn thư mục gốc để đưa về vị trí này. Nếu thư mục đang ở Thùng rác, hãy khôi phục trước. Atum chưa xóa dữ liệu của bạn.',
      workspaceLocate: 'Tìm thư mục gốc…', workspaceCancel: 'Hủy',
      workspaceStartNew: 'Tạo thư mục Atum mới',
      workspaceForgotten: 'Hãy đăng nhập lại để tạo thư mục Atum mới. Các thư mục khác vẫn được giữ nguyên vị trí.',
      workspaceRestored: 'Đã khôi phục thư mục Atum. Hãy đăng nhập lại để tiếp tục.',
      workspaceRestoreFailed: 'Không thể khôi phục thư mục. Hãy chọn đúng thư mục Atum gốc và bảo đảm vị trí cần khôi phục chưa có thư mục khác.'
    },
    windows: {
      bootstrapRequired: 'Atum chưa được cài đặt; cần thiết lập ban đầu',
      cloudSessionExpired: 'Phiên Atum Cloud đã hết hạn. Hãy đăng nhập lại Atum Cloud.',
      gatewaySessionExpired: 'Phiên Atum Cloud đã hết hạn. Hãy mở Cài đặt → Cổng kết nối và đăng nhập lại.',
      connectingCloudAgent: 'Đang kết nối với Trợ lý Atum trên đám mây…', signInCloud: 'Đăng nhập Atum Cloud',
      signInGateway: 'Đăng nhập cổng Atum'
    },
    desktopOAuth: {
      eyebrow: 'Atum cho máy tính',
      'native-sign-in': {
        title: 'Bạn đã đăng nhập',
        body: 'Atum đã sẵn sàng. Bạn có thể đóng cửa sổ này và quay lại ứng dụng.'
      },
      'connection-approved': {
        title: 'Đã cho phép kết nối',
        body: 'Atum đã nhận được quyền truy cập. Bạn có thể đóng cửa sổ này và quay lại ứng dụng.'
      },
      'connection-denied': {
        title: 'Chưa cho phép kết nối',
        body: 'Chưa có kết nối nào được tạo. Hãy quay lại Atum khi bạn muốn thử lại.'
      },
      'invalid-response': {
        title: 'Phản hồi cấp quyền không hợp lệ',
        body: 'Hãy quay lại Atum và bắt đầu kết nối lại.'
      }
    }
  }
} as const

export type MainStrings = (typeof MAIN_STRINGS)[MainLocale]

export function normalizeMainLocale(value: unknown): MainLocale {
  const locale = String(value ?? '').trim().toLowerCase().replace('_', '-')

  return locale === 'vi' || locale.startsWith('vi-') ? 'vi' : 'en'
}

export function readDisplayLanguage(configPath: string): string | null {
  try {
    const lines = fs.readFileSync(configPath, 'utf8').split(/\r?\n/)
    const displayLine = lines.findIndex(line => /^display\s*:\s*(?:#.*)?$/.test(line))

    if (displayLine < 0) {return null}
    const indent = lines[displayLine].match(/^\s*/)?.[0].length ?? 0

    for (const line of lines.slice(displayLine + 1)) {
      if (!line.trim() || /^\s*#/.test(line)) {continue}
      const lineIndent = line.match(/^\s*/)?.[0].length ?? 0

      if (lineIndent <= indent) {break}
      const match = line.match(/^\s+language\s*:\s*['"]?([^\s#'"]+)/)

      if (match) {return match[1]}
    }
  } catch {
    // A missing or malformed config uses Atum's Vietnamese-first default.
  }

  return null
}

export function resolveMainLocale(hermesHome: string, profile?: string | null): MainLocale {
  let selectedProfile = profile

  if (!selectedProfile) {
    try {
      selectedProfile = fs.readFileSync(path.join(hermesHome, 'active_profile'), 'utf8').trim()
    } catch {
      selectedProfile = null
    }
  }

  const selected =
    selectedProfile && selectedProfile !== 'default'
      ? path.join(hermesHome, 'profiles', selectedProfile)
      : hermesHome

  return normalizeMainLocale(readDisplayLanguage(path.join(selected, 'config.yaml')) ?? 'vi')
}
