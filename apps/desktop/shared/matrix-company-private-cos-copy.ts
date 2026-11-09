import type { DesktopLocale } from './desktop-locale'

export interface MatrixCompanyPrivateCosCopy {
  preparing: string
  ready: string
  paused: string
  unavailable: string
}

export const matrixCompanyPrivateCosCopy: Record<DesktopLocale, MatrixCompanyPrivateCosCopy> = {
  vi: {
    preparing: 'Đang chuẩn bị',
    ready: 'Sẵn sàng',
    paused: 'Đã tạm dừng',
    unavailable: 'Hiện chưa dùng được'
  },
  en: {
    preparing: 'Preparing',
    ready: 'Ready',
    paused: 'Paused',
    unavailable: 'Unavailable'
  },
  ja: {
    preparing: '準備中',
    ready: '利用可能',
    paused: '一時停止中',
    unavailable: '現在利用できません'
  },
  zh: {
    preparing: '正在准备',
    ready: '可用',
    paused: '已暂停',
    unavailable: '目前不可用'
  },
  'zh-hant': {
    preparing: '正在準備',
    ready: '可用',
    paused: '已暫停',
    unavailable: '目前無法使用'
  }
}

/** A Chief of Staff row's one short line and its one action. Ready says nothing; Open is the action. */
export interface MatrixCompanyPrivateCosRowCopy {
  settingUp: string
  notAvailable: string
  open: string
  retry: string
}

export const matrixCompanyPrivateCosRowCopy: Record<DesktopLocale, MatrixCompanyPrivateCosRowCopy> = {
  vi: { settingUp: 'Đang thiết lập…', notAvailable: 'Chưa sẵn sàng', open: 'Mở', retry: 'Thử lại' },
  en: { settingUp: 'Setting up…', notAvailable: 'Not available yet', open: 'Open', retry: 'Retry' },
  ja: { settingUp: '準備中…', notAvailable: 'まだ利用できません', open: '開く', retry: '再試行' },
  zh: { settingUp: '正在设置…', notAvailable: '暂不可用', open: '打开', retry: '重试' },
  'zh-hant': { settingUp: '正在設定…', notAvailable: '暫不可用', open: '開啟', retry: '重試' }
}
