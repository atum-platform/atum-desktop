import { DEFAULT_DESKTOP_LOCALE, type DesktopLocale } from '../../shared/desktop-locale'

/**
 * The words of the macOS menu bar (app-menu.ts). The app is "Atum" in
 * every language; the rest is Electron's default menu, with Atum's own
 * Check for Updates… and Help items.
 */
export interface MatrixAppMenuCopy {
  app: string
  about: string
  /** Shown only where this copy can update itself. */
  checkForUpdates: string
  services: string
  hide: string
  hideOthers: string
  unhide: string
  quit: string
  file: string
  close: string
  edit: string
  undo: string
  redo: string
  cut: string
  copy: string
  paste: string
  pasteAndMatchStyle: string
  delete: string
  selectAll: string
  substitutions: string
  showSubstitutions: string
  smartQuotes: string
  smartDashes: string
  textReplacement: string
  speech: string
  startSpeaking: string
  stopSpeaking: string
  view: string
  reload: string
  forceReload: string
  toggleDevTools: string
  toggleFullScreen: string
  window: string
  minimize: string
  zoom: string
  front: string
  help: string
  /** Help's one item: Atum's public home. */
  website: string
}

export const MATRIX_APP_MENU_COPY: Record<DesktopLocale, MatrixAppMenuCopy> = {
  en: {
    app: 'Atum',
    about: 'About Atum',
    checkForUpdates: 'Check for Updates…',
    services: 'Services',
    hide: 'Hide Atum',
    hideOthers: 'Hide Others',
    unhide: 'Show All',
    quit: 'Quit Atum',
    file: 'File',
    close: 'Close Window',
    edit: 'Edit',
    undo: 'Undo',
    redo: 'Redo',
    cut: 'Cut',
    copy: 'Copy',
    paste: 'Paste',
    pasteAndMatchStyle: 'Paste and Match Style',
    delete: 'Delete',
    selectAll: 'Select All',
    substitutions: 'Substitutions',
    showSubstitutions: 'Show Substitutions',
    smartQuotes: 'Smart Quotes',
    smartDashes: 'Smart Dashes',
    textReplacement: 'Text Replacement',
    speech: 'Speech',
    startSpeaking: 'Start Speaking',
    stopSpeaking: 'Stop Speaking',
    view: 'View',
    reload: 'Reload',
    forceReload: 'Force Reload',
    toggleDevTools: 'Toggle Developer Tools',
    toggleFullScreen: 'Toggle Full Screen',
    window: 'Window',
    minimize: 'Minimize',
    zoom: 'Zoom',
    front: 'Bring All to Front',
    help: 'Help',
    website: 'Atum Website'
  },
  vi: {
    app: 'Atum',
    about: 'Giới thiệu về Atum',
    checkForUpdates: 'Kiểm tra bản cập nhật…',
    services: 'Dịch vụ',
    hide: 'Ẩn Atum',
    hideOthers: 'Ẩn ứng dụng khác',
    unhide: 'Hiện tất cả',
    quit: 'Thoát Atum',
    file: 'Tệp',
    close: 'Đóng cửa sổ',
    edit: 'Chỉnh sửa',
    undo: 'Hoàn tác',
    redo: 'Làm lại',
    cut: 'Cắt',
    copy: 'Sao chép',
    paste: 'Dán',
    pasteAndMatchStyle: 'Dán và khớp kiểu',
    delete: 'Xóa',
    selectAll: 'Chọn tất cả',
    substitutions: 'Thay thế',
    showSubstitutions: 'Hiện bảng thay thế',
    smartQuotes: 'Dấu ngoặc kép thông minh',
    smartDashes: 'Gạch ngang thông minh',
    textReplacement: 'Thay thế văn bản',
    speech: 'Đọc to',
    startSpeaking: 'Bắt đầu đọc',
    stopSpeaking: 'Dừng đọc',
    view: 'Hiển thị',
    reload: 'Tải lại',
    forceReload: 'Buộc tải lại',
    toggleDevTools: 'Công cụ dành cho nhà phát triển',
    toggleFullScreen: 'Bật/tắt toàn màn hình',
    window: 'Cửa sổ',
    minimize: 'Thu nhỏ cửa sổ',
    zoom: 'Thu phóng',
    front: 'Đưa tất cả ra trước',
    help: 'Trợ giúp',
    website: 'Trang web Atum'
  },
  ja: {
    app: 'Atum',
    about: 'Atumについて',
    checkForUpdates: 'アップデートを確認…',
    services: 'サービス',
    hide: 'Atumを非表示',
    hideOthers: 'ほかを非表示',
    unhide: 'すべてを表示',
    quit: 'Atumを終了',
    file: 'ファイル',
    close: 'ウインドウを閉じる',
    edit: '編集',
    undo: '元に戻す',
    redo: 'やり直し',
    cut: 'カット',
    copy: 'コピー',
    paste: 'ペースト',
    pasteAndMatchStyle: 'ペーストしてスタイルを合わせる',
    delete: '削除',
    selectAll: 'すべてを選択',
    substitutions: '自動置換',
    showSubstitutions: '置換を表示',
    smartQuotes: 'スマート引用符',
    smartDashes: 'スマートダッシュ',
    textReplacement: 'テキストの置換',
    speech: 'スピーチ',
    startSpeaking: '読み上げを開始',
    stopSpeaking: '読み上げを停止',
    view: '表示',
    reload: '再読み込み',
    forceReload: '強制再読み込み',
    toggleDevTools: 'デベロッパーツール',
    toggleFullScreen: 'フルスクリーンの切り替え',
    window: 'ウインドウ',
    minimize: '最小化',
    zoom: '拡大/縮小',
    front: 'すべてを手前に移動',
    help: 'ヘルプ',
    website: 'Atumのウェブサイト'
  },
  zh: {
    app: 'Atum',
    about: '关于 Atum',
    checkForUpdates: '检查更新…',
    services: '服务',
    hide: '隐藏 Atum',
    hideOthers: '隐藏其他',
    unhide: '全部显示',
    quit: '退出 Atum',
    file: '文件',
    close: '关闭窗口',
    edit: '编辑',
    undo: '撤销',
    redo: '重做',
    cut: '剪切',
    copy: '复制',
    paste: '粘贴',
    pasteAndMatchStyle: '粘贴并匹配样式',
    delete: '删除',
    selectAll: '全选',
    substitutions: '替换',
    showSubstitutions: '显示替换',
    smartQuotes: '智能引号',
    smartDashes: '智能破折号',
    textReplacement: '文本替换',
    speech: '语音',
    startSpeaking: '开始朗读',
    stopSpeaking: '停止朗读',
    view: '显示',
    reload: '重新加载',
    forceReload: '强制重新加载',
    toggleDevTools: '开发者工具',
    toggleFullScreen: '切换全屏',
    window: '窗口',
    minimize: '最小化',
    zoom: '缩放',
    front: '前置全部窗口',
    help: '帮助',
    website: 'Atum 网站'
  },
  'zh-hant': {
    app: 'Atum',
    about: '關於 Atum',
    checkForUpdates: '檢查更新項目…',
    services: '服務',
    hide: '隱藏 Atum',
    hideOthers: '隱藏其他',
    unhide: '顯示全部',
    quit: '結束 Atum',
    file: '檔案',
    close: '關閉視窗',
    edit: '編輯',
    undo: '復原',
    redo: '重做',
    cut: '剪下',
    copy: '複製',
    paste: '貼上',
    pasteAndMatchStyle: '貼上並符合樣式',
    delete: '刪除',
    selectAll: '全選',
    substitutions: '替代',
    showSubstitutions: '顯示替代',
    smartQuotes: '智慧型引號',
    smartDashes: '智慧型破折號',
    textReplacement: '文字替代',
    speech: '語音',
    startSpeaking: '開始朗讀',
    stopSpeaking: '停止朗讀',
    view: '顯示',
    reload: '重新載入',
    forceReload: '強制重新載入',
    toggleDevTools: '開發者工具',
    toggleFullScreen: '切換全螢幕',
    window: '視窗',
    minimize: '最小化',
    zoom: '縮放',
    front: '將所有視窗移至最前',
    help: '輔助說明',
    website: 'Atum 網站'
  }
}

export function matrixAppMenuCopy(locale: DesktopLocale): MatrixAppMenuCopy {
  return MATRIX_APP_MENU_COPY[locale] ?? MATRIX_APP_MENU_COPY[DEFAULT_DESKTOP_LOCALE]
}

/** What "Check for Updates…" answers once the check settles (app-menu.ts). */
export interface MatrixUpdateCheckCopy {
  noNewerRelease: (version: string) => string
  downloading: (version: string) => string
  ready: (version: string) => string
  busy: string
  failed: string
  unavailable: string
  restart: string
  later: string
  ok: string
}

export const MATRIX_UPDATE_CHECK_COPY: Record<DesktopLocale, MatrixUpdateCheckCopy> = {
  en: {
    noNewerRelease: version => `No newer release is available on this update channel. You’re using Atum ${version}.`,
    downloading: version => `Atum ${version} is downloading. You’ll be asked to restart when it’s ready.`,
    ready: version => `Atum ${version} is ready. Restart Atum to finish updating.`,
    busy: 'Atum can restart once the current work finishes. Then use Update in the sidebar.',
    failed: 'Couldn’t check for updates. Check your connection and try again.',
    unavailable: 'This copy of Atum can’t update itself. Download the latest Atum from atumplatform.com.',
    restart: 'Restart',
    later: 'Later',
    ok: 'OK'
  },
  vi: {
    noNewerRelease: version => `Không có phiên bản mới hơn trên kênh cập nhật này. Bạn đang dùng Atum ${version}.`,
    downloading: version => `Đang tải Atum ${version}. Atum sẽ hỏi bạn khởi động lại khi bản cập nhật sẵn sàng.`,
    ready: version => `Atum ${version} đã sẵn sàng. Khởi động lại Atum để hoàn tất cập nhật.`,
    busy: 'Atum sẽ khởi động lại được khi việc đang làm xong. Khi đó, bấm Cập nhật ở thanh bên.',
    failed: 'Không kiểm tra được bản cập nhật. Hãy kiểm tra kết nối mạng rồi thử lại.',
    unavailable: 'Bản Atum này không tự cập nhật được. Hãy tải Atum mới nhất tại atumplatform.com.',
    restart: 'Khởi động lại',
    later: 'Để sau',
    ok: 'OK'
  },
  ja: {
    noNewerRelease: version =>
      `このアップデートチャンネルに新しいリリースはありません。現在 Atum ${version} を使用しています。`,
    downloading: version => `Atum ${version} をダウンロードしています。準備ができたら再起動をお願いします。`,
    ready: version => `Atum ${version} の準備ができました。Atum を再起動するとアップデートが完了します。`,
    busy: '作業中の処理が終わると再起動できます。そのあとサイドバーの「更新」を押してください。',
    failed: 'アップデートを確認できませんでした。接続を確認して、もう一度お試しください。',
    unavailable: 'この Atum は自動でアップデートできません。atumplatform.com から最新の Atum をダウンロードしてください。',
    restart: '再起動',
    later: 'あとで',
    ok: 'OK'
  },
  zh: {
    noNewerRelease: version => `此更新频道没有更新的版本。你当前使用的是 Atum ${version}。`,
    downloading: version => `正在下载 Atum ${version}。准备就绪后会请你重新启动。`,
    ready: version => `Atum ${version} 已准备就绪。重新启动 Atum 即可完成更新。`,
    busy: '当前工作完成后即可重新启动。届时请点按侧边栏中的“更新”。',
    failed: '无法检查更新。请检查网络连接后重试。',
    unavailable: '此 Atum 无法自动更新。请从 atumplatform.com 下载最新的 Atum。',
    restart: '重新启动',
    later: '稍后',
    ok: '好'
  },
  'zh-hant': {
    noNewerRelease: version => `此更新頻道沒有較新的版本。你目前使用的是 Atum ${version}。`,
    downloading: version => `正在下載 Atum ${version}。準備就緒後會請你重新啟動。`,
    ready: version => `Atum ${version} 已準備就緒。重新啟動 Atum 即可完成更新。`,
    busy: '目前的工作完成後即可重新啟動。屆時請點按側邊欄中的「更新」。',
    failed: '無法檢查更新。請檢查網路連線後再試一次。',
    unavailable: '這個 Atum 無法自動更新。請從 atumplatform.com 下載最新的 Atum。',
    restart: '重新啟動',
    later: '稍後',
    ok: '好'
  }
}

export function matrixUpdateCheckCopy(locale: DesktopLocale): MatrixUpdateCheckCopy {
  return MATRIX_UPDATE_CHECK_COPY[locale] ?? MATRIX_UPDATE_CHECK_COPY[DEFAULT_DESKTOP_LOCALE]
}
