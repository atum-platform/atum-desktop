import { type Locale, useI18n } from '@/i18n'

export interface MatrixAppCopy {
  title: string
  discover: string
  addShortcut: string
  hideShortcut: string
  show: string
  menu: string
  connect: string
  disconnect: string
  confirm: string
  confirmConnection: string
  cancel: string
  retry: string
  browserWaiting: string
  loading: string
  openingChat: string
  stale: string
  unavailable: string
  historyUnavailable: string
  catalogUnavailable: string
  refresh: string
  connectionPending: string
  connectionReady: string
  disconnected: string
  disconnectCleanupPending: string
  disconnectCleanupUnconfirmed: string
  savePending: string
  saveUnconfirmed: string
  readonly: string
  close: string
  returnToHost: string
  help: string
  verified: string
  /** A group's members panel: the button that brings an app into the group. */
  addToGroup(name: string): string
  groupSetupNeeded: string
  groupUnavailable: string
  groupAddFailed: string
}

export const matrixAppCopy: Record<Locale, MatrixAppCopy> = {
  en: {
    title: 'Apps',
    discover: 'Browse apps in the Store',
    addShortcut: 'Add to sidebar',
    hideShortcut: 'Remove from sidebar',
    show: 'Open',
    menu: 'Open',
    connect: 'Connect',
    disconnect: 'Disconnect',
    confirm: 'Confirm',
    confirmConnection: 'Connect this account?',
    cancel: 'Cancel',
    retry: 'Retry',
    browserWaiting: 'Continue in your browser, then return here.',
    loading: 'Loading apps…',
    openingChat: 'Opening chat…',
    stale: 'Showing saved app details.',
    unavailable: 'This app is unavailable.',
    historyUnavailable: 'Earlier messages from this app could not be loaded. You can still chat here.',
    catalogUnavailable: 'Apps are unavailable right now.',
    refresh: 'Refresh apps',
    connectionPending: 'Connection pending',
    connectionReady: 'Connected',
    disconnected: 'Disconnected',
    disconnectCleanupPending: 'Disconnecting; cleanup is still pending.',
    disconnectCleanupUnconfirmed: 'The app is disconnected, but this Mac still has local app data. Retry cleanup.',
    savePending: 'Saving shortcut preference…',
    saveUnconfirmed: 'The shortcut was sent, but this Mac is still refreshing it.',
    readonly: 'Shortcut preferences are read-only right now.',
    close: 'Close',
    returnToHost: 'Return to Atum',
    help: 'Apps stay separate from your chats and files.',
    verified: 'Verified',
    addToGroup: name => `Add ${name}`,
    groupSetupNeeded: 'Finish setup to add this app.',
    groupUnavailable: 'This app can’t join groups.',
    groupAddFailed: 'Couldn’t add this app. Try again.'
  },
  vi: {
    title: 'Ứng dụng',
    discover: 'Xem ứng dụng trong Cửa hàng',
    addShortcut: 'Thêm vào thanh bên',
    hideShortcut: 'Gỡ khỏi thanh bên',
    show: 'Mở',
    menu: 'Mở',
    connect: 'Kết nối',
    disconnect: 'Ngắt kết nối',
    confirm: 'Xác nhận',
    confirmConnection: 'Kết nối tài khoản này?',
    cancel: 'Hủy',
    retry: 'Thử lại',
    browserWaiting: 'Tiếp tục trong trình duyệt, rồi quay lại đây.',
    loading: 'Đang tải ứng dụng…',
    openingChat: 'Đang mở cuộc trò chuyện…',
    stale: 'Đang hiển thị thông tin ứng dụng đã lưu.',
    unavailable: 'Ứng dụng này hiện không khả dụng.',
    historyUnavailable: 'Chưa tải được tin nhắn trước đây từ ứng dụng. Bạn vẫn có thể trò chuyện tại đây.',
    catalogUnavailable: 'Ứng dụng hiện không khả dụng.',
    refresh: 'Làm mới ứng dụng',
    connectionPending: 'Đang chờ kết nối',
    connectionReady: 'Đã kết nối',
    disconnected: 'Đã ngắt kết nối',
    disconnectCleanupPending: 'Đang ngắt kết nối; việc dọn dẹp vẫn đang chờ.',
    disconnectCleanupUnconfirmed:
      'Ứng dụng đã ngắt kết nối nhưng máy Mac này vẫn còn dữ liệu cục bộ của ứng dụng. Hãy thử dọn dẹp lại.',
    savePending: 'Đang lưu tùy chọn lối tắt…',
    saveUnconfirmed: 'Đã gửi lựa chọn lối tắt nhưng máy Mac này vẫn đang làm mới.',
    readonly: 'Tùy chọn lối tắt hiện chỉ đọc.',
    close: 'Đóng',
    returnToHost: 'Quay lại Atum',
    help: 'Ứng dụng tách biệt với trò chuyện và tệp của bạn.',
    verified: 'Đã xác minh',
    addToGroup: name => `Thêm ${name}`,
    groupSetupNeeded: 'Thiết lập xong ứng dụng này rồi mới thêm được.',
    groupUnavailable: 'Ứng dụng này chưa vào được nhóm.',
    groupAddFailed: 'Chưa thêm được ứng dụng này. Hãy thử lại.'
  },
  ja: {
    title: 'アプリ',
    discover: 'ストアでアプリを探す',
    addShortcut: 'サイドバーに追加',
    hideShortcut: 'サイドバーから削除',
    show: '開く',
    menu: '開く',
    connect: '接続',
    disconnect: '切断',
    confirm: '確認',
    confirmConnection: 'このアカウントを接続しますか？',
    cancel: 'キャンセル',
    retry: '再試行',
    browserWaiting: 'ブラウザで続行してから、ここに戻ってください。',
    loading: 'アプリを読み込み中…',
    openingChat: 'チャットを開いています…',
    stale: '保存済みのアプリ情報を表示しています。',
    unavailable: 'このアプリは利用できません。',
    historyUnavailable: 'このアプリの過去のメッセージを読み込めませんでした。ここでのチャットは引き続き利用できます。',
    catalogUnavailable: 'アプリは現在利用できません。',
    refresh: 'アプリを更新',
    connectionPending: '接続待ち',
    connectionReady: '接続済み',
    disconnected: '切断済み',
    disconnectCleanupPending: '切断中です。クリーンアップはまだ保留です。',
    disconnectCleanupUnconfirmed:
      'アプリとの接続は解除されましたが、この Mac にローカルのアプリデータが残っています。クリーンアップを再試行してください。',
    savePending: 'ショートカット設定を保存中…',
    saveUnconfirmed: 'ショートカット設定は送信済みですが、この Mac ではまだ更新中です。',
    readonly: 'ショートカット設定は現在読み取り専用です。',
    close: '閉じる',
    returnToHost: 'Atum に戻る',
    help: 'アプリはチャットやファイルから分離されています。',
    verified: '確認済み',
    addToGroup: name => `${name} を追加`,
    groupSetupNeeded: '追加するには、このアプリの設定を完了してください。',
    groupUnavailable: 'このアプリはグループに参加できません。',
    groupAddFailed: 'このアプリを追加できませんでした。もう一度お試しください。'
  },
  zh: {
    title: '应用',
    discover: '在商店中浏览应用',
    addShortcut: '添加到侧边栏',
    hideShortcut: '从侧边栏移除',
    show: '打开',
    menu: '打开',
    connect: '连接',
    disconnect: '断开连接',
    confirm: '确认',
    confirmConnection: '要连接此账户吗？',
    cancel: '取消',
    retry: '重试',
    browserWaiting: '请在浏览器中继续，然后返回这里。',
    loading: '正在加载应用…',
    openingChat: '正在打开聊天…',
    stale: '正在显示已保存的应用信息。',
    unavailable: '此应用当前不可用。',
    historyUnavailable: '无法加载此应用的历史消息。您仍可在这里聊天。',
    catalogUnavailable: '应用当前不可用。',
    refresh: '刷新应用',
    connectionPending: '正在等待连接',
    connectionReady: '已连接',
    disconnected: '已断开连接',
    disconnectCleanupPending: '正在断开连接；清理仍在等待。',
    disconnectCleanupUnconfirmed: '应用已断开连接，但此 Mac 上仍有本地应用数据。请重试清理。',
    savePending: '正在保存快捷方式偏好…',
    saveUnconfirmed: '快捷方式设置已发送，但此 Mac 仍在刷新。',
    readonly: '快捷方式偏好当前为只读。',
    close: '关闭',
    returnToHost: '返回 Atum',
    help: '应用与您的聊天和文件保持分离。',
    verified: '已验证',
    addToGroup: name => `添加 ${name}`,
    groupSetupNeeded: '完成设置后才能添加此应用。',
    groupUnavailable: '此应用无法加入群组。',
    groupAddFailed: '无法添加此应用，请重试。'
  },
  'zh-hant': {
    title: '應用程式',
    discover: '在商店中瀏覽應用程式',
    addShortcut: '加入側邊欄',
    hideShortcut: '從側邊欄移除',
    show: '打開',
    menu: '打開',
    connect: '連線',
    disconnect: '中斷連線',
    confirm: '確認',
    confirmConnection: '要連線此帳戶嗎？',
    cancel: '取消',
    retry: '重試',
    browserWaiting: '請在瀏覽器中繼續，然後返回這裡。',
    loading: '正在載入應用程式…',
    openingChat: '正在開啟聊天…',
    stale: '正在顯示已儲存的應用程式資訊。',
    unavailable: '此應用程式目前無法使用。',
    historyUnavailable: '無法載入此應用程式的歷史訊息。您仍可在這裡聊天。',
    catalogUnavailable: '應用程式目前無法使用。',
    refresh: '重新整理應用程式',
    connectionPending: '正在等待連線',
    connectionReady: '已連線',
    disconnected: '已中斷連線',
    disconnectCleanupPending: '正在中斷連線；清理仍在等待。',
    disconnectCleanupUnconfirmed: '應用程式已中斷連線，但此 Mac 上仍有本機應用程式資料。請再試一次清理。',
    savePending: '正在儲存捷徑偏好設定…',
    saveUnconfirmed: '捷徑設定已傳送，但此 Mac 仍在重新整理。',
    readonly: '捷徑偏好設定目前為唯讀。',
    close: '關閉',
    returnToHost: '返回 Atum',
    help: '應用程式與您的聊天和檔案保持分離。',
    verified: '已驗證',
    addToGroup: name => `新增 ${name}`,
    groupSetupNeeded: '完成設定後才能新增此應用程式。',
    groupUnavailable: '此應用程式無法加入群組。',
    groupAddFailed: '無法新增此應用程式，請再試一次。'
  }
}

export function useAppCopy(): MatrixAppCopy {
  return matrixAppCopy[useI18n().locale]
}
