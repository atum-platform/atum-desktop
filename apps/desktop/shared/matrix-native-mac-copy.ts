import type { DesktopLocale } from './desktop-locale'

/**
 * Words for native Hermes reaching this Mac: the one line and action on this Mac's row in
 * Settings › Connections › Your Macs, and the command approval card in a chat. Plain words; the
 * macOS names (Remote Login, its full disk access option) are the ones System Settings shows.
 */
export interface MatrixNativeMacCopy {
  mac: {
    /** Remote Login is off: what turning it on gives. */
    remoteLogin: string
    /** Its button; macOS asks for an administrator password next. */
    allow: string
    /** The password prompt did not turn it on: where to do it by hand. */
    remoteLoginManual: string
    /** Remote Login is on, but remote users cannot read protected folders. */
    fullDisk: string
    openSettings: string
    /** The connection is down or setup did not finish. */
    unreachable: string
    tryAgain: string
  }
  approval: {
    /** Section name for screen readers. */
    label: string
    title: string
    approve: string
    deny: string
    /** The command line's toggle, for screen readers. */
    showAll: string
    /** Over Hermes's own reason, once the command is expanded. */
    why: string
    confirming: string
    approved: string
    denied: string
    /** It expired, or was answered somewhere else. */
    closed: string
    sendFailed: string
    /** This Mac cannot ask for Touch ID or its password. */
    unavailable: string
    /** The system sheet: "Atum is trying to …". */
    sheetReason: (command: string) => string
  }
}

export const matrixNativeMacCopy: Record<DesktopLocale, MatrixNativeMacCopy> = {
  en: {
    mac: {
      remoteLogin: 'Let your assistants use this Mac’s files and Terminal.',
      allow: 'Allow…',
      remoteLoginManual: 'Turn on Remote Login in System Settings.',
      fullDisk: 'Turn on “Allow full disk access for remote users” in Remote Login.',
      openSettings: 'Open Settings',
      unreachable: 'Your assistants can’t reach this Mac right now.',
      tryAgain: 'Try again'
    },
    approval: {
      label: 'Command approval',
      title: 'Run this on your Mac?',
      approve: 'Approve',
      deny: 'Deny',
      showAll: 'Show the whole command',
      why: 'Why it asks',
      confirming: 'Waiting for Touch ID…',
      approved: 'Approved',
      denied: 'Denied',
      closed: 'No longer waiting',
      sendFailed: 'Your answer didn’t send. Try again.',
      unavailable: 'Approve it on your phone.',
      sheetReason: command => `run “${command}” on this Mac for your assistant`
    }
  },
  vi: {
    mac: {
      remoteLogin: 'Cho trợ lý dùng tệp và Terminal trên máy Mac này.',
      allow: 'Cho phép…',
      remoteLoginManual: 'Bật Đăng nhập từ xa trong Cài đặt hệ thống.',
      fullDisk: 'Trong Đăng nhập từ xa, bật “Cho phép người dùng từ xa truy cập toàn bộ ổ đĩa”.',
      openSettings: 'Mở Cài đặt',
      unreachable: 'Trợ lý chưa kết nối được tới máy Mac này.',
      tryAgain: 'Thử lại'
    },
    approval: {
      label: 'Xác nhận lệnh',
      title: 'Chạy lệnh này trên máy Mac của bạn?',
      approve: 'Cho phép',
      deny: 'Từ chối',
      showAll: 'Xem toàn bộ lệnh',
      why: 'Vì sao cần hỏi',
      confirming: 'Đang chờ Touch ID…',
      approved: 'Đã cho phép',
      denied: 'Đã từ chối',
      closed: 'Không còn chờ nữa',
      sendFailed: 'Chưa gửi được câu trả lời. Hãy thử lại.',
      unavailable: 'Hãy cho phép trên điện thoại.',
      sheetReason: command => `chạy “${command}” trên máy Mac này cho trợ lý`
    }
  },
  ja: {
    mac: {
      remoteLogin: 'アシスタントがこの Mac のファイルとターミナルを使えるようにします。',
      allow: '許可…',
      remoteLoginManual: 'システム設定でリモートログインをオンにしてください。',
      fullDisk: 'リモートログインで「リモートユーザにディスクへのフルアクセスを許可」をオンにしてください。',
      openSettings: '設定を開く',
      unreachable: 'アシスタントが今この Mac に接続できません。',
      tryAgain: '再試行'
    },
    approval: {
      label: 'コマンドの確認',
      title: 'この Mac で実行しますか？',
      approve: '許可',
      deny: '拒否',
      showAll: 'コマンド全体を表示',
      why: '確認が必要な理由',
      confirming: 'Touch ID を待っています…',
      approved: '許可しました',
      denied: '拒否しました',
      closed: 'もう待っていません',
      sendFailed: '返答を送信できませんでした。もう一度お試しください。',
      unavailable: 'スマートフォンで許可してください。',
      sheetReason: command => `アシスタントのためにこの Mac で「${command}」を実行`
    }
  },
  zh: {
    mac: {
      remoteLogin: '让你的助理使用这台 Mac 的文件和终端。',
      allow: '允许…',
      remoteLoginManual: '在系统设置中打开“远程登录”。',
      fullDisk: '在“远程登录”中打开“允许远程用户对磁盘进行完全访问”。',
      openSettings: '打开设置',
      unreachable: '你的助理现在连不上这台 Mac。',
      tryAgain: '重试'
    },
    approval: {
      label: '命令确认',
      title: '要在你的 Mac 上运行吗？',
      approve: '批准',
      deny: '拒绝',
      showAll: '显示完整命令',
      why: '为什么要确认',
      confirming: '正在等待 Touch ID…',
      approved: '已批准',
      denied: '已拒绝',
      closed: '已不再等待',
      sendFailed: '回答没有发出去，请重试。',
      unavailable: '请在手机上批准。',
      sheetReason: command => `为你的助理在这台 Mac 上运行“${command}”`
    }
  },
  'zh-hant': {
    mac: {
      remoteLogin: '讓你的助理使用這台 Mac 的檔案和終端機。',
      allow: '允許…',
      remoteLoginManual: '在系統設定中開啟「遠端登入」。',
      fullDisk: '在「遠端登入」中開啟「允許遠端使用者完整取用磁碟」。',
      openSettings: '打開設定',
      unreachable: '你的助理現在連不上這台 Mac。',
      tryAgain: '重試'
    },
    approval: {
      label: '指令確認',
      title: '要在你的 Mac 上執行嗎？',
      approve: '批准',
      deny: '拒絕',
      showAll: '顯示完整指令',
      why: '為什麼要確認',
      confirming: '正在等待 Touch ID…',
      approved: '已批准',
      denied: '已拒絕',
      closed: '已不再等待',
      sendFailed: '回答沒有送出，請重試。',
      unavailable: '請在手機上批准。',
      sheetReason: command => `為你的助理在這台 Mac 上執行「${command}」`
    }
  }
}
