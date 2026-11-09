import { type Locale, useI18n } from '@/i18n'

/** The side panel's own words: headings, the header toggle, document status, the way back. */
export interface MatrixWorkbenchCopy {
  /** The header control that opens the side panel (the same glyph closes it). */
  showPanel: string
  /** Compact width: the panel covers the chat; this leads back to it. */
  backToChat: string
  backToChatLabel: string
  /** The new tab's first section: Drive, opening a file, reopening the chat's document. */
  tools: string
  /** Opens Atum Drive, the file browser. */
  files: string
  /** The few big apps Atum works in (Word, Excel, PowerPoint); the rest wait behind "More". */
  apps: string
  moreApps: string
  moreAppsLabel: string
  macApps: string
  atumApps: string
  openFile: string
  searchWeb: string
  seeAll: string
  recent: string
  document: string
  appOptions: (app: string) => string
  saves: string
  viewOnly: string
  savedInWord: string
  unsavedInWord: string
  openInWord: string
  about: string
}

const copy: Record<Locale, MatrixWorkbenchCopy> = {
  en: {
    showPanel: 'Show side panel',
    backToChat: 'Chat',
    backToChatLabel: 'Back to the chat',
    tools: 'Tools',
    files: 'Files',
    apps: 'Apps',
    moreApps: 'More',
    moreAppsLabel: 'More apps',
    macApps: 'On this Mac',
    atumApps: 'Your apps in Atum',
    openFile: 'Open a file…',
    searchWeb: 'Search or type a website',
    seeAll: 'Store',
    recent: 'Recent',
    document: 'Document',
    appOptions: app => `Options for ${app}`,
    saves: 'Saves automatically',
    viewOnly: 'View only',
    savedInWord: 'Saved in Word',
    unsavedInWord: 'Unsaved changes in Word',
    openInWord: 'Open in Word',
    about: 'About this document'
  },
  vi: {
    showPanel: 'Mở bảng bên',
    backToChat: 'Trò chuyện',
    backToChatLabel: 'Quay lại trò chuyện',
    tools: 'Công cụ',
    files: 'Tệp',
    apps: 'Ứng dụng',
    moreApps: 'Thêm',
    moreAppsLabel: 'Thêm ứng dụng',
    macApps: 'Trên máy Mac này',
    atumApps: 'Ứng dụng của bạn trong Atum',
    openFile: 'Mở tệp…',
    searchWeb: 'Tìm kiếm hoặc nhập trang web',
    seeAll: 'Cửa hàng',
    recent: 'Gần đây',
    document: 'Tài liệu',
    appOptions: app => `Tùy chọn cho ${app}`,
    saves: 'Tự động lưu',
    viewOnly: 'Chỉ xem',
    savedInWord: 'Đã lưu trong Word',
    unsavedInWord: 'Có thay đổi chưa lưu trong Word',
    openInWord: 'Mở trong Word',
    about: 'Về tài liệu này'
  },
  ja: {
    showPanel: 'サイドパネルを表示',
    backToChat: 'チャット',
    backToChatLabel: 'チャットに戻る',
    tools: 'ツール',
    files: 'ファイル',
    apps: 'アプリ',
    moreApps: 'その他',
    moreAppsLabel: 'その他のアプリ',
    macApps: 'この Mac',
    atumApps: 'Atum に入れたアプリ',
    openFile: 'ファイルを開く…',
    searchWeb: '検索または Web サイトを入力',
    seeAll: 'ストア',
    recent: '最近',
    document: '書類',
    appOptions: app => `${app} のオプション`,
    saves: '自動保存',
    viewOnly: '表示のみ',
    savedInWord: 'Word に保存済み',
    unsavedInWord: 'Word に未保存の変更があります',
    openInWord: 'Word で開く',
    about: 'この文書について'
  },
  zh: {
    showPanel: '显示侧边面板',
    backToChat: '聊天',
    backToChatLabel: '返回聊天',
    tools: '工具',
    files: '文件',
    apps: '应用',
    moreApps: '更多',
    moreAppsLabel: '更多应用',
    macApps: '此 Mac 上',
    atumApps: '你在 Atum 中的应用',
    openFile: '打开文件…',
    searchWeb: '搜索或输入网站',
    seeAll: '商店',
    recent: '最近使用',
    document: '文档',
    appOptions: app => `${app} 的选项`,
    saves: '自动保存',
    viewOnly: '仅查看',
    savedInWord: '已在 Word 中保存',
    unsavedInWord: 'Word 中有未保存的更改',
    openInWord: '在 Word 中打开',
    about: '关于此文档'
  },
  'zh-hant': {
    showPanel: '顯示側邊面板',
    backToChat: '聊天',
    backToChatLabel: '返回聊天',
    tools: '工具',
    files: '檔案',
    apps: '應用程式',
    moreApps: '更多',
    moreAppsLabel: '更多應用程式',
    macApps: '此 Mac 上',
    atumApps: '你在 Atum 中的應用程式',
    openFile: '開啟檔案…',
    searchWeb: '搜尋或輸入網站',
    seeAll: '商店',
    recent: '最近使用',
    document: '文件',
    appOptions: app => `${app} 的選項`,
    saves: '自動儲存',
    viewOnly: '僅檢視',
    savedInWord: '已在 Word 中儲存',
    unsavedInWord: 'Word 中有未儲存的變更',
    openInWord: '在 Word 中開啟',
    about: '關於此文件'
  }
}

export function matrixWorkbenchCopy(locale: Locale): MatrixWorkbenchCopy {
  return copy[locale] ?? copy.en
}

export function useMatrixWorkbenchCopy(): MatrixWorkbenchCopy {
  return matrixWorkbenchCopy(useI18n().locale)
}
