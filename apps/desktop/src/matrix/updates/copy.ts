import type { Locale } from '@/i18n'

import type { AtumUpdateState } from '../../../shared/atum-update-flow'

export interface UpdateCopy {
  available: string
  beta: string
  betaHelp: string
  channelFailed: string
  check: string
  checkFailed: string
  checking: string
  currentVersion: (version: string) => string
  diskSpaceNeeded: (gb: string) => string
  preparing: string
  diskSpace: string
  download: string
  downloadAtum: string
  downloaded: string
  downloading: (progress: number | null) => string
  error: string
  hashMismatch: string
  /** The previous Restart came back on the same version (ShipIt kept the old one). */
  installFailed: string
  later: string
  readyLabel: string
  restartToUpdate: string
  ready: (version: string | null) => string
  versionReady: (version: string) => string
  restart: string
  restartBusy: string
  restartFailed: string
  restarting: string
  retry: string
  notChecked: string
  openSettings: string
  softwareUpdate: string
  transport: string
  stagingStalled: string
  unavailable: string
  noNewerRelease: string
  /** Retained for the mobile export: the phone's update status reads this key. */
  upToDate: string
  updateProblem: string
  whatsNew: string
}

const en: UpdateCopy = {
  available: 'Update available',
  beta: 'Try beta updates',
  betaHelp: 'Get new versions earlier. You can switch back at any time.',
  channelFailed: 'Could not change the update channel. Please try again.',
  check: 'Check for updates',
  checkFailed: 'Could not check for updates. Please try again.',
  checking: 'Checking for updates…',
  currentVersion: version => `Atum ${version}`,
  preparing: 'Preparing update…',
  diskSpaceNeeded: gb => `This update needs ${gb} GB free. Free up space, then try again.`,
  diskSpace: 'Not enough free disk space to download this update. Free up space, then try again.',
  download: 'Downloading update…',
  downloadAtum: 'Download Atum',
  downloaded: 'Update ready',
  downloading: progress => (progress === null ? 'Downloading update…' : `Downloading update… ${Math.floor(progress)}%`),
  error: 'Could not download the update. Please try again.',
  hashMismatch: 'The downloaded update could not be verified.',
  installFailed: 'The update didn’t finish. Please try again.',
  later: 'Later',
  readyLabel: 'Update ready — restart to install',
  restartToUpdate: 'Restart to update',
  ready: version => (version ? `Atum ${version} is ready. Restart now?` : 'Update ready. Restart now?'),
  versionReady: version => `Atum ${version} is ready`,
  restart: 'Restart',
  restartBusy: 'Finish current work to restart.',
  restartFailed: 'The update could not restart Atum. Please try again.',
  restarting: 'Restarting Atum…',
  retry: 'Try again',
  notChecked: 'Not checked yet',
  openSettings: 'Open Settings',
  softwareUpdate: 'Software update',
  transport: 'Could not reach the update server.',
  stagingStalled: 'Update stalled. Download Atum to continue.',
  unavailable: 'Updates are unavailable for this build.',
  noNewerRelease: 'No newer release',
  upToDate: 'Up to date',
  updateProblem: 'Update needs attention',
  whatsNew: "What's new"
}

const copy: Record<Locale, UpdateCopy> = {
  en,
  vi: {
    available: 'Đã có bản cập nhật',
    beta: 'Dùng bản cập nhật beta',
    betaHelp: 'Nhận phiên bản mới sớm hơn. Bạn có thể chuyển lại bất cứ lúc nào.',
    channelFailed: 'Chưa đổi được kênh cập nhật. Hãy thử lại.',
    check: 'Kiểm tra bản cập nhật',
    checkFailed: 'Chưa kiểm tra được bản cập nhật. Hãy thử lại.',
    checking: 'Đang kiểm tra bản cập nhật…',
    currentVersion: version => `Atum ${version}`,
    preparing: 'Đang chuẩn bị bản cập nhật…',
    diskSpaceNeeded: gb => `Bản cập nhật này cần ${gb} GB trống. Hãy giải phóng dung lượng rồi thử lại.`,
    diskSpace: 'Không đủ dung lượng trống để tải bản cập nhật này. Hãy giải phóng dung lượng rồi thử lại.',
    download: 'Đang tải bản cập nhật…',
    downloadAtum: 'Tải Atum',
    downloaded: 'Đã sẵn sàng cập nhật',
    downloading: progress =>
      progress === null ? 'Đang tải bản cập nhật…' : `Đang tải bản cập nhật… ${Math.floor(progress)}%`,
    error: 'Chưa tải được bản cập nhật. Hãy thử lại.',
    hashMismatch: 'Không thể xác minh bản cập nhật đã tải xuống.',
    installFailed: 'Bản cập nhật chưa hoàn tất. Hãy thử lại.',
    later: 'Để sau',
    readyLabel: 'Bản cập nhật đã sẵn sàng — khởi động lại để cài',
    restartToUpdate: 'Khởi động lại để cập nhật',
    ready: version =>
      version ? `Atum ${version} đã sẵn sàng. Khởi động lại ngay?` : 'Bản cập nhật đã sẵn sàng. Khởi động lại ngay?',
    versionReady: version => `Atum ${version} đã sẵn sàng`,
    restart: 'Khởi động lại',
    restartBusy: 'Hoàn tất công việc hiện tại để khởi động lại.',
    restartFailed: 'Không thể khởi động lại Atum để cập nhật. Hãy thử lại.',
    restarting: 'Đang khởi động lại Atum…',
    retry: 'Thử lại',
    notChecked: 'Chưa kiểm tra',
    openSettings: 'Mở Cài đặt',
    softwareUpdate: 'Cập nhật phần mềm',
    transport: 'Chưa kết nối được với máy chủ cập nhật.',
    stagingStalled: 'Bản cập nhật bị gián đoạn. Hãy tải Atum để tiếp tục.',
    unavailable: 'Bản dựng này không hỗ trợ cập nhật.',
    noNewerRelease: 'Không có phiên bản mới hơn',
    upToDate: 'Đã là bản mới nhất',
    updateProblem: 'Bản cập nhật cần bạn xử lý',
    whatsNew: 'Có gì mới'
  },
  ja: {
    available: 'アップデートがあります',
    beta: 'ベータ版アップデートを試す',
    betaHelp: '新しいバージョンを早く入手できます。いつでも戻せます。',
    channelFailed: 'アップデート チャンネルを変更できませんでした。もう一度お試しください。',
    check: 'アップデートを確認',
    checkFailed: 'アップデートを確認できませんでした。もう一度お試しください。',
    checking: 'アップデートを確認中…',
    currentVersion: version => `Atum ${version}`,
    preparing: 'アップデートを準備中…',
    diskSpaceNeeded: gb => `この更新には ${gb} GB の空き容量が必要です。空き容量を増やして再試行してください。`,
    diskSpace:
      'このアップデートをダウンロードする空き容量が足りません。空き容量を確保してから、もう一度お試しください。',
    download: 'アップデートをダウンロード中…',
    downloadAtum: 'Atum をダウンロード',
    downloaded: 'アップデートの準備ができました',
    downloading: progress =>
      progress === null ? 'アップデートをダウンロード中…' : `アップデートをダウンロード中… ${Math.floor(progress)}%`,
    error: 'アップデートをダウンロードできませんでした。もう一度お試しください。',
    hashMismatch: 'ダウンロードしたアップデートを検証できませんでした。',
    installFailed: 'アップデートを完了できませんでした。もう一度お試しください。',
    later: '後で',
    readyLabel: 'アップデートの準備ができました — 再起動してインストール',
    restartToUpdate: '再起動してアップデート',
    ready: version =>
      version
        ? `Atum ${version} の準備ができました。今すぐ再起動しますか？`
        : 'アップデートの準備ができました。今すぐ再起動しますか？',
    versionReady: version => `Atum ${version} の準備ができました`,
    restart: '再起動',
    restartBusy: '再起動する前に現在の作業を完了してください。',
    restartFailed: 'アップデートのため Atum を再起動できませんでした。もう一度お試しください。',
    restarting: 'Atum を再起動中…',
    retry: 'もう一度試す',
    notChecked: 'まだ確認していません',
    openSettings: '設定を開く',
    softwareUpdate: 'ソフトウェア・アップデート',
    transport: 'アップデートサーバーに接続できませんでした。',
    stagingStalled: 'アップデートが停止しました。Atum をダウンロードして続けてください。',
    unavailable: 'このビルドではアップデートを利用できません。',
    noNewerRelease: '新しいリリースはありません',
    upToDate: '最新です',
    updateProblem: 'アップデートの対応が必要です',
    whatsNew: '新着情報'
  },
  zh: {
    available: '有可用更新',
    beta: '试用 Beta 更新',
    betaHelp: '更早获取新版本，随时可以切回。',
    channelFailed: '无法更改更新频道。请重试。',
    check: '检查更新',
    checkFailed: '无法检查更新。请重试。',
    checking: '正在检查更新…',
    currentVersion: version => `Atum ${version}`,
    preparing: '正在准备更新…',
    diskSpaceNeeded: gb => `此更新需要 ${gb} GB 可用空间。请释放空间后重试。`,
    diskSpace: '没有足够的磁盘空间下载此更新。请释放空间后重试。',
    download: '正在下载更新…',
    downloadAtum: '下载 Atum',
    downloaded: '更新已准备好',
    downloading: progress => (progress === null ? '正在下载更新…' : `正在下载更新… ${Math.floor(progress)}%`),
    error: '无法下载更新。请重试。',
    hashMismatch: '无法验证已下载的更新。',
    installFailed: '更新未完成。请重试。',
    later: '稍后',
    readyLabel: '更新已就绪 — 重启即可安装',
    restartToUpdate: '重启以更新',
    ready: version => (version ? `Atum ${version} 已准备好。现在重启吗？` : '更新已准备好。现在重启吗？'),
    versionReady: version => `Atum ${version} 已准备好`,
    restart: '重启',
    restartBusy: '请先完成当前工作，再重启。',
    restartFailed: '无法重启 Atum 以完成更新。请重试。',
    restarting: '正在重启 Atum…',
    retry: '重试',
    notChecked: '尚未检查',
    openSettings: '打开设置',
    softwareUpdate: '软件更新',
    transport: '无法连接更新服务器。',
    stagingStalled: '更新已停止。请下载 Atum 以继续。',
    unavailable: '此构建无法更新。',
    noNewerRelease: '没有更新的版本',
    upToDate: '已是最新版本',
    updateProblem: '更新需要处理',
    whatsNew: '新内容'
  },
  'zh-hant': {
    available: '有可用更新',
    beta: '試用 Beta 更新',
    betaHelp: '更早取得新版本，隨時可以切回。',
    channelFailed: '無法變更更新頻道。請再試一次。',
    check: '檢查更新',
    checkFailed: '無法檢查更新。請再試一次。',
    checking: '正在檢查更新…',
    currentVersion: version => `Atum ${version}`,
    preparing: '正在準備更新…',
    diskSpaceNeeded: gb => `此更新需要 ${gb} GB 可用空間。請釋放空間後再試一次。`,
    diskSpace: '沒有足夠的磁碟空間下載此更新。請釋放空間後再試一次。',
    download: '正在下載更新…',
    downloadAtum: '下載 Atum',
    downloaded: '更新已準備好',
    downloading: progress => (progress === null ? '正在下載更新…' : `正在下載更新… ${Math.floor(progress)}%`),
    error: '無法下載更新。請再試一次。',
    hashMismatch: '無法驗證已下載的更新。',
    installFailed: '更新未完成。請再試一次。',
    later: '稍後',
    readyLabel: '更新已就緒 — 重新啟動即可安裝',
    restartToUpdate: '重新啟動以更新',
    ready: version => (version ? `Atum ${version} 已準備好。現在重新啟動嗎？` : '更新已準備好。現在重新啟動嗎？'),
    versionReady: version => `Atum ${version} 已準備好`,
    restart: '重新啟動',
    restartBusy: '請先完成目前工作，再重新啟動。',
    restartFailed: '無法重新啟動 Atum 以完成更新。請再試一次。',
    restarting: '正在重新啟動 Atum…',
    retry: '再試一次',
    notChecked: '尚未檢查',
    openSettings: '開啟設定',
    softwareUpdate: '軟體更新',
    transport: '無法連線更新伺服器。',
    stagingStalled: '更新已停止。請下載 Atum 以繼續。',
    unavailable: '此組建無法更新。',
    noNewerRelease: '沒有較新的版本',
    upToDate: '已是最新版本',
    updateProblem: '更新需要處理',
    whatsNew: '新內容'
  }
}

export function updateCopy(locale: Locale): UpdateCopy {
  return copy[locale]
}

export function updateStateLabel(
  state: AtumUpdateState,
  text: UpdateCopy,
  progress: number | null,
  checkedAt: number | null
): string {
  return {
    unavailable: text.unavailable,
    idle: checkedAt === null ? text.notChecked : text.upToDate,
    checking: text.checking,
    downloading: text.downloading(progress),
    preparing: text.preparing,
    downloaded: text.downloaded,
    restarting: text.restarting,
    error: text.error
  }[state]
}
