import type { DesktopLocale } from './desktop-locale'
import type { MatrixNativeSshSetupStep } from './matrix-native-mac'

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
    /** The owner disconnected this Mac. */
    notConnected: string
    connect: string
    /** The quiet reset beside Try again. */
    disconnect: string
    /** While an action runs. */
    working: string
    disconnecting: string
    /** Why setup stopped, in plain words; every line ends where the owner can act. */
    failure: {
      /** The saved route no longer matches this Mac or its credential. */
      recovery: string
      /** Some earlier access is still being removed. */
      cleanup: string
      /** Atum could not write this Mac's SSH files. */
      files: string
      /** A file Atum needs is missing. */
      helper: string
      /** The account sent details this Mac cannot use. */
      details: string
      /** An unknown code: the step it stopped at, and the code when there is one. */
      atStep: (step: string, code?: string) => string
      steps: Record<MatrixNativeSshSetupStep, string>
    }
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
      tryAgain: 'Try again',
      notConnected: 'This Mac isn’t connected.',
      connect: 'Connect',
      disconnect: 'Disconnect this Mac',
      working: 'Working…',
      disconnecting: 'Disconnecting…',
      failure: {
        recovery: 'This Mac’s saved connection needs a reset. Disconnect, then Connect.',
        cleanup: 'Access from before is still being removed. Try Disconnect again.',
        files: 'Atum couldn’t write this Mac’s SSH files.',
        helper: 'A file Atum needs is missing. Reinstall Atum.',
        details: 'The account sent details this Mac can’t use.',
        atStep: (step, code) => `Setup stopped while ${step}${code ? ` (${code})` : ''}.`,
        steps: {
          prepare: 'getting this Mac’s route ready',
          authorized_keys: 'reading this Mac’s keys',
          write_keys: 'writing this Mac’s SSH files',
          start_tunnel: 'starting the tunnel',
          enroll: 'registering this Mac'
        }
      }
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
      tryAgain: 'Thử lại',
      notConnected: 'Máy Mac này chưa được kết nối.',
      connect: 'Kết nối',
      disconnect: 'Ngắt kết nối máy Mac này',
      working: 'Đang xử lý…',
      disconnecting: 'Đang ngắt kết nối…',
      failure: {
        recovery: 'Kết nối đã lưu của máy Mac này cần được đặt lại. Hãy ngắt kết nối rồi kết nối lại.',
        cleanup: 'Quyền truy cập từ trước vẫn đang được gỡ. Hãy ngắt kết nối lại.',
        files: 'Atum không ghi được tệp SSH của máy Mac này.',
        helper: 'Thiếu một tệp Atum cần. Hãy cài lại Atum.',
        details: 'Tài khoản đã gửi thông tin máy Mac này không dùng được.',
        atStep: (step, code) => `Quá trình thiết lập dừng khi ${step}${code ? ` (${code})` : ''}.`,
        steps: {
          prepare: 'chuẩn bị tuyến của máy Mac này',
          authorized_keys: 'đọc khóa của máy Mac này',
          write_keys: 'ghi tệp SSH của máy Mac này',
          start_tunnel: 'khởi động đường hầm',
          enroll: 'đăng ký máy Mac này'
        }
      }
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
      tryAgain: '再試行',
      notConnected: 'この Mac はまだ接続されていません。',
      connect: '接続',
      disconnect: 'この Mac の接続を解除',
      working: '処理中…',
      disconnecting: '接続を解除しています…',
      failure: {
        recovery: 'この Mac の保存された接続をリセットする必要があります。接続を解除してから、もう一度接続してください。',
        cleanup: '以前のアクセスをまだ削除しています。もう一度接続を解除してください。',
        files: 'この Mac の SSH ファイルを書き込めませんでした。',
        helper: 'Atum に必要なファイルがありません。Atum を再インストールしてください。',
        details: 'アカウントからこの Mac では使えない情報が届きました。',
        atStep: (step, code) => `セットアップは${step}ところで止まりました${code ? `（${code}）` : ''}。`,
        steps: {
          prepare: 'この Mac の経路を準備する',
          authorized_keys: 'この Mac の鍵を読み取る',
          write_keys: 'この Mac の SSH ファイルを書き込む',
          start_tunnel: 'トンネルを起動する',
          enroll: 'この Mac を登録する'
        }
      }
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
      tryAgain: '重试',
      notConnected: '这台 Mac 尚未连接。',
      connect: '连接',
      disconnect: '断开这台 Mac',
      working: '正在处理…',
      disconnecting: '正在断开…',
      failure: {
        recovery: '这台 Mac 保存的连接需要重置。请先断开，再重新连接。',
        cleanup: '之前的访问权限还在移除中。请再次断开。',
        files: 'Atum 无法写入这台 Mac 的 SSH 文件。',
        helper: '缺少 Atum 需要的文件。请重新安装 Atum。',
        details: '账户发来的信息这台 Mac 无法使用。',
        atStep: (step, code) => `设置在${step}时停止了${code ? `（${code}）` : ''}。`,
        steps: {
          prepare: '准备这台 Mac 的连接',
          authorized_keys: '读取这台 Mac 的密钥',
          write_keys: '写入这台 Mac 的 SSH 文件',
          start_tunnel: '启动隧道',
          enroll: '注册这台 Mac'
        }
      }
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
      tryAgain: '重試',
      notConnected: '這台 Mac 尚未連線。',
      connect: '連線',
      disconnect: '中斷這台 Mac 的連線',
      working: '正在處理…',
      disconnecting: '正在中斷連線…',
      failure: {
        recovery: '這台 Mac 儲存的連線需要重設。請先中斷連線，再重新連線。',
        cleanup: '先前的存取權限還在移除中。請再次中斷連線。',
        files: 'Atum 無法寫入這台 Mac 的 SSH 檔案。',
        helper: '缺少 Atum 需要的檔案。請重新安裝 Atum。',
        details: '帳號傳來的資訊這台 Mac 無法使用。',
        atStep: (step, code) => `設定在${step}時停止了${code ? `（${code}）` : ''}。`,
        steps: {
          prepare: '準備這台 Mac 的連線',
          authorized_keys: '讀取這台 Mac 的金鑰',
          write_keys: '寫入這台 Mac 的 SSH 檔案',
          start_tunnel: '啟動通道',
          enroll: '註冊這台 Mac'
        }
      }
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
