import type { DesktopLocale } from './desktop-locale'

/**
 * The first run's fixed window words. The welcome itself is the assistant's own (owner rule: no canned agent text), and the
 * Connections list keeps its words in src/app/connections/first-run-copy.ts.
 */
export interface MatrixFirstRunCopy {
  gettingReady: string
  folderAccess: {
    denied: string
    openSettings: string
  }
}

const copies: Record<DesktopLocale, MatrixFirstRunCopy> = {
  en: {
    gettingReady: 'Getting Atum ready',
    folderAccess: {
      denied: 'macOS kept those folders closed.',
      openSettings: 'Open System Settings'
    }
  },
  vi: {
    gettingReady: 'Đang chuẩn bị Atum',
    folderAccess: {
      denied: 'macOS chưa cho mở các thư mục đó.',
      openSettings: 'Mở Cài đặt hệ thống'
    }
  },
  ja: {
    gettingReady: 'Atum を準備しています',
    folderAccess: {
      denied: 'macOS でこれらのフォルダが閉じられています。',
      openSettings: 'システム設定を開く'
    }
  },
  zh: {
    gettingReady: '正在准备 Atum',
    folderAccess: {
      denied: 'macOS 尚未开放这些文件夹。',
      openSettings: '打开系统设置'
    }
  },
  'zh-hant': {
    gettingReady: '正在準備 Atum',
    folderAccess: {
      denied: 'macOS 尚未開放這些資料夾。',
      openSettings: '打開系統設定'
    }
  }
}

export function matrixFirstRunCopy(locale: DesktopLocale): MatrixFirstRunCopy {
  return copies[locale]
}
